use crate::credentials::{CredentialStore, Credentials};
use crate::error::{AppError, AppResult};
use crate::hackerone::{
    Asset, HackerOneApi, Organization, Program, ReportDetail, ReportPage, ReportQuery, TeamMember,
};
use crate::local_db::{ReportStore, TriageRecord};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub struct AppContext {
    pub creds: Arc<dyn CredentialStore>,
    pub api: Arc<dyn HackerOneApi>,
    pub reports: Arc<dyn ReportStore>,
    // PIDs of in-flight `claude` triage subprocesses, keyed by report id, so the
    // `stop_triage` command can signal the right child.
    pub triages: Arc<Mutex<HashMap<String, u32>>>,
}

// RAII guard that ensures a report's PID is removed from the running-triages map on every
// exit path (Ok, Err, panic) from `run_triage`. Without this, an early return would leave
// a stale entry and `stop_triage` would later send a signal to an unrelated PID.
struct TriageGuard {
    triages: Arc<Mutex<HashMap<String, u32>>>,
    report_id: String,
}

impl Drop for TriageGuard {
    fn drop(&mut self) {
        if let Ok(mut m) = self.triages.lock() {
            m.remove(&self.report_id);
        }
    }
}

#[derive(serde::Serialize)]
pub struct CredentialsStatus {
    pub has_credentials: bool,
    pub username: Option<String>,
}

#[tauri::command]
pub async fn credentials_status(ctx: State<'_, AppContext>) -> AppResult<CredentialsStatus> {
    let loaded = ctx.creds.load()?;
    Ok(CredentialsStatus {
        has_credentials: loaded.is_some(),
        username: loaded.map(|c| c.username),
    })
}

#[tauri::command]
pub async fn credentials_save(
    ctx: State<'_, AppContext>,
    username: String,
    token: String,
) -> AppResult<()> {
    let creds = Credentials { username, token };
    ctx.creds.save(&creds)?;
    if let Err(e) = ctx.api.validate().await {
        let _ = ctx.creds.clear();
        return Err(match e {
            AppError::Unauthorized { .. } => AppError::Unauthorized {
                message: "Invalid username or token".into(),
            },
            other => other,
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn credentials_clear(ctx: State<'_, AppContext>) -> AppResult<()> {
    ctx.creds.clear()
}

#[tauri::command]
pub async fn list_organizations(ctx: State<'_, AppContext>) -> AppResult<Vec<Organization>> {
    ctx.api.list_organizations().await
}

#[tauri::command]
pub async fn list_programs(
    ctx: State<'_, AppContext>,
    org_id: String,
) -> AppResult<Vec<Program>> {
    ctx.api.list_programs(&org_id).await
}

#[tauri::command]
pub async fn list_assets(
    ctx: State<'_, AppContext>,
    org_id: String,
) -> AppResult<Vec<Asset>> {
    ctx.api.list_assets(&org_id).await
}

#[tauri::command]
pub async fn list_program_members(
    ctx: State<'_, AppContext>,
    program_id: String,
) -> AppResult<Vec<TeamMember>> {
    ctx.api.list_program_members(&program_id).await
}

#[tauri::command]
pub async fn list_reports(
    ctx: State<'_, AppContext>,
    query: ReportQuery,
) -> AppResult<ReportPage> {
    let page = ctx.api.list_reports(query).await?;
    let ids: Vec<&str> = page.items.iter().map(|r| r.id.as_str()).collect();
    ctx.reports.upsert(&ids)?;
    Ok(page)
}

#[tauri::command]
pub async fn mark_report_read(ctx: State<'_, AppContext>, report_id: String) -> AppResult<()> {
    ctx.reports.mark_read(&report_id)
}

#[tauri::command]
pub async fn mark_reports_read(
    ctx: State<'_, AppContext>,
    report_ids: Vec<String>,
) -> AppResult<()> {
    let refs: Vec<&str> = report_ids.iter().map(String::as_str).collect();
    ctx.reports.mark_read_many(&refs)
}

#[tauri::command]
pub async fn get_read_ids(
    ctx: State<'_, AppContext>,
    report_ids: Vec<String>,
) -> AppResult<Vec<String>> {
    let refs: Vec<&str> = report_ids.iter().map(String::as_str).collect();
    ctx.reports.list_read(&refs)
}

#[tauri::command]
pub async fn get_report(
    ctx: State<'_, AppContext>,
    report_id: String,
) -> AppResult<ReportDetail> {
    ctx.api.get_report(&report_id).await
}

#[tauri::command]
pub async fn update_report_asset(
    ctx: State<'_, AppContext>,
    report_id: String,
    asset_id: String,
) -> AppResult<()> {
    ctx.api.update_report_asset(&report_id, &asset_id).await
}

#[tauri::command]
pub async fn get_triage(
    ctx: State<'_, AppContext>,
    report_id: String,
) -> AppResult<Option<TriageRecord>> {
    ctx.reports.get_triage(&report_id)
}

#[derive(serde::Serialize)]
pub struct TriageValidityEntry {
    pub id: String,
    pub validity: Option<String>,
}

#[tauri::command]
pub async fn list_triage_validity(
    ctx: State<'_, AppContext>,
    report_ids: Vec<String>,
) -> AppResult<Vec<TriageValidityEntry>> {
    let refs: Vec<&str> = report_ids.iter().map(String::as_str).collect();
    let rows = ctx.reports.list_triage_validity(&refs)?;
    Ok(rows
        .into_iter()
        .map(|(id, validity)| TriageValidityEntry { id, validity })
        .collect())
}

// Scan `s` for balanced `{ … }` substrings and return the first one that parses as JSON
// and contains a `summary` field. Aware of string literals and `\` escapes so a `"}"`
// inside a JSON string doesn't fool the depth counter.
fn extract_triage_json(s: &str) -> Option<serde_json::Value> {
    let bytes = s.as_bytes();
    for start in 0..bytes.len() {
        if bytes[start] != b'{' {
            continue;
        }
        let mut depth: i32 = 0;
        let mut in_string = false;
        let mut escape = false;
        for end in start..bytes.len() {
            let c = bytes[end];
            if escape {
                escape = false;
                continue;
            }
            if c == b'\\' && in_string {
                escape = true;
                continue;
            }
            if c == b'"' {
                in_string = !in_string;
                continue;
            }
            if in_string {
                continue;
            }
            match c {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        let candidate = &s[start..=end];
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(candidate) {
                            if v.get("summary").is_some() {
                                return Some(v);
                            }
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    None
}

// Try to interpret claude's final result text as the structured JSON we asked for in the
// prompt: `{"validity": "valid|partially-valid|invalid|indeterminate", "summary": "..."}`.
// We don't require the JSON to be the *entire* response — claude often wraps it in prose
// or fences despite being told not to — so we scan for the first embedded object that has
// the right shape. Falls back to the raw text with no validity when nothing parses.
fn parse_triage_result(raw: &str) -> (String, Option<String>) {
    if let Some(value) = extract_triage_json(raw) {
        if let Some(summary) = value.get("summary").and_then(|v| v.as_str()) {
            let validity = value
                .get("validity")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_lowercase())
                .filter(|v| {
                    matches!(
                        v.as_str(),
                        "valid" | "partially-valid" | "invalid" | "indeterminate"
                    )
                });
            return (summary.to_owned(), validity);
        }
    }
    (raw.to_owned(), None)
}

#[cfg(test)]
mod triage_parse_tests {
    use super::*;

    #[test]
    fn whole_response_is_json() {
        let raw = "{\"validity\":\"valid\",\"summary\":\"## Overview\\n\\nDetails\"}";
        let (summary, validity) = parse_triage_result(raw);
        assert_eq!(summary, "## Overview\n\nDetails");
        assert_eq!(validity.as_deref(), Some("valid"));
    }

    #[test]
    fn json_embedded_after_prose() {
        let raw =
            "Some commentary above.\n\n{\"validity\":\"invalid\",\"summary\":\"## Why\\n\\nReason\"}";
        let (summary, validity) = parse_triage_result(raw);
        assert_eq!(summary, "## Why\n\nReason");
        assert_eq!(validity.as_deref(), Some("invalid"));
    }

    #[test]
    fn json_wrapped_in_code_fence() {
        let raw =
            "```json\n{\"validity\":\"partially-valid\",\"summary\":\"Notes\"}\n```";
        let (summary, validity) = parse_triage_result(raw);
        assert_eq!(summary, "Notes");
        assert_eq!(validity.as_deref(), Some("partially-valid"));
    }

    #[test]
    fn unknown_validity_dropped() {
        let raw = "{\"validity\":\"maybe\",\"summary\":\"text\"}";
        let (summary, validity) = parse_triage_result(raw);
        assert_eq!(summary, "text");
        assert_eq!(validity, None);
    }

    #[test]
    fn no_json_falls_back_to_raw() {
        let raw = "Plain markdown with no JSON.";
        let (summary, validity) = parse_triage_result(raw);
        assert_eq!(summary, raw);
        assert_eq!(validity, None);
    }

    #[test]
    fn brace_inside_string_does_not_confuse_scanner() {
        let raw = "{\"validity\":\"valid\",\"summary\":\"contains } and { inside\"}";
        let (summary, validity) = parse_triage_result(raw);
        assert_eq!(summary, "contains } and { inside");
        assert_eq!(validity.as_deref(), Some("valid"));
    }
}

// Prompt template is embedded at compile time so distribution builds don't depend on the
// developer's source tree being present at the absolute path it was authored at.
const TRIAGE_PROMPT_TEMPLATE: &str = include_str!("../prompts/triage.md");
const TRIAGE_WORKING_DIR: &str = "/Users/john/sites/wp";

fn assemble_triage_prompt(report_title: &str, report_body: &str) -> String {
    format!("{TRIAGE_PROMPT_TEMPLATE}\n\n# {report_title}\n\n{report_body}")
}

#[tauri::command]
pub async fn get_triage_prompt(report_title: String, report_body: String) -> AppResult<String> {
    Ok(assemble_triage_prompt(&report_title, &report_body))
}

#[tauri::command]
pub async fn run_triage(
    app: tauri::AppHandle,
    ctx: State<'_, AppContext>,
    report_id: String,
    prompt: String,
) -> AppResult<TriageRecord> {

    // Inherit a shell-like PATH so `claude` resolves whether installed via Homebrew or npm.
    let path_env = std::env::var("PATH").unwrap_or_default();
    let augmented_path = format!(
        "{}/.claude/local:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}",
        std::env::var("HOME").unwrap_or_default(),
        path_env
    );

    let mut child = tokio::process::Command::new("claude")
        .args(["-p", "--output-format", "stream-json", "--verbose"])
        .current_dir(TRIAGE_WORKING_DIR)
        .env("PATH", &augmented_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Other {
            message: format!("failed to spawn claude: {e}"),
        })?;

    // Register the PID before any await so a STOP issued in the very first moment after
    // spawn still has something to signal. The guard removes it on every exit path.
    let _guard = if let Some(pid) = child.id() {
        ctx.triages
            .lock()
            .unwrap()
            .insert(report_id.clone(), pid);
        Some(TriageGuard {
            triages: ctx.triages.clone(),
            report_id: report_id.clone(),
        })
    } else {
        None
    };

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::other("failed to open claude stdin"))?;
    stdin
        .write_all(prompt.as_bytes())
        .await
        .map_err(AppError::other)?;
    stdin.shutdown().await.map_err(AppError::other)?;
    drop(stdin);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::other("failed to open claude stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::other("failed to open claude stderr"))?;

    // Drain stderr in the background — keep the buffer empty so the process doesn't block
    // on a full pipe, and surface anything claude says if the run fails.
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        use tokio::io::AsyncReadExt;
        let _ = reader.read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).into_owned()
    });

    let event_name = format!("triage:event:{report_id}");
    let mut final_result: Option<String> = None;

    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(value) => {
                        // Capture the final result before forwarding so the UI sees it land
                        // in the same event stream it's been showing.
                        if value.get("type").and_then(|v| v.as_str()) == Some("result") {
                            if let Some(text) = value.get("result").and_then(|v| v.as_str()) {
                                final_result = Some(text.to_string());
                            }
                        }
                        let _ = app.emit(&event_name, &value);
                    }
                    Err(_) => {
                        // Forward as a raw line so the UI can still show it for debugging.
                        let _ = app.emit(
                            &event_name,
                            serde_json::json!({ "type": "raw", "line": line }),
                        );
                    }
                }
            }
            Ok(None) => break,
            Err(e) => return Err(AppError::other(e)),
        }
    }

    let status = child.wait().await.map_err(AppError::other)?;
    let stderr_text = stderr_task.await.unwrap_or_default();
    if !status.success() {
        return Err(AppError::Other {
            message: format!(
                "claude exited with status {}: {}",
                status,
                stderr_text.trim()
            ),
        });
    }

    let raw = final_result
        .ok_or_else(|| AppError::other("claude finished without emitting a result event"))?;
    let (summary, validity) = parse_triage_result(&raw);
    ctx.reports
        .set_triage(&report_id, &summary, validity.as_deref())?;
    Ok(TriageRecord { summary, validity })
}

#[tauri::command]
pub async fn stop_triage(ctx: State<'_, AppContext>, report_id: String) -> AppResult<bool> {
    let pid = ctx.triages.lock().unwrap().get(&report_id).copied();
    let Some(pid) = pid else {
        return Ok(false);
    };
    // SIGTERM lets claude shut down cleanly; the run_triage loop hits EOF on stdout, wait()
    // returns a non-zero status, and the frontend gets a normal TRIAGE_RUN_FAILED.
    let rc = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    Ok(rc == 0)
}

// Show a native save-file dialog for an attachment and, if the user confirms a path,
// fetch the bytes from the (presigned) URL on the Rust side and write them to disk.
// Returns true if a file was written, false if the user cancelled.
#[tauri::command]
pub async fn save_attachment(
    app: tauri::AppHandle,
    url: String,
    suggested_filename: String,
) -> AppResult<bool> {
    use tauri_plugin_dialog::DialogExt;

    #[cfg(debug_assertions)]
    println!("[attachments] save dialog for {suggested_filename}");

    let path = app
        .dialog()
        .file()
        .set_file_name(&suggested_filename)
        .blocking_save_file();
    let Some(path) = path else {
        return Ok(false);
    };
    let path = path.into_path().map_err(AppError::other)?;

    #[cfg(debug_assertions)]
    println!("[attachments] GET {url}");
    let res = reqwest::get(&url).await?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(AppError::from_status(status.as_u16(), &body));
    }
    let bytes = res.bytes().await?;
    std::fs::write(&path, &bytes).map_err(AppError::other)?;
    Ok(true)
}
