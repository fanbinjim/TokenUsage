use crate::{app_server, AppSettings, DailyTokenBucket, DataPaths, DetailedUsage, DiagnosticItem, LocalThread, LocalUsage, MultiRuntimeUsageSnapshot, RuntimeScope, RuntimeStatus, RuntimeUsageSnapshot, SNAPSHOT_SCHEMA_VERSION, TokenBreakdown, UsageSnapshot};
use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::{collections::{HashMap, HashSet}, fs::File, io::{BufRead, BufReader}, path::Path};

pub fn load_multi_runtime(paths: &DataPaths, settings: &AppSettings) -> MultiRuntimeUsageSnapshot {
    let mut snapshot = UsageSnapshot::empty();
    if let Some(executable) = paths.codex_executable_candidates(settings).into_iter().next() {
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
            Err(_) => snapshot.diagnostics.push(DiagnosticItem::warning("app_server_unavailable", "Codex quota is unavailable. Configure a runnable Codex CLI to enable it.")),
        }
    } else {
        snapshot.diagnostics.push(DiagnosticItem::warning("codex_cli_not_found", "Codex CLI was not found. Local usage can still be shown when local state exists."));
    }
    match read_local_usage(paths) {
        Ok((local, diagnostics)) => { snapshot.local = Some(local); snapshot.diagnostics.extend(diagnostics); }
        Err(diagnostic) => snapshot.diagnostics.push(diagnostic),
    }
    let status = if snapshot.primary.is_some() || snapshot.secondary.is_some() { RuntimeStatus::Available }
        else if snapshot.local.is_some() { RuntimeStatus::LocalOnly } else { RuntimeStatus::Unavailable };
    let refreshed_at = snapshot.refreshed_at;
    MultiRuntimeUsageSnapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION, refreshed_at,
        runtimes: vec![RuntimeUsageSnapshot { scope: RuntimeScope::Codex, display_name: RuntimeScope::Codex.display_name().to_owned(), status, snapshot }],
    }
}

fn read_local_usage(paths: &DataPaths) -> Result<(LocalUsage, Vec<DiagnosticItem>), DiagnosticItem> {
    let database = paths.codex_database_path().ok_or_else(|| DiagnosticItem::warning("codex_database_not_found", "Codex local state database was not found."))?;
    let connection = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI)
        .map_err(|_| DiagnosticItem::warning("codex_database_unavailable", "Codex local state database could not be opened read-only."))?;
    connection.busy_timeout(std::time::Duration::from_secs(1)).ok();
    let columns = thread_columns(&connection).map_err(|_| DiagnosticItem::warning("codex_schema_unavailable", "Codex thread schema could not be inspected."))?;
    if !columns.contains("tokens_used") || !columns.contains("updated_at") { return Err(DiagnosticItem::warning("codex_schema_unsupported", "Codex local state schema does not contain usage totals.")); }
    let day_start = local_day_start();
    let seven_day_start = day_start - Duration::days(6);
    let totals: (i64, i64, i64, i64, i64) = connection.query_row(
        "SELECT COALESCE(SUM(tokens_used), 0), COALESCE(SUM(CASE WHEN updated_at >= ?1 THEN tokens_used ELSE 0 END), 0), COALESCE(SUM(CASE WHEN updated_at >= ?2 THEN tokens_used ELSE 0 END), 0), COUNT(*), COALESCE(MAX(updated_at), 0) FROM threads",
        [day_start.timestamp(), seven_day_start.timestamp()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).map_err(|_| DiagnosticItem::warning("codex_totals_query_failed", "Codex local usage totals could not be queried."))?;
    let model = column_or_null(&columns, "model");
    let cwd = column_or_null(&columns, "cwd");
    let archived = if columns.contains("archived") { "archived" } else { "0" };
    let mut statement = connection.prepare(&format!("SELECT id, title, tokens_used, updated_at, {model} AS model, {cwd} AS cwd, {archived} AS archived FROM threads ORDER BY updated_at DESC LIMIT 5"))
        .map_err(|_| DiagnosticItem::warning("codex_recent_query_failed", "Recent Codex threads could not be queried."))?;
    let recent_threads = statement.query_map([], |row| {
        let updated_at: i64 = row.get(3)?;
        Ok(LocalThread {
            id: row.get::<_, Option<String>>(0)?.unwrap_or_else(|| "unknown".into()),
            title: row.get::<_, Option<String>>(1)?.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "Untitled".into()),
            tokens: row.get(2)?, updated_at: timestamp(updated_at), model: row.get(4)?, cwd: row.get::<_, Option<String>>(5)?.unwrap_or_default(), archived: row.get::<_, i64>(6)? != 0,
        })
    }).map_err(|_| DiagnosticItem::warning("codex_recent_query_failed", "Recent Codex threads could not be queried."))?
        .filter_map(Result::ok).collect();
    let mut daily_statement = connection.prepare("SELECT date(updated_at, 'unixepoch', 'localtime'), COALESCE(SUM(tokens_used), 0) FROM threads WHERE updated_at >= ?1 GROUP BY 1")
        .map_err(|_| DiagnosticItem::warning("codex_daily_query_failed", "Codex daily usage could not be queried."))?;
    let daily_map: HashMap<String, i64> = daily_statement.query_map([seven_day_start.timestamp()], |row| Ok((row.get::<_, Option<String>>(0)?.unwrap_or_default(), row.get(1)?)))
        .map_err(|_| DiagnosticItem::warning("codex_daily_query_failed", "Codex daily usage could not be queried."))?
        .filter_map(Result::ok).collect();
    let daily_buckets = (0..7).map(|offset| {
        let date = seven_day_start + Duration::days(offset);
        let key = date.format("%Y-%m-%d").to_string();
        DailyTokenBucket { id: key.clone(), label: date.format("%-m/%-d").to_string(), tokens: *daily_map.get(&key).unwrap_or(&0) }
    }).collect();
    let mut diagnostics = Vec::new();
    let detailed_usage = read_detailed_usage(&connection, &columns, day_start, seven_day_start, &mut diagnostics);
    Ok((LocalUsage { lifetime_tokens: totals.0, today_tokens: totals.1, seven_day_tokens: totals.2, thread_count: totals.3, last_updated_at: timestamp(totals.4), daily_buckets, recent_threads, detailed_usage }, diagnostics))
}

fn thread_columns(connection: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut statement = connection.prepare("PRAGMA table_info(threads)")?;
    statement.query_map([], |row| row.get(1))?.filter_map(Result::ok).collect::<HashSet<String>>().pipe(Ok)
}

trait Pipe: Sized { fn pipe<T>(self, function: impl FnOnce(Self) -> T) -> T { function(self) } }
impl<T> Pipe for T {}

fn column_or_null(columns: &HashSet<String>, name: &str) -> &'static str { if columns.contains(name) { match name { "model" => "model", "cwd" => "cwd", _ => "NULL" } } else { "NULL" } }

fn local_day_start() -> DateTime<Local> {
    let now = Local::now();
    let naive = now.date_naive().and_hms_opt(0, 0, 0).expect("valid midnight");
    Local.from_local_datetime(&naive).earliest().unwrap_or(now)
}

fn timestamp(seconds: i64) -> Option<DateTime<Utc>> { if seconds <= 0 { None } else { DateTime::from_timestamp(seconds, 0) } }

fn read_detailed_usage(connection: &Connection, columns: &HashSet<String>, day_start: DateTime<Local>, seven_day_start: DateTime<Local>, diagnostics: &mut Vec<DiagnosticItem>) -> Option<DetailedUsage> {
    if !columns.contains("rollout_path") { return None; }
    let model = column_or_null(columns, "model");
    let mut statement = connection.prepare(&format!("SELECT DISTINCT rollout_path, {model} AS model FROM threads WHERE rollout_path IS NOT NULL AND rollout_path <> '' AND tokens_used > 0")).ok()?;
    let sources: Vec<(String, Option<String>)> = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).ok()?.filter_map(Result::ok).collect();
    if sources.is_empty() { return None; }
    let now = Local::now();
    let month_date = chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), 1)?;
    let month_start = Local.from_local_datetime(&month_date.and_hms_opt(0, 0, 0)?).earliest().unwrap_or(now).with_timezone(&Utc);
    let day_start = day_start.with_timezone(&Utc);
    let seven_day_start = seven_day_start.with_timezone(&Utc);
    let mut usage = DetailedUsage::default();
    for (path, _) in sources {
        let parsed = parse_session_file(Path::new(&path), diagnostics);
        let Some(parsed) = parsed else { continue; };
        usage.parsed_file_count += 1;
        usage.token_event_count += parsed.len();
        for (at, delta) in parsed {
            usage.lifetime.add_tokens(&delta);
            if at >= month_start { usage.month.add_tokens(&delta); }
            if at >= seven_day_start { usage.seven_day.add_tokens(&delta); }
            if at >= day_start { usage.today.add_tokens(&delta); }
        }
    }
    if usage.token_event_count == 0 { None } else { Some(usage) }
}

fn parse_session_file(path: &Path, diagnostics: &mut Vec<DiagnosticItem>) -> Option<Vec<(DateTime<Utc>, TokenBreakdown)>> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut raw = Vec::new();
    let mut previous = TokenBreakdown::default();
    let mut deltas = Vec::new();
    let mut oversized = false;
    loop {
        raw.clear();
        let size = reader.read_until(b'\n', &mut raw).ok()?;
        if size == 0 { break; }
        if size > 1_048_576 { oversized = true; continue; }
        if !raw.windows(b"\"type\":\"token_count\"".len()).any(|part| part == b"\"type\":\"token_count\"") { continue; }
        let Ok(value) = serde_json::from_slice::<Value>(&raw) else { continue; };
        let payload = &value["payload"];
        if payload.get("type").and_then(Value::as_str) != Some("token_count") { continue; }
        let Some(at) = value.get("timestamp").and_then(Value::as_str).and_then(|value| DateTime::parse_from_rfc3339(value).ok()).map(|value| value.with_timezone(&Utc)) else { continue; };
        let total = &payload["info"]["total_token_usage"];
        let current = TokenBreakdown {
            input_tokens: value_i64(total.get("input_tokens")), cached_input_tokens: value_i64(total.get("cached_input_tokens")), output_tokens: value_i64(total.get("output_tokens")), reasoning_output_tokens: value_i64(total.get("reasoning_output_tokens")), total_tokens: value_i64(total.get("total_tokens")),
        };
        let mut delta = current.delta_from(&previous);
        if delta.has_negative_values() { delta = current.clone(); }
        previous = current;
        if !delta.is_zero() { deltas.push((at, delta)); }
    }
    if oversized { diagnostics.push(DiagnosticItem::warning("session_line_skipped", "A large session line was skipped while reading local usage.")); }
    Some(deltas)
}

fn value_i64(value: Option<&Value>) -> i64 { value.and_then(Value::as_i64).or_else(|| value.and_then(Value::as_u64).and_then(|value| i64::try_from(value).ok())).unwrap_or(0) }
