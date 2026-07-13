use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticItem {
    pub code: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
}

impl DiagnosticItem {
    pub fn info(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            severity: DiagnosticSeverity::Info,
            message: message.into(),
        }
    }

    pub fn warning(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            severity: DiagnosticSeverity::Warning,
            message: message.into(),
        }
    }

    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            severity: DiagnosticSeverity::Error,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RateWindow {
    pub used_percent: f64,
    pub window_duration_mins: Option<i64>,
    pub resets_at: Option<DateTime<Utc>>,
    pub remaining_percent: f64,
}

impl RateWindow {
    pub fn new(
        used_percent: f64,
        window_duration_mins: Option<i64>,
        resets_at: Option<DateTime<Utc>>,
    ) -> Self {
        let normalized = used_percent.clamp(0.0, 100.0);
        Self {
            used_percent: normalized,
            window_duration_mins,
            resets_at,
            remaining_percent: 100.0 - normalized,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub r#type: String,
    pub plan_type: Option<String>,
    pub email_present: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenBreakdown {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
}

impl TokenBreakdown {
    pub fn add_assign(&mut self, value: &Self) {
        self.input_tokens += value.input_tokens;
        self.cached_input_tokens += value.cached_input_tokens;
        self.output_tokens += value.output_tokens;
        self.reasoning_output_tokens += value.reasoning_output_tokens;
        self.total_tokens += value.total_tokens;
    }

    pub fn delta_from(&self, previous: &Self) -> Self {
        Self {
            input_tokens: self.input_tokens - previous.input_tokens,
            cached_input_tokens: self.cached_input_tokens - previous.cached_input_tokens,
            output_tokens: self.output_tokens - previous.output_tokens,
            reasoning_output_tokens: self.reasoning_output_tokens
                - previous.reasoning_output_tokens,
            total_tokens: self.total_tokens - previous.total_tokens,
        }
    }

    pub fn has_negative_values(&self) -> bool {
        self.input_tokens < 0
            || self.cached_input_tokens < 0
            || self.output_tokens < 0
            || self.reasoning_output_tokens < 0
            || self.total_tokens < 0
    }

    pub fn is_zero(&self) -> bool {
        self.input_tokens == 0
            && self.cached_input_tokens == 0
            && self.output_tokens == 0
            && self.reasoning_output_tokens == 0
            && self.total_tokens == 0
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PricedTokenUsage {
    pub tokens: TokenBreakdown,
    pub estimated_cost_usd: Option<f64>,
}

impl PricedTokenUsage {
    pub fn add_tokens(&mut self, value: &TokenBreakdown) {
        self.tokens.add_assign(value);
    }

    pub fn add_priced_tokens(&mut self, value: &TokenBreakdown, cost_usd: Option<f64>) {
        self.tokens.add_assign(value);
        if let Some(cost) = cost_usd {
            self.estimated_cost_usd = Some(self.estimated_cost_usd.unwrap_or(0.0) + cost);
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetailedUsage {
    pub today: PricedTokenUsage,
    pub seven_day: PricedTokenUsage,
    pub month: PricedTokenUsage,
    pub lifetime: PricedTokenUsage,
    pub parsed_file_count: usize,
    pub token_event_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DailyTokenBucket {
    pub id: String,
    pub label: String,
    pub tokens: i64,
    pub input_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub reasoning_output_tokens: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrend {
    pub days: Vec<DailyTokenBucket>,
    pub seven_day_tokens: i64,
    pub previous_seven_day_tokens: i64,
    pub change_percent: Option<f64>,
    pub is_new_activity: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    pub name: String,
    pub tokens: i64,
    pub thread_count: i64,
    pub last_active_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NamedUsage {
    pub name: String,
    pub calls: usize,
    pub estimated_tokens: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalThread {
    pub id: String,
    pub title: String,
    pub tokens: i64,
    pub updated_at: Option<DateTime<Utc>>,
    pub model: Option<String>,
    pub cwd: String,
    pub archived: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalUsage {
    pub lifetime_tokens: i64,
    pub today_tokens: i64,
    pub seven_day_tokens: i64,
    pub thread_count: i64,
    pub last_updated_at: Option<DateTime<Utc>>,
    pub daily_buckets: Vec<DailyTokenBucket>,
    pub recent_threads: Vec<LocalThread>,
    pub detailed_usage: Option<DetailedUsage>,
    pub usage_trend: Option<UsageTrend>,
    pub projects: Vec<ProjectUsage>,
    pub skill_usage: Vec<NamedUsage>,
    pub tool_usage: Vec<NamedUsage>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub refreshed_at: DateTime<Utc>,
    pub account: Option<AccountInfo>,
    pub limit_id: Option<String>,
    pub limit_name: Option<String>,
    pub primary: Option<RateWindow>,
    pub secondary: Option<RateWindow>,
    pub cloud_lifetime_tokens: Option<i64>,
    pub local: Option<LocalUsage>,
    pub diagnostics: Vec<DiagnosticItem>,
}

impl UsageSnapshot {
    pub fn empty() -> Self {
        Self {
            refreshed_at: Utc::now(),
            account: None,
            limit_id: None,
            limit_name: None,
            primary: None,
            secondary: None,
            cloud_lifetime_tokens: None,
            local: None,
            diagnostics: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeScope {
    Codex,
    ClaudeCode,
}

impl RuntimeScope {
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::ClaudeCode => "Claude Code",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeStatus {
    Available,
    LocalOnly,
    SnapshotNeeded,
    Stale,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUsageSnapshot {
    pub scope: RuntimeScope,
    pub display_name: String,
    pub status: RuntimeStatus,
    pub snapshot: UsageSnapshot,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MultiRuntimeUsageSnapshot {
    pub schema_version: u32,
    pub refreshed_at: DateTime<Utc>,
    pub runtimes: Vec<RuntimeUsageSnapshot>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_delta_preserves_cached_input_as_a_subtotal() {
        let previous = TokenBreakdown {
            input_tokens: 100,
            cached_input_tokens: 70,
            output_tokens: 10,
            reasoning_output_tokens: 5,
            total_tokens: 110,
        };
        let current = TokenBreakdown {
            input_tokens: 150,
            cached_input_tokens: 100,
            output_tokens: 20,
            reasoning_output_tokens: 8,
            total_tokens: 170,
        };
        assert_eq!(
            current.delta_from(&previous),
            TokenBreakdown {
                input_tokens: 50,
                cached_input_tokens: 30,
                output_tokens: 10,
                reasoning_output_tokens: 3,
                total_tokens: 60
            }
        );
    }

    #[test]
    fn rate_window_clamps_invalid_values() {
        let window = RateWindow::new(120.0, Some(300), None);
        assert_eq!(window.used_percent, 100.0);
        assert_eq!(window.remaining_percent, 0.0);
    }

    #[test]
    fn priced_usage_excludes_token_events_without_a_known_price() {
        let tokens = TokenBreakdown {
            input_tokens: 10,
            total_tokens: 10,
            ..Default::default()
        };
        let mut usage = PricedTokenUsage::default();
        usage.add_priced_tokens(&tokens, Some(0.01));
        usage.add_priced_tokens(&tokens, None);
        assert_eq!(usage.tokens.total_tokens, 20);
        assert_eq!(usage.estimated_cost_usd, Some(0.01));
    }
}
