use crate::{
    AppSettings, DailyTokenBucket, DataPaths, DetailedUsage, DiagnosticItem, LocalThread,
    LocalUsage, MultiRuntimeUsageSnapshot, NamedUsage, ProjectUsage, RuntimeScope, RuntimeStatus,
    RuntimeUsageSnapshot, SNAPSHOT_SCHEMA_VERSION, TokenBreakdown, UsageSnapshot, UsageTrend,
    app_server,
};
use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

const RECENT_THREAD_LIMIT: usize = 40;
const TREND_DAY_COUNT: i64 = 182;
const MAX_PROJECTS: usize = 24;
const ESTIMATE_CONTEXT_MINUTES: i64 = 5;
const TOKENS_PER_MILLION: f64 = 1_000_000.0;

#[derive(Clone, Copy)]
struct ModelPricing {
    input_usd_per_million: f64,
    cached_input_usd_per_million: f64,
    output_usd_per_million: f64,
}

pub fn load_multi_runtime(paths: &DataPaths, settings: &AppSettings) -> MultiRuntimeUsageSnapshot {
    let mut snapshot = UsageSnapshot::empty();
    if let Some(executable) = paths
        .codex_executable_candidates(settings)
        .into_iter()
        .next()
    {
        match app_server::read(&executable) {
            Ok((remote, diagnostics)) => {
                snapshot.account = remote.account;
                snapshot.limit_id = remote.limit_id;
                snapshot.limit_name = remote.limit_name;
                snapshot.primary = remote.primary;
                snapshot.secondary = remote.secondary;
                snapshot.cloud_lifetime_tokens = remote.cloud_lifetime_tokens;
                snapshot.diagnostics.extend(diagnostics);
            }
            Err(_) => snapshot.diagnostics.push(DiagnosticItem::warning(
                "app_server_unavailable",
                "Codex quota is unavailable. Configure a runnable Codex CLI to enable it.",
            )),
        }
    } else {
        snapshot.diagnostics.push(DiagnosticItem::warning(
            "codex_cli_not_found",
            "Codex CLI was not found. Local usage can still be shown when local state exists.",
        ));
    }
    match read_local_usage(paths) {
        Ok((local, diagnostics)) => {
            snapshot.local = Some(local);
            snapshot.diagnostics.extend(diagnostics);
        }
        Err(diagnostic) => snapshot.diagnostics.push(diagnostic),
    }
    let status = if snapshot.primary.is_some() || snapshot.secondary.is_some() {
        RuntimeStatus::Available
    } else if snapshot.local.is_some() {
        RuntimeStatus::LocalOnly
    } else {
        RuntimeStatus::Unavailable
    };
    let refreshed_at = snapshot.refreshed_at;
    MultiRuntimeUsageSnapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        refreshed_at,
        runtimes: vec![RuntimeUsageSnapshot {
            scope: RuntimeScope::Codex,
            display_name: RuntimeScope::Codex.display_name().to_owned(),
            status,
            snapshot,
        }],
    }
}

fn read_local_usage(
    paths: &DataPaths,
) -> Result<(LocalUsage, Vec<DiagnosticItem>), DiagnosticItem> {
    let database = paths.codex_database_path().ok_or_else(|| {
        DiagnosticItem::warning(
            "codex_database_not_found",
            "Codex local state database was not found.",
        )
    })?;
    let connection = Connection::open_with_flags(
        &database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|_| {
        DiagnosticItem::warning(
            "codex_database_unavailable",
            "Codex local state database could not be opened read-only.",
        )
    })?;
    connection
        .busy_timeout(std::time::Duration::from_secs(1))
        .ok();
    let columns = thread_columns(&connection).map_err(|_| {
        DiagnosticItem::warning(
            "codex_schema_unavailable",
            "Codex thread schema could not be inspected.",
        )
    })?;
    if !columns.contains("tokens_used") || !columns.contains("updated_at") {
        return Err(DiagnosticItem::warning(
            "codex_schema_unsupported",
            "Codex local state schema does not contain usage totals.",
        ));
    }

    let day_start = local_day_start();
    let seven_day_start = day_start - Duration::days(6);
    let trend_start = day_start - Duration::days(TREND_DAY_COUNT - 1);
    let totals: (i64, i64, i64, i64, i64) = connection.query_row(
        "SELECT COALESCE(SUM(tokens_used), 0), COALESCE(SUM(CASE WHEN updated_at >= ?1 THEN tokens_used ELSE 0 END), 0), COALESCE(SUM(CASE WHEN updated_at >= ?2 THEN tokens_used ELSE 0 END), 0), COUNT(*), COALESCE(MAX(updated_at), 0) FROM threads",
        [day_start.timestamp(), seven_day_start.timestamp()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).map_err(|_| DiagnosticItem::warning("codex_totals_query_failed", "Codex local usage totals could not be queried."))?;

    let model = column_or_null(&columns, "model");
    let cwd = column_or_null(&columns, "cwd");
    let archived = if columns.contains("archived") {
        "archived"
    } else {
        "0"
    };
    let mut statement = connection.prepare(&format!(
        "SELECT id, title, tokens_used, updated_at, {model} AS model, {cwd} AS cwd, {archived} AS archived FROM threads ORDER BY updated_at DESC LIMIT {RECENT_THREAD_LIMIT}"
    )).map_err(|_| DiagnosticItem::warning("codex_recent_query_failed", "Codex recent threads could not be queried."))?;
    let recent_threads = statement
        .query_map([], |row| {
            let updated_at: i64 = row.get(3)?;
            let id = row
                .get::<_, Option<String>>(0)?
                .unwrap_or_else(|| "unknown".into());
            Ok(LocalThread {
                title: local_thread_title(row.get::<_, Option<String>>(1)?.as_deref(), &id),
                id,
                tokens: row.get(2)?,
                updated_at: timestamp(updated_at),
                model: row.get(4)?,
                cwd: safe_project_name(&row.get::<_, Option<String>>(5)?.unwrap_or_default()),
                archived: row.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|_| {
            DiagnosticItem::warning(
                "codex_recent_query_failed",
                "Codex recent threads could not be queried.",
            )
        })?
        .filter_map(Result::ok)
        .collect();

    let mut diagnostics = Vec::new();
    let session_usage = read_session_usage(
        &connection,
        &columns,
        day_start,
        seven_day_start,
        &mut diagnostics,
    );
    let daily_map = query_daily_tokens(&connection, trend_start)?;
    let trend_days = make_daily_buckets(
        trend_start,
        TREND_DAY_COUNT,
        &daily_map,
        &session_usage.daily_breakdowns,
    );
    let daily_buckets = trend_days
        .iter()
        .rev()
        .take(7)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let usage_trend = Some(build_usage_trend(trend_days));
    let projects = query_projects(&connection, &columns)?;
    Ok((
        LocalUsage {
            lifetime_tokens: totals.0,
            today_tokens: totals.1,
            seven_day_tokens: totals.2,
            thread_count: totals.3,
            last_updated_at: timestamp(totals.4),
            daily_buckets,
            recent_threads,
            detailed_usage: session_usage.detailed_usage,
            usage_trend,
            projects,
            skill_usage: session_usage.skill_usage,
            tool_usage: session_usage.tool_usage,
        },
        diagnostics,
    ))
}

fn query_daily_tokens(
    connection: &Connection,
    start: DateTime<Local>,
) -> Result<HashMap<String, i64>, DiagnosticItem> {
    let mut statement = connection.prepare("SELECT date(updated_at, 'unixepoch', 'localtime'), COALESCE(SUM(tokens_used), 0) FROM threads WHERE updated_at >= ?1 GROUP BY 1")
        .map_err(|_| DiagnosticItem::warning("codex_daily_query_failed", "Codex daily usage could not be queried."))?;
    statement
        .query_map([start.timestamp()], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                row.get(1)?,
            ))
        })
        .map_err(|_| {
            DiagnosticItem::warning(
                "codex_daily_query_failed",
                "Codex daily usage could not be queried.",
            )
        })?
        .filter_map(Result::ok)
        .collect::<HashMap<_, _>>()
        .pipe(Ok)
}

fn make_daily_buckets(
    start: DateTime<Local>,
    count: i64,
    daily_map: &HashMap<String, i64>,
    daily_breakdowns: &HashMap<String, TokenBreakdown>,
) -> Vec<DailyTokenBucket> {
    (0..count)
        .map(|offset| {
            let date = start + Duration::days(offset);
            let id = date.format("%Y-%m-%d").to_string();
            let breakdown = daily_breakdowns.get(&id);
            DailyTokenBucket {
                label: date.format("%-m/%-d").to_string(),
                tokens: *daily_map.get(&id).unwrap_or(&0),
                input_tokens: breakdown.map(|value| value.input_tokens),
                cached_input_tokens: breakdown.map(|value| value.cached_input_tokens),
                output_tokens: breakdown.map(|value| value.output_tokens),
                reasoning_output_tokens: breakdown.map(|value| value.reasoning_output_tokens),
                id,
            }
        })
        .collect()
}

fn build_usage_trend(days: Vec<DailyTokenBucket>) -> UsageTrend {
    let seven_day_tokens = days.iter().rev().take(7).map(|day| day.tokens).sum::<i64>();
    let previous_seven_day_tokens = days
        .iter()
        .rev()
        .skip(7)
        .take(7)
        .map(|day| day.tokens)
        .sum::<i64>();
    let change_percent = if previous_seven_day_tokens > 0 {
        Some(
            ((seven_day_tokens - previous_seven_day_tokens) as f64
                / previous_seven_day_tokens as f64)
                * 100.0,
        )
    } else {
        None
    };
    UsageTrend {
        is_new_activity: previous_seven_day_tokens == 0 && seven_day_tokens > 0,
        days,
        seven_day_tokens,
        previous_seven_day_tokens,
        change_percent,
    }
}

fn query_projects(
    connection: &Connection,
    columns: &HashSet<String>,
) -> Result<Vec<ProjectUsage>, DiagnosticItem> {
    if !columns.contains("cwd") {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(&format!(
        "SELECT COALESCE(NULLIF(cwd, ''), 'Local project'), COALESCE(SUM(tokens_used), 0), COUNT(*), COALESCE(MAX(updated_at), 0) FROM threads GROUP BY 1 ORDER BY 2 DESC LIMIT {MAX_PROJECTS}"
    )).map_err(|_| DiagnosticItem::warning("codex_projects_query_failed", "Codex project usage could not be queried."))?;
    statement
        .query_map([], |row| {
            let updated_at: i64 = row.get(3)?;
            Ok(ProjectUsage {
                name: safe_project_name(&row.get::<_, String>(0)?),
                tokens: row.get(1)?,
                thread_count: row.get(2)?,
                last_active_at: timestamp(updated_at),
            })
        })
        .map_err(|_| {
            DiagnosticItem::warning(
                "codex_projects_query_failed",
                "Codex project usage could not be queried.",
            )
        })?
        .filter_map(Result::ok)
        .collect::<Vec<_>>()
        .pipe(Ok)
}

fn thread_columns(connection: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut statement = connection.prepare("PRAGMA table_info(threads)")?;
    statement
        .query_map([], |row| row.get(1))?
        .filter_map(Result::ok)
        .collect::<HashSet<String>>()
        .pipe(Ok)
}

trait Pipe: Sized {
    fn pipe<T>(self, function: impl FnOnce(Self) -> T) -> T {
        function(self)
    }
}
impl<T> Pipe for T {}

fn column_or_null(columns: &HashSet<String>, name: &str) -> &'static str {
    if columns.contains(name) {
        match name {
            "model" => "model",
            "cwd" => "cwd",
            _ => "NULL",
        }
    } else {
        "NULL"
    }
}

fn local_day_start() -> DateTime<Local> {
    let now = Local::now();
    let naive = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("valid midnight");
    Local.from_local_datetime(&naive).earliest().unwrap_or(now)
}

fn timestamp(seconds: i64) -> Option<DateTime<Utc>> {
    if seconds <= 0 {
        None
    } else {
        DateTime::from_timestamp(seconds, 0)
    }
}

fn fallback_thread_title(id: &str) -> String {
    let suffix = id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("会话 {}", if suffix.is_empty() { "----" } else { &suffix })
}

fn local_thread_title(title: Option<&str>, id: &str) -> String {
    let normalized = title
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        fallback_thread_title(id)
    } else {
        normalized
    }
}

fn safe_project_name(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let parts = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let Some(last) = parts.last().copied() else {
        return "本地项目".into();
    };
    let home_directory = parts.len() >= 2 && parts[parts.len() - 2].eq_ignore_ascii_case("users");
    if home_directory || last.ends_with(':') || last == "Local project" {
        "本地项目".into()
    } else {
        last.chars().take(32).collect()
    }
}

#[derive(Default)]
struct SessionUsage {
    detailed_usage: Option<DetailedUsage>,
    daily_breakdowns: HashMap<String, TokenBreakdown>,
    skill_usage: Vec<NamedUsage>,
    tool_usage: Vec<NamedUsage>,
}

#[derive(Default)]
struct UsageCounter {
    calls: usize,
    estimated_tokens: i64,
}

#[derive(Default)]
struct SessionParseResult {
    deltas: Vec<(DateTime<Utc>, TokenBreakdown, Option<String>)>,
    skills: HashMap<String, UsageCounter>,
    tools: HashMap<String, UsageCounter>,
}

#[derive(Clone)]
struct ToolContext {
    tool_name: String,
    skill_name: Option<String>,
    at: DateTime<Utc>,
}

fn read_session_usage(
    connection: &Connection,
    columns: &HashSet<String>,
    day_start: DateTime<Local>,
    seven_day_start: DateTime<Local>,
    diagnostics: &mut Vec<DiagnosticItem>,
) -> SessionUsage {
    if !columns.contains("rollout_path") {
        return SessionUsage::default();
    }
    let model = column_or_null(columns, "model");
    let mut statement = match connection.prepare(&format!("SELECT DISTINCT rollout_path, {model} AS model FROM threads WHERE rollout_path IS NOT NULL AND rollout_path <> '' AND tokens_used > 0")) { Ok(statement) => statement, Err(_) => return SessionUsage::default() };
    let sources: Vec<(String, Option<String>)> =
        match statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))) {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => return SessionUsage::default(),
        };
    let now = Local::now();
    let month_date = match chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), 1) {
        Some(value) => value,
        None => return SessionUsage::default(),
    };
    let month_start = Local
        .from_local_datetime(&month_date.and_hms_opt(0, 0, 0).expect("valid month start"))
        .earliest()
        .unwrap_or(now)
        .with_timezone(&Utc);
    let mut usage = DetailedUsage::default();
    let mut daily_breakdowns: HashMap<String, TokenBreakdown> = HashMap::new();
    let mut skills = HashMap::new();
    let mut tools = HashMap::new();
    for (path, fallback_model) in sources {
        let Some(parsed) =
            parse_session_file(Path::new(&path), fallback_model.as_deref(), diagnostics)
        else {
            continue;
        };
        usage.parsed_file_count += 1;
        usage.token_event_count += parsed.deltas.len();
        for (at, delta, model) in parsed.deltas {
            daily_breakdowns
                .entry(at.with_timezone(&Local).format("%Y-%m-%d").to_string())
                .or_default()
                .add_assign(&delta);
            let cost_usd = estimate_cost_usd(&delta, model.as_deref());
            usage.lifetime.add_priced_tokens(&delta, cost_usd);
            if at >= month_start {
                usage.month.add_priced_tokens(&delta, cost_usd);
            }
            if at >= seven_day_start.with_timezone(&Utc) {
                usage.seven_day.add_priced_tokens(&delta, cost_usd);
            }
            if at >= day_start.with_timezone(&Utc) {
                usage.today.add_priced_tokens(&delta, cost_usd);
            }
        }
        merge_counters(&mut skills, parsed.skills);
        merge_counters(&mut tools, parsed.tools);
    }
    SessionUsage {
        detailed_usage: (!usage.token_event_count.eq(&0)).then_some(usage),
        daily_breakdowns,
        skill_usage: counters_to_named_usage(skills),
        tool_usage: counters_to_named_usage(tools),
    }
}

fn merge_counters(
    target: &mut HashMap<String, UsageCounter>,
    source: HashMap<String, UsageCounter>,
) {
    for (name, counter) in source {
        let entry = target.entry(name).or_default();
        entry.calls += counter.calls;
        entry.estimated_tokens += counter.estimated_tokens;
    }
}

fn counters_to_named_usage(counters: HashMap<String, UsageCounter>) -> Vec<NamedUsage> {
    let mut items = counters
        .into_iter()
        .map(|(name, counter)| NamedUsage {
            name,
            calls: counter.calls,
            estimated_tokens: (counter.estimated_tokens > 0).then_some(counter.estimated_tokens),
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        right
            .calls
            .cmp(&left.calls)
            .then_with(|| right.estimated_tokens.cmp(&left.estimated_tokens))
    });
    items.truncate(12);
    items
}

fn parse_session_file(
    path: &Path,
    fallback_model: Option<&str>,
    diagnostics: &mut Vec<DiagnosticItem>,
) -> Option<SessionParseResult> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut raw = Vec::new();
    let mut previous = TokenBreakdown::default();
    let mut result = SessionParseResult::default();
    let mut active_context: Option<ToolContext> = None;
    let mut active_model = fallback_model.map(normalize_model_name);
    let mut oversized = false;
    loop {
        raw.clear();
        let size = reader.read_until(b'\n', &mut raw).ok()?;
        if size == 0 {
            break;
        }
        if size > 1_048_576 {
            oversized = true;
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&raw) else {
            continue;
        };
        if let Some(model) = extract_model_update(&value) {
            active_model = Some(model);
        }
        if let Some(context) = extract_tool_context(&value) {
            result
                .tools
                .entry(context.tool_name.clone())
                .or_default()
                .calls += 1;
            if let Some(skill_name) = &context.skill_name {
                result.skills.entry(skill_name.clone()).or_default().calls += 1;
            }
            active_context = Some(context);
        }
        let payload = &value["payload"];
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let Some(at) = event_timestamp(&value) else {
            continue;
        };
        let total = &payload["info"]["total_token_usage"];
        let current = TokenBreakdown {
            input_tokens: value_i64(total.get("input_tokens")),
            cached_input_tokens: value_i64(total.get("cached_input_tokens")),
            output_tokens: value_i64(total.get("output_tokens")),
            reasoning_output_tokens: value_i64(total.get("reasoning_output_tokens")),
            total_tokens: value_i64(total.get("total_tokens")),
        };
        let mut delta = current.delta_from(&previous);
        if delta.has_negative_values() {
            delta = current.clone();
        }
        previous = current;
        if delta.is_zero() {
            continue;
        }
        if let Some(context) = &active_context {
            if at.signed_duration_since(context.at).num_minutes().abs() <= ESTIMATE_CONTEXT_MINUTES
            {
                result
                    .tools
                    .entry(context.tool_name.clone())
                    .or_default()
                    .estimated_tokens += delta.total_tokens;
                if let Some(skill_name) = &context.skill_name {
                    result
                        .skills
                        .entry(skill_name.clone())
                        .or_default()
                        .estimated_tokens += delta.total_tokens;
                }
            }
        }
        result.deltas.push((at, delta, active_model.clone()));
    }
    if oversized {
        diagnostics.push(DiagnosticItem::warning(
            "session_line_skipped",
            "A large session line was skipped while reading local usage.",
        ));
    }
    Some(result)
}

fn extract_model_update(value: &Value) -> Option<String> {
    let payload = value.get("payload")?;
    if value.get("type").and_then(Value::as_str) == Some("turn_context") {
        return field_string(payload, &["model"]).map(|model| normalize_model_name(&model));
    }
    if payload.get("type").and_then(Value::as_str) == Some("thread_settings_applied") {
        return payload
            .get("thread_settings")
            .and_then(|settings| field_string(settings, &["model"]))
            .map(|model| normalize_model_name(&model));
    }
    None
}

fn normalize_model_name(model: &str) -> String {
    model.trim().to_ascii_lowercase()
}

fn model_pricing(model: Option<&str>) -> Option<ModelPricing> {
    let model = model?.trim().to_ascii_lowercase();
    // USD per 1M tokens. Cached input is already included in input_tokens, so it
    // is priced separately below instead of being charged at the full input rate.
    let pricing = if model.starts_with("gpt-5.5-pro") || model.starts_with("gpt-5.4-pro") {
        ModelPricing {
            input_usd_per_million: 30.0,
            cached_input_usd_per_million: 30.0,
            output_usd_per_million: 180.0,
        }
    } else if model == "gpt-5.6" || model.starts_with("gpt-5.6-sol") || model.starts_with("gpt-5.5")
    {
        ModelPricing {
            input_usd_per_million: 5.0,
            cached_input_usd_per_million: 0.5,
            output_usd_per_million: 30.0,
        }
    } else if model.starts_with("gpt-5.6-terra")
        || model == "gpt-5.4"
        || model.starts_with("gpt-5.4-")
            && !model.starts_with("gpt-5.4-mini")
            && !model.starts_with("gpt-5.4-nano")
    {
        ModelPricing {
            input_usd_per_million: 2.5,
            cached_input_usd_per_million: 0.25,
            output_usd_per_million: 15.0,
        }
    } else if model.starts_with("gpt-5.4-mini") {
        ModelPricing {
            input_usd_per_million: 0.75,
            cached_input_usd_per_million: 0.075,
            output_usd_per_million: 4.5,
        }
    } else if model.starts_with("gpt-5.4-nano") {
        ModelPricing {
            input_usd_per_million: 0.2,
            cached_input_usd_per_million: 0.02,
            output_usd_per_million: 1.25,
        }
    } else if model.starts_with("gpt-5.6-luna") {
        ModelPricing {
            input_usd_per_million: 1.0,
            cached_input_usd_per_million: 0.1,
            output_usd_per_million: 6.0,
        }
    } else if model.starts_with("gpt-5.3-codex") || model.starts_with("gpt-5.2") {
        ModelPricing {
            input_usd_per_million: 1.75,
            cached_input_usd_per_million: 0.175,
            output_usd_per_million: 14.0,
        }
    } else if model.starts_with("gpt-5-codex") || model == "gpt-5" || model.starts_with("gpt-5-") {
        ModelPricing {
            input_usd_per_million: 1.25,
            cached_input_usd_per_million: 0.125,
            output_usd_per_million: 10.0,
        }
    } else if model.starts_with("codex-mini") {
        ModelPricing {
            input_usd_per_million: 1.5,
            cached_input_usd_per_million: 0.375,
            output_usd_per_million: 6.0,
        }
    } else {
        return None;
    };
    Some(pricing)
}

fn estimate_cost_usd(tokens: &TokenBreakdown, model: Option<&str>) -> Option<f64> {
    let pricing = model_pricing(model)?;
    let uncached_input = (tokens.input_tokens - tokens.cached_input_tokens).max(0) as f64;
    let cached_input = tokens.cached_input_tokens.max(0) as f64;
    let output = tokens.output_tokens.max(0) as f64;
    Some(
        (uncached_input * pricing.input_usd_per_million
            + cached_input * pricing.cached_input_usd_per_million
            + output * pricing.output_usd_per_million)
            / TOKENS_PER_MILLION,
    )
}

fn extract_tool_context(value: &Value) -> Option<ToolContext> {
    let payload = value.get("payload")?;
    let payload_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let item = payload.get("item");
    let item_type = item
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(payload_type, "tool_call" | "function_call")
        && !matches!(item_type, "tool_call" | "function_call")
    {
        return None;
    }
    let tool_name = [payload, item.unwrap_or(&Value::Null)]
        .into_iter()
        .find_map(|candidate| field_string(candidate, &["tool_name", "name"]))?;
    let skill_name = if tool_name.eq_ignore_ascii_case("skill") {
        [
            payload.get("arguments"),
            item.and_then(|value| value.get("arguments")),
        ]
        .into_iter()
        .flatten()
        .find_map(|arguments| field_string(arguments, &["skill", "skill_name", "name"]))
    } else {
        None
    };
    Some(ToolContext {
        tool_name,
        skill_name,
        at: event_timestamp(value)?,
    })
}

fn field_string(value: &Value, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 80 && !value.contains(['\r', '\n']))
        .map(str::to_owned)
}

fn event_timestamp(value: &Value) -> Option<DateTime<Utc>> {
    value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn value_i64(value: Option<&Value>) -> i64 {
    value
        .and_then(Value::as_i64)
        .or_else(|| {
            value
                .and_then(Value::as_u64)
                .and_then(|value| i64::try_from(value).ok())
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trend_covers_a_full_history_and_calculates_change() {
        let days = (0..14)
            .map(|index| DailyTokenBucket {
                id: index.to_string(),
                label: index.to_string(),
                tokens: if index < 7 { 10 } else { 20 },
                input_tokens: None,
                cached_input_tokens: None,
                output_tokens: None,
                reasoning_output_tokens: None,
            })
            .collect();
        let trend = build_usage_trend(days);
        assert_eq!(trend.previous_seven_day_tokens, 70);
        assert_eq!(trend.seven_day_tokens, 140);
        assert_eq!(trend.change_percent, Some(100.0));
    }

    #[test]
    fn daily_buckets_include_real_session_token_types_when_available() {
        let start = local_day_start();
        let id = start.format("%Y-%m-%d").to_string();
        let totals = HashMap::from([(id.clone(), 190)]);
        let breakdowns = HashMap::from([(
            id,
            TokenBreakdown {
                input_tokens: 100,
                cached_input_tokens: 60,
                output_tokens: 80,
                reasoning_output_tokens: 10,
                total_tokens: 180,
            },
        )]);

        let days = make_daily_buckets(start, 2, &totals, &breakdowns);
        assert_eq!(days[0].tokens, 190);
        assert_eq!(days[0].input_tokens, Some(100));
        assert_eq!(days[0].cached_input_tokens, Some(60));
        assert_eq!(days[0].output_tokens, Some(80));
        assert_eq!(days[0].reasoning_output_tokens, Some(10));
        assert_eq!(days[1].input_tokens, None);
    }

    #[test]
    fn tool_context_collects_only_safe_names() {
        let value = serde_json::json!({
            "timestamp": "2026-01-01T00:00:00Z",
            "payload": { "type": "function_call", "name": "Skill", "arguments": { "skill": "github" } }
        });
        let context = extract_tool_context(&value).expect("tool context");
        assert_eq!(context.tool_name, "Skill");
        assert_eq!(context.skill_name.as_deref(), Some("github"));
    }

    #[test]
    fn cost_uses_the_model_rate_and_does_not_double_charge_cached_input() {
        let tokens = TokenBreakdown {
            input_tokens: 1_000_000,
            cached_input_tokens: 400_000,
            output_tokens: 100_000,
            reasoning_output_tokens: 20_000,
            total_tokens: 1_100_000,
        };
        let cost = estimate_cost_usd(&tokens, Some("gpt-5.6-terra")).expect("known model");
        assert!((cost - 3.1).abs() < f64::EPSILON);
    }

    #[test]
    fn model_updates_are_read_from_session_events() {
        let value = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "thread_settings_applied",
                "thread_settings": { "model": "GPT-5.6-Luna" }
            }
        });
        assert_eq!(
            extract_model_update(&value).as_deref(),
            Some("gpt-5.6-luna")
        );
    }

    #[test]
    fn local_display_fields_keep_thread_titles_and_shorten_paths() {
        assert_eq!(
            safe_project_name("C:\\Users\\name\\work\\private-project"),
            "private-project"
        );
        assert_eq!(safe_project_name("C:\\Users\\name"), "本地项目");
        assert_eq!(
            local_thread_title(Some("  迁移   Windows\n平台  "), "thread-1234"),
            "迁移 Windows 平台"
        );
        assert_eq!(local_thread_title(None, "thread-1234"), "会话 1234");
    }
}
