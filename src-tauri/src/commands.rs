use crate::credentials::{CredentialStore, Credentials};
use crate::error::{AppError, AppResult};
use crate::hackerone::{
    Asset, HackerOneApi, InboxRef, Organization, Program, ReportDetail, TeamMember,
};
use crate::local_db::{LocalQuery, ReportListItem, ReportStore, TriageRecord};
use crate::settings::{DEFAULT_TRIAGE_PROMPT, Settings, SettingsStore};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub struct AppContext {
    pub creds: Arc<dyn CredentialStore>,
    pub api: Arc<dyn HackerOneApi>,
    pub reports: Arc<dyn ReportStore>,
    pub settings: Arc<dyn SettingsStore>,
    // PIDs of in-flight `claude` triage subprocesses, keyed by report id, so the
    // `stop_triage` command can signal the right child.
    pub triages: Arc<Mutex<HashMap<String, u32>>>,
    // Guards the background report sync so overlapping `start_report_sync` calls no-op.
    pub sync_running: Arc<AtomicBool>,
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
        username: loaded.map(|c| c.username.clone()),
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
pub async fn list_programs(ctx: State<'_, AppContext>, org_id: String) -> AppResult<Vec<Program>> {
    ctx.api.list_programs(&org_id).await
}

#[tauri::command]
pub async fn list_assets(ctx: State<'_, AppContext>, org_id: String) -> AppResult<Vec<Asset>> {
    ctx.api.list_assets(&org_id).await
}

#[tauri::command]
pub async fn list_program_members(
    ctx: State<'_, AppContext>,
    program_id: String,
) -> AppResult<Vec<TeamMember>> {
    ctx.api.list_program_members(&program_id).await
}

// Query the local SQLite mirror. This is the app's primary report source — the frontend never
// lists reports from the HackerOne API directly anymore; the background sync (see `sync.rs`)
// keeps the mirror current. Returns every matching report (no pagination).
#[tauri::command]
pub async fn query_reports(
    ctx: State<'_, AppContext>,
    query: LocalQuery,
) -> AppResult<Vec<ReportListItem>> {
    ctx.reports.query(&query)
}

// Distinct inboxes seen across all reports synced for a program, for the sidebar inbox filter.
// HackerOne has no endpoint to enumerate a program's inboxes, so the set is derived locally.
#[tauri::command]
pub async fn list_inboxes(
    ctx: State<'_, AppContext>,
    program_handle: String,
) -> AppResult<Vec<InboxRef>> {
    ctx.reports.distinct_inboxes(&program_handle)
}

// Total reports mirrored locally for a program, for the Topbar's idle "N synced" indicator.
#[tauri::command]
pub async fn synced_report_count(
    ctx: State<'_, AppContext>,
    program_handle: String,
) -> AppResult<i64> {
    ctx.reports.count_reports(&program_handle)
}

// Kick off (or resume) the background sync for a program. Idempotent — a no-op if a sync is
// already in flight. Progress is reported via the `sync:status` and `sync:changed` events.
#[tauri::command]
pub async fn start_report_sync(
    app: tauri::AppHandle,
    ctx: State<'_, AppContext>,
    program_handle: String,
) -> AppResult<()> {
    let api = ctx.api.clone();
    let store = ctx.reports.clone();
    let running = ctx.sync_running.clone();
    tokio::spawn(async move {
        crate::sync::run_sync(app, api, store, running, program_handle).await;
    });
    Ok(())
}

// Fetch a report's full detail from the HackerOne API and write it through to the local DB so
// the mirror stays current. Used for the initial detail load and the background poll of the
// selected report.
#[tauri::command]
pub async fn get_report(ctx: State<'_, AppContext>, report_id: String) -> AppResult<ReportDetail> {
    let detail = ctx.api.get_report(&report_id).await?;
    // Best-effort persistence — a DB hiccup shouldn't block showing the freshly fetched report.
    let _ = ctx.reports.upsert_detail(&detail);
    Ok(detail)
}

// The macOS system accent colour, resolved to a hex value plus a contrasting foreground, for the
// frontend to feed into its `--accent` / `--on-accent` CSS variables. Synchronous — it hops onto
// the main thread internally to read `NSColor.controlAccentColor` correctly.
#[tauri::command]
pub fn get_accent_color(app: tauri::AppHandle) -> crate::appearance::AccentColor {
    crate::appearance::accent_color(&app)
}

// The locally-cached full detail for a report, if the sync has fetched it. Lets the detail pane
// render activities/attachments instantly from the DB before (or without) a network round-trip.
#[tauri::command]
pub async fn get_cached_report(
    ctx: State<'_, AppContext>,
    report_id: String,
) -> AppResult<Option<ReportDetail>> {
    ctx.reports.get_detail(&report_id)
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
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(candidate)
                            && v.get("summary").is_some()
                        {
                            return Some(v);
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
// prompt: `{"validity": "valid|partially-valid|invalid|indeterminate", "summary": "...",
// "new_files": ["..."]}`. We don't require the JSON to be the *entire* response — claude
// often wraps it in prose or fences despite being told not to — so we scan for the first
// embedded object that has the right shape. Falls back to the raw text with no validity and
// no files when nothing parses. `new_files` is optional and defaults to empty.
fn parse_triage_result(raw: &str) -> (String, Option<String>, Vec<String>) {
    if let Some(value) = extract_triage_json(raw)
        && let Some(summary) = value.get("summary").and_then(|v| v.as_str())
    {
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
        let new_files = value
            .get("new_files")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        return (summary.to_owned(), validity, new_files);
    }
    (raw.to_owned(), None, Vec::new())
}

#[cfg(test)]
mod triage_parse_tests {
    use super::*;

    #[test]
    fn whole_response_is_json() {
        let raw = "{\"validity\":\"valid\",\"summary\":\"## Overview\\n\\nDetails\"}";
        let (summary, validity, new_files) = parse_triage_result(raw);
        assert_eq!(summary, "## Overview\n\nDetails");
        assert_eq!(validity.as_deref(), Some("valid"));
        assert!(new_files.is_empty());
    }

    #[test]
    fn json_embedded_after_prose() {
        let raw = "Some commentary above.\n\n{\"validity\":\"invalid\",\"summary\":\"## Why\\n\\nReason\"}";
        let (summary, validity, _) = parse_triage_result(raw);
        assert_eq!(summary, "## Why\n\nReason");
        assert_eq!(validity.as_deref(), Some("invalid"));
    }

    #[test]
    fn json_wrapped_in_code_fence() {
        let raw = "```json\n{\"validity\":\"partially-valid\",\"summary\":\"Notes\"}\n```";
        let (summary, validity, _) = parse_triage_result(raw);
        assert_eq!(summary, "Notes");
        assert_eq!(validity.as_deref(), Some("partially-valid"));
    }

    #[test]
    fn unknown_validity_dropped() {
        let raw = "{\"validity\":\"maybe\",\"summary\":\"text\"}";
        let (summary, validity, _) = parse_triage_result(raw);
        assert_eq!(summary, "text");
        assert_eq!(validity, None);
    }

    #[test]
    fn no_json_falls_back_to_raw() {
        let raw = "Plain markdown with no JSON.";
        let (summary, validity, new_files) = parse_triage_result(raw);
        assert_eq!(summary, raw);
        assert_eq!(validity, None);
        assert!(new_files.is_empty());
    }

    #[test]
    fn brace_inside_string_does_not_confuse_scanner() {
        let raw = "{\"validity\":\"valid\",\"summary\":\"contains } and { inside\"}";
        let (summary, validity, _) = parse_triage_result(raw);
        assert_eq!(summary, "contains } and { inside");
        assert_eq!(validity.as_deref(), Some("valid"));
    }

    #[test]
    fn new_files_parsed_and_blanks_dropped() {
        let raw = "{\"validity\":\"valid\",\"summary\":\"s\",\"new_files\":[\"/tmp/a.php\",\"  \",\"/tmp/b.txt\"]}";
        let (_, _, new_files) = parse_triage_result(raw);
        assert_eq!(
            new_files,
            vec!["/tmp/a.php".to_string(), "/tmp/b.txt".to_string()]
        );
    }

    #[test]
    fn new_files_absent_is_empty() {
        let raw = "{\"validity\":\"valid\",\"summary\":\"s\"}";
        let (_, _, new_files) = parse_triage_result(raw);
        assert!(new_files.is_empty());
    }

    #[test]
    fn prompt_uses_the_supplied_template() {
        let assembled = assemble_triage_prompt("Custom instructions", "A title", "A body");
        assert_eq!(assembled, "Custom instructions\n\n# A title\n\nA body");
    }

    // Pins the shape of the resume command: a path needing no quoting is left bare, one with a
    // space is quoted so it survives being pasted into a shell.
    #[test]
    fn resume_command_quotes_only_when_needed() {
        assert_eq!(
            shlex::try_quote("/Users/john/sites/wp").unwrap(),
            "/Users/john/sites/wp"
        );
        assert_eq!(
            shlex::try_quote("/Users/j/my sites/wp").unwrap(),
            "'/Users/j/my sites/wp'"
        );
    }

    #[test]
    fn settings_prompt_falls_back_to_default() {
        let settings = Settings::default();
        assert_eq!(settings.triage_prompt(), DEFAULT_TRIAGE_PROMPT);
        let overridden = Settings {
            triage_prompt: Some("mine".into()),
            ..Settings::default()
        };
        assert_eq!(overridden.triage_prompt(), "mine");
    }
}

fn assemble_triage_prompt(template: &str, report_title: &str, report_body: &str) -> String {
    format!("{template}\n\n# {report_title}\n\n{report_body}")
}

#[tauri::command]
pub async fn get_settings(ctx: State<'_, AppContext>) -> AppResult<Settings> {
    ctx.settings.load()
}

// Persist the triage working directory. An empty/whitespace string clears it back to "unset"
// so the UI's "no directory configured" path can be reached again. Returns the saved settings.
#[tauri::command]
pub async fn set_triage_working_dir(
    ctx: State<'_, AppContext>,
    dir: Option<String>,
) -> AppResult<Settings> {
    let mut settings = ctx.settings.load()?;
    settings.triage_working_dir = dir.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    ctx.settings.save(&settings)?;
    Ok(settings)
}

// Show a native directory picker. Returns the chosen absolute path, or None if cancelled.
#[tauri::command]
pub async fn pick_directory(app: tauri::AppHandle) -> AppResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;

    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(AppError::other)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn get_triage_prompt(
    ctx: State<'_, AppContext>,
    report_title: String,
    report_body: String,
) -> AppResult<String> {
    let settings = ctx.settings.load()?;
    Ok(assemble_triage_prompt(
        settings.triage_prompt(),
        &report_title,
        &report_body,
    ))
}

#[tauri::command]
pub async fn get_default_triage_prompt() -> AppResult<String> {
    Ok(DEFAULT_TRIAGE_PROMPT.to_owned())
}

// An empty/whitespace string (or null) clears the override so the shipped default applies again.
#[tauri::command]
pub async fn set_triage_prompt(
    ctx: State<'_, AppContext>,
    prompt: Option<String>,
) -> AppResult<Settings> {
    let mut settings = ctx.settings.load()?;
    settings.triage_prompt = prompt.filter(|s| !s.trim().is_empty());
    ctx.settings.save(&settings)?;
    Ok(settings)
}

fn claude_search_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs = vec![
        format!("{home}/.local/bin"),
        format!("{home}/.claude/local"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
    ];
    if let Ok(inherited) = std::env::var("PATH") {
        dirs.extend(inherited.split(':').map(str::to_string));
    }
    dirs.join(":")
}

// Absolute path to the `claude` binary. Resolving it ourselves rather than relying on the child's
// PATH lookup means a missing install produces an error naming where we looked, instead of a bare
// "No such file or directory" from spawn.
fn claude_binary() -> AppResult<std::path::PathBuf> {
    let search_path = claude_search_path();
    for dir in search_path.split(':').filter(|d| !d.is_empty()) {
        let candidate = std::path::Path::new(dir).join("claude");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(AppError::other(format!(
        "Could not find the `claude` command. Looked in: {search_path}"
    )))
}

#[tauri::command]
pub async fn run_triage(
    app: tauri::AppHandle,
    ctx: State<'_, AppContext>,
    report_id: String,
    prompt: String,
) -> AppResult<TriageRecord> {
    // No default — the user configures this in Settings. Bail clearly if it's still unset so
    // the frontend can prompt for it rather than spawning `claude` in some arbitrary directory.
    let working_dir = ctx.settings.load()?.triage_working_dir.ok_or_else(|| {
        AppError::other("No triage working directory is set. Choose one in Settings.")
    })?;

    let mut child = tokio::process::Command::new(claude_binary()?)
        .args(["-p", "--output-format", "stream-json", "--verbose"])
        .current_dir(&working_dir)
        .env("PATH", claude_search_path())
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
        ctx.triages.lock().unwrap().insert(report_id.clone(), pid);
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
    // Every stream-json event carries the session id (the `init` event first). Recording it lets
    // the UI offer a `claude --resume` command — the interactive resume picker hides sessions
    // started with `-p`, so without the id these runs are effectively unreachable.
    let mut session_id: Option<String> = None;

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
                        if value.get("type").and_then(|v| v.as_str()) == Some("result")
                            && let Some(text) = value.get("result").and_then(|v| v.as_str())
                        {
                            final_result = Some(text.to_string());
                        }
                        if session_id.is_none()
                            && let Some(sid) = value.get("session_id").and_then(|v| v.as_str())
                        {
                            session_id = Some(sid.to_string());
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
    let (summary, validity, new_files) = parse_triage_result(&raw);
    ctx.reports.set_triage(
        &report_id,
        &summary,
        validity.as_deref(),
        &new_files,
        session_id.as_deref(),
    )?;
    Ok(TriageRecord {
        summary,
        validity,
        new_files,
        session_id,
    })
}

// The shell command that reopens a triage run's claude session, ready to paste into a terminal.
// `claude --resume` only finds sessions belonging to the current directory, so it has to cd to the
// triage working directory first — hence the quoting, which shlex handles.
#[tauri::command]
pub async fn triage_resume_command(
    ctx: State<'_, AppContext>,
    session_id: String,
) -> AppResult<String> {
    let dir = ctx
        .settings
        .load()?
        .triage_working_dir
        .ok_or_else(|| AppError::other("No triage working directory is set."))?;
    let dir = shlex::try_quote(&dir).map_err(AppError::other)?;
    let session = shlex::try_quote(&session_id).map_err(AppError::other)?;
    Ok(format!("cd {dir} && claude --resume {session}"))
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

// Prompt template for duplicate detection, embedded at compile time alongside the triage one.
const DUPLICATES_PROMPT_TEMPLATE: &str = include_str!("../prompts/duplicates.md");

// One report's text as supplied by the frontend for duplicate comparison. The frontend already
// has the title and description in the loaded report summaries, so there's no need to re-fetch.
#[derive(serde::Deserialize)]
pub struct DuplicateInput {
    pub id: String,
    pub title: String,
    pub body: String,
}

// claude's brief verdict on whether the supplied reports are duplicates of one another.
#[derive(serde::Serialize)]
pub struct DuplicateResult {
    pub summary: String,
}

// Append each report to the template as its own `### Report #<id>` section. The caller sends the
// reports already sorted ascending by id, so the lowest-id (canonical) report comes first — which
// is the ordering the prompt's "lowest ID is canonical" rule refers to.
fn assemble_duplicates_prompt(reports: &[DuplicateInput]) -> String {
    let mut prompt = String::from(DUPLICATES_PROMPT_TEMPLATE);
    for r in reports {
        let body = if r.body.trim().is_empty() {
            "(no description)"
        } else {
            r.body.as_str()
        };
        prompt.push_str(&format!(
            "\n\n### Report #{}: {}\n\n{}",
            r.id, r.title, body
        ));
    }
    prompt
}

// Ask claude whether the supplied reports are duplicates of one another. Mirrors `run_triage`'s
// subprocess + stream-json plumbing, but the task is pure text comparison: no working directory is
// needed, so we spawn in a temp dir, and the final result is taken as-is (a short markdown verdict)
// rather than parsed for structured fields. Events stream on `duplicates:event:{request_id}` and
// the PID is registered under `request_id` so `stop_duplicates` can signal it.
#[tauri::command]
pub async fn run_duplicates(
    app: tauri::AppHandle,
    ctx: State<'_, AppContext>,
    request_id: String,
    reports: Vec<DuplicateInput>,
) -> AppResult<DuplicateResult> {
    let prompt = assemble_duplicates_prompt(&reports);

    let mut child = tokio::process::Command::new(claude_binary()?)
        .args(["-p", "--output-format", "stream-json", "--verbose"])
        .current_dir(std::env::temp_dir())
        .env("PATH", claude_search_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Other {
            message: format!("failed to spawn claude: {e}"),
        })?;

    // Register the PID before any await, same as run_triage, so an early STOP has something to
    // signal. TriageGuard removes the key on every exit path.
    let _guard = if let Some(pid) = child.id() {
        ctx.triages.lock().unwrap().insert(request_id.clone(), pid);
        Some(TriageGuard {
            triages: ctx.triages.clone(),
            report_id: request_id.clone(),
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

    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        use tokio::io::AsyncReadExt;
        let _ = reader.read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).into_owned()
    });

    let event_name = format!("duplicates:event:{request_id}");
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
                        if value.get("type").and_then(|v| v.as_str()) == Some("result")
                            && let Some(text) = value.get("result").and_then(|v| v.as_str())
                        {
                            final_result = Some(text.to_string());
                        }
                        let _ = app.emit(&event_name, &value);
                    }
                    Err(_) => {
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
    Ok(DuplicateResult {
        summary: raw.trim().to_owned(),
    })
}

// Stop an in-flight duplicate check. Identical mechanism to stop_triage — the PID lives in the
// same map, keyed by the duplicate check's request id.
#[tauri::command]
pub async fn stop_duplicates(ctx: State<'_, AppContext>, request_id: String) -> AppResult<bool> {
    let pid = ctx.triages.lock().unwrap().get(&request_id).copied();
    let Some(pid) = pid else {
        return Ok(false);
    };
    let rc = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    Ok(rc == 0)
}

// Delete one of the files claude wrote during a report's triage run, then drop it from the
// stored new-files list. Returns the remaining files. The path must be one of the report's
// recorded new files — we refuse to delete arbitrary paths the frontend hasn't been told about.
// A file that's already gone from disk is treated as success (it's still removed from the list).
#[tauri::command]
pub async fn delete_triage_file(
    ctx: State<'_, AppContext>,
    report_id: String,
    path: String,
) -> AppResult<Vec<String>> {
    let record = ctx
        .reports
        .get_triage(&report_id)?
        .ok_or_else(|| AppError::other("No triage record found for this report"))?;

    if !record.new_files.iter().any(|f| f == &path) {
        return Err(AppError::other(
            "That file is not one of this report's triage files",
        ));
    }

    match std::fs::remove_file(&path) {
        Ok(()) => {}
        // Already gone — fall through and prune it from the list anyway.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(AppError::other(format!("Failed to delete {path}: {e}"))),
    }

    let remaining: Vec<String> = record
        .new_files
        .into_iter()
        .filter(|f| f != &path)
        .collect();
    ctx.reports.set_triage_new_files(&report_id, &remaining)?;
    Ok(remaining)
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

// Show a native save-file dialog for arbitrary text content and, if the user confirms a path,
// write the text to disk. Returns true if a file was written, false if the user cancelled.
#[tauri::command]
pub async fn save_text_file(
    app: tauri::AppHandle,
    contents: String,
    suggested_filename: String,
) -> AppResult<bool> {
    use tauri_plugin_dialog::DialogExt;

    #[cfg(debug_assertions)]
    println!("[save] save dialog for {suggested_filename}");

    let path = app
        .dialog()
        .file()
        .set_file_name(&suggested_filename)
        .blocking_save_file();
    let Some(path) = path else {
        return Ok(false);
    };
    let path = path.into_path().map_err(AppError::other)?;

    std::fs::write(&path, contents.as_bytes()).map_err(AppError::other)?;
    Ok(true)
}

// A single named text document destined for a zip archive built by `save_zip_file`.
#[derive(serde::Deserialize)]
pub struct ZipEntry {
    pub filename: String,
    pub contents: String,
}

// Show a native save-file dialog and, if the user confirms a path, write the given named text
// documents into a single deflate-compressed zip archive at that path. Returns true if a file
// was written, false if the user cancelled.
#[tauri::command]
pub async fn save_zip_file(
    app: tauri::AppHandle,
    entries: Vec<ZipEntry>,
    suggested_filename: String,
) -> AppResult<bool> {
    use std::io::Write as _;
    use tauri_plugin_dialog::DialogExt;

    #[cfg(debug_assertions)]
    println!(
        "[save] zip save dialog for {suggested_filename} ({} entries)",
        entries.len()
    );

    let path = app
        .dialog()
        .file()
        .set_file_name(&suggested_filename)
        .blocking_save_file();
    let Some(path) = path else {
        return Ok(false);
    };
    let path = path.into_path().map_err(AppError::other)?;

    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut zip = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for entry in &entries {
            zip.start_file(&entry.filename, options)
                .map_err(AppError::other)?;
            zip.write_all(entry.contents.as_bytes())
                .map_err(AppError::other)?;
        }
        zip.finish().map_err(AppError::other)?;
    }

    std::fs::write(&path, cursor.into_inner()).map_err(AppError::other)?;
    Ok(true)
}
