use crate::{AccountInfo, DiagnosticItem, RateWindow};
use anyhow::{Context, Result};
use chrono::DateTime;
use serde_json::{json, Value};
use std::{io::{BufRead, BufReader, Write}, path::Path, process::{Command, Stdio}, sync::mpsc, thread, time::{Duration, Instant}};

#[derive(Clone, Debug, Default)]
pub struct AppServerSnapshot {
    pub account: Option<AccountInfo>,
    pub limit_id: Option<String>,
    pub limit_name: Option<String>,
    pub primary: Option<RateWindow>,
    pub secondary: Option<RateWindow>,
    pub cloud_lifetime_tokens: Option<i64>,
}

pub fn read(path: &Path) -> Result<(AppServerSnapshot, Vec<DiagnosticItem>)> {
    let (program, arguments) = crate::paths::command_line_for(path);
    let mut child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().context("unable to start codex app-server")?;
    let mut stdin = child.stdin.take().context("app-server stdin unavailable")?;
    let stdout = child.stdout.take().context("app-server stdout unavailable")?;
    let stderr = child.stderr.take().context("app-server stderr unavailable")?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(|line| line.ok()) {
            if sender.send(line).is_err() { break; }
        }
    });
    thread::spawn(move || { for _ in BufReader::new(stderr).lines() {} });

    send(&mut stdin, json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": { "name": "tokenusage", "title": "TokenUsage", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": true, "optOutNotificationMethods": [] }
        }
    }))?;

    let deadline = Instant::now() + Duration::from_secs(12);
    let mut initialized = false;
    let mut complete = [false; 3];
    let mut snapshot = AppServerSnapshot::default();
    let mut diagnostics = Vec::new();
    while Instant::now() < deadline && complete.iter().any(|done| !done) {
        let timeout = deadline.saturating_duration_since(Instant::now());
        let Ok(line) = receiver.recv_timeout(timeout) else { break; };
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
        let id = value.get("id").and_then(Value::as_i64);
        if id == Some(1) && !initialized {
            initialized = true;
            send(&mut stdin, json!({ "method": "initialized" }))?;
            send(&mut stdin, json!({ "id": 2, "method": "account/read", "params": { "refreshToken": false } }))?;
            send(&mut stdin, json!({ "id": 3, "method": "account/rateLimits/read" }))?;
            send(&mut stdin, json!({ "id": 4, "method": "account/usage/read" }))?;
            continue;
        }
        let Some(id) = id else { continue; };
        if !(2..=4).contains(&id) { continue; }
        let index = (id - 2) as usize;
        complete[index] = true;
        if value.get("error").is_some() {
            diagnostics.push(DiagnosticItem::warning("app_server_request_failed", "Codex app-server did not return one account data source."));
            continue;
        }
        let Some(result) = value.get("result") else { continue; };
        match id {
            2 => snapshot.account = parse_account(result),
            3 => parse_rate_limits(result, &mut snapshot),
            4 => snapshot.cloud_lifetime_tokens = result.get("summary").and_then(|summary| summary.get("lifetimeTokens")).and_then(number_i64),
            _ => {}
        }
    }
    if !initialized { diagnostics.push(DiagnosticItem::warning("app_server_initialize_timeout", "Codex app-server did not complete initialization within 12 seconds.")); }
    else if complete.iter().any(|done| !done) { diagnostics.push(DiagnosticItem::warning("app_server_partial_timeout", "Codex app-server returned only part of the account data before timeout.")); }
    let _ = child.kill();
    let _ = child.wait();
    Ok((snapshot, diagnostics))
}

fn send(stdin: &mut impl Write, value: Value) -> Result<()> {
    let encoded = serde_json::to_vec(&value)?;
    stdin.write_all(&encoded)?;
    stdin.write_all(b"\n")?;
    stdin.flush()?;
    Ok(())
}

fn parse_account(value: &Value) -> Option<AccountInfo> {
    let account = value.get("account")?;
    Some(AccountInfo {
        r#type: account.get("type")?.as_str()?.to_owned(),
        plan_type: account.get("planType").and_then(Value::as_str).map(str::to_owned),
        email_present: account.get("email").is_some_and(|email| !email.is_null()),
    })
}

fn parse_rate_limits(value: &Value, snapshot: &mut AppServerSnapshot) {
    let limits = value.get("rateLimitsByLimitId").and_then(|all| all.get("codex")).or_else(|| value.get("rateLimits"));
    let Some(limits) = limits else { return; };
    snapshot.limit_id = limits.get("limitId").and_then(Value::as_str).map(str::to_owned);
    snapshot.limit_name = limits.get("limitName").and_then(Value::as_str).map(str::to_owned);
    snapshot.primary = parse_window(limits.get("primary"));
    snapshot.secondary = parse_window(limits.get("secondary"));
}

fn parse_window(value: Option<&Value>) -> Option<RateWindow> {
    let value = value?;
    let used_percent = value.get("usedPercent").and_then(number_f64)?;
    let resets_at = value.get("resetsAt").and_then(number_i64).and_then(|seconds| DateTime::from_timestamp(seconds, 0));
    Some(RateWindow::new(used_percent, value.get("windowDurationMins").and_then(number_i64), resets_at))
}

fn number_i64(value: &Value) -> Option<i64> { value.as_i64().or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok())).or_else(|| value.as_f64().map(|number| number as i64)) }
fn number_f64(value: &Value) -> Option<f64> { value.as_f64().or_else(|| value.as_i64().map(|number| number as f64)).or_else(|| value.as_u64().map(|number| number as f64)) }
