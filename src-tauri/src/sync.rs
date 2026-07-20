use crate::error::AppError;
use crate::hackerone::{HackerOneApi, ReportPage, ReportQuery, ReportSummary};
use crate::local_db::{ReportStore, SyncState};
use serde::Serialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter};

// Open states, as the HackerOne API spells them. The initial page only pulls these so launch
// mirrors the pre-DB behaviour (latest open reports first).
const OPEN_STATES: &[&str] = &[
    "new",
    "needs-more-info",
    "triaged",
    "retesting",
    "pending-program-review",
];

const PAGE_DELAY_MS: u64 = 150;
const DETAIL_CONCURRENCY: usize = 5;
const RATE_LIMIT_BACKOFF_MS: u64 = 5_000;
const MAX_RETRIES: u32 = 4;

// Progress payload emitted on the `sync:status` event for the Topbar indicator.
#[derive(Clone, Serialize)]
pub struct SyncStatus {
    // "initial" | "summaries" | "detail" | "idle"
    pub phase: String,
    pub done: i64,
    pub total: i64,
    pub running: bool,
}

fn emit_status(app: &AppHandle, phase: &str, done: i64, total: i64, running: bool) {
    let _ = app.emit(
        "sync:status",
        SyncStatus {
            phase: phase.to_string(),
            done,
            total,
            running,
        },
    );
}

// Tell the frontend the local DB changed so it re-runs the active query.
fn emit_changed(app: &AppHandle) {
    let _ = app.emit("sync:changed", ());
}

// Fetch one report page, retrying on rate-limit / transient network errors with a fixed backoff.
async fn fetch_page(api: &Arc<dyn HackerOneApi>, query: ReportQuery) -> Option<ReportPage> {
    let mut attempt = 0;
    loop {
        match api.list_reports(query.clone()).await {
            Ok(page) => return Some(page),
            Err(AppError::RateLimited { .. }) | Err(AppError::Network { .. })
                if attempt < MAX_RETRIES =>
            {
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_millis(
                    RATE_LIMIT_BACKOFF_MS * attempt as u64,
                ))
                .await;
            }
            Err(_) => return None,
        }
    }
}

fn max_activity(items: &[ReportSummary], current: Option<String>) -> Option<String> {
    let mut best = current;
    for it in items {
        if let Some(ts) = &it.last_activity_at {
            match &best {
                Some(b) if b >= ts => {}
                _ => best = Some(ts.clone()),
            }
        }
    }
    best
}

// Drive a full sync of `program_handle`: an initial open-reports page (fast, blocks first paint),
// then in the background an incremental update catch-up, a full summary backfill, and a full
// detail backfill. The `running` flag guards against overlapping runs.
pub async fn run_sync(
    app: AppHandle,
    api: Arc<dyn HackerOneApi>,
    store: Arc<dyn ReportStore>,
    running: Arc<AtomicBool>,
    program_handle: String,
) {
    // compare_exchange: bail if a sync is already in flight.
    if running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let _ = run_sync_inner(&app, &api, &store, &program_handle).await;
    running.store(false, Ordering::SeqCst);
    emit_status(&app, "idle", 0, 0, false);
}

async fn run_sync_inner(
    app: &AppHandle,
    api: &Arc<dyn HackerOneApi>,
    store: &Arc<dyn ReportStore>,
    program_handle: &str,
) -> Result<(), AppError> {
    let mut sync_state = store.get_sync_state()?;
    // A handle change (different program than last synced) resets the backfill flags — the new
    // program's reports haven't been mirrored yet.
    if sync_state.program_handle.as_deref() != Some(program_handle) {
        sync_state = SyncState {
            program_handle: Some(program_handle.to_string()),
            ..Default::default()
        };
        store.put_sync_state(&sync_state)?;
    }

    // --- Initial page: latest open reports, mirrors the pre-DB launch view. ---
    emit_status(app, "initial", 0, 0, true);
    let initial = fetch_page(
        api,
        ReportQuery {
            program_handle: program_handle.to_string(),
            states: OPEN_STATES.iter().map(|s| s.to_string()).collect(),
            sort: Some("-reports.created_at".to_string()),
            ..Default::default()
        },
    )
    .await;
    if let Some(page) = initial {
        store.upsert_summaries(program_handle, &page.items)?;
        emit_changed(app);
    }

    // --- Incremental update sync: reports touched since the last watermark. ---
    if let Some(watermark) = sync_state.update_watermark.clone() {
        incremental_sync(app, api, store, program_handle, &watermark, &mut sync_state).await?;
    }

    // --- Phase A: full summary backfill, oldest-first for pagination stability. ---
    if !sync_state.backfill_summaries_complete {
        backfill_summaries(app, api, store, program_handle, &mut sync_state).await?;
    }

    // --- Phase B: full detail backfill for any report lacking cached detail. ---
    if !sync_state.backfill_detail_complete {
        backfill_detail(app, api, store, program_handle, &mut sync_state).await?;
    }

    sync_state.last_sync_at = Some(now_marker());
    store.put_sync_state(&sync_state)?;
    Ok(())
}

async fn incremental_sync(
    app: &AppHandle,
    api: &Arc<dyn HackerOneApi>,
    store: &Arc<dyn ReportStore>,
    program_handle: &str,
    watermark: &str,
    sync_state: &mut SyncState,
) -> Result<(), AppError> {
    emit_status(app, "summaries", 0, 0, true);
    let mut cursor: Option<String> = None;
    let mut newest = sync_state.update_watermark.clone();
    let mut touched = 0i64;
    loop {
        let query = ReportQuery {
            program_handle: program_handle.to_string(),
            sort: Some("-reports.last_activity_at".to_string()),
            page_cursor: cursor.clone(),
            ..Default::default()
        };
        let Some(page) = fetch_page(api, query).await else {
            break;
        };
        if page.items.is_empty() {
            break;
        }
        // Keep only reports whose activity is strictly newer than the watermark; the first one
        // that isn't means we've caught up (results are sorted newest-activity-first).
        let fresh: Vec<ReportSummary> = page
            .items
            .iter()
            .filter(|r| {
                r.last_activity_at
                    .as_deref()
                    .map(|t| t > watermark)
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        let caught_up = fresh.len() < page.items.len();
        if !fresh.is_empty() {
            store.upsert_summaries(program_handle, &fresh)?;
            let ids: Vec<&str> = fresh.iter().map(|r| r.id.as_str()).collect();
            // Their detail may have changed too — force a re-fetch on the detail pass.
            store.mark_detail_stale(&ids)?;
            newest = max_activity(&fresh, newest);
            touched += fresh.len() as i64;
        }
        if caught_up || page.next_cursor.is_none() {
            break;
        }
        cursor = page.next_cursor;
        tokio::time::sleep(std::time::Duration::from_millis(PAGE_DELAY_MS)).await;
    }
    if touched > 0 {
        emit_changed(app);
    }
    sync_state.update_watermark = newest;
    store.put_sync_state(sync_state)?;
    Ok(())
}

async fn backfill_summaries(
    app: &AppHandle,
    api: &Arc<dyn HackerOneApi>,
    store: &Arc<dyn ReportStore>,
    program_handle: &str,
    sync_state: &mut SyncState,
) -> Result<(), AppError> {
    let mut cursor: Option<String> = None;
    let mut newest = sync_state.update_watermark.clone();
    loop {
        let query = ReportQuery {
            program_handle: program_handle.to_string(),
            // Oldest-first: reports created mid-backfill append to the end and can't shift a
            // page we've already read, so no row is skipped.
            sort: Some("reports.created_at".to_string()),
            page_cursor: cursor.clone(),
            ..Default::default()
        };
        let Some(page) = fetch_page(api, query).await else {
            break;
        };
        if !page.items.is_empty() {
            store.upsert_summaries(program_handle, &page.items)?;
            newest = max_activity(&page.items, newest);
            let total = store.count_reports(program_handle)?;
            emit_status(app, "summaries", total, total, true);
            emit_changed(app);
        }
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
        tokio::time::sleep(std::time::Duration::from_millis(PAGE_DELAY_MS)).await;
    }
    sync_state.backfill_summaries_complete = true;
    // The watermark is only meaningful once we've seen every report at least once.
    sync_state.update_watermark = newest;
    store.put_sync_state(sync_state)?;
    emit_changed(app);
    Ok(())
}

async fn backfill_detail(
    app: &AppHandle,
    api: &Arc<dyn HackerOneApi>,
    store: &Arc<dyn ReportStore>,
    program_handle: &str,
    sync_state: &mut SyncState,
) -> Result<(), AppError> {
    let ids = store.ids_missing_detail(program_handle)?;
    let total = store.count_reports(program_handle)?;
    let already = store.count_detail(program_handle)?;
    if ids.is_empty() {
        sync_state.backfill_detail_complete = true;
        store.put_sync_state(sync_state)?;
        return Ok(());
    }

    let sem = Arc::new(tokio::sync::Semaphore::new(DETAIL_CONCURRENCY));
    let done = Arc::new(AtomicUsize::new(0));
    let mut set = tokio::task::JoinSet::new();

    for id in ids {
        let Ok(permit) = sem.clone().acquire_owned().await else {
            break;
        };
        let api = api.clone();
        let store = store.clone();
        let done = done.clone();
        let app = app.clone();
        let base = already;
        set.spawn(async move {
            let _permit = permit;
            // Best-effort per report: a single failure shouldn't abort the whole backfill. A
            // report we can't fetch stays detail-null and gets retried on the next launch.
            for attempt in 0..=MAX_RETRIES {
                match api.get_report(&id).await {
                    Ok(detail) => {
                        let _ = store.upsert_detail(&detail);
                        break;
                    }
                    Err(AppError::RateLimited { .. }) | Err(AppError::Network { .. })
                        if attempt < MAX_RETRIES =>
                    {
                        tokio::time::sleep(std::time::Duration::from_millis(
                            RATE_LIMIT_BACKOFF_MS * (attempt as u64 + 1),
                        ))
                        .await;
                    }
                    Err(_) => break,
                }
            }
            let n = done.fetch_add(1, Ordering::SeqCst) + 1;
            emit_status(&app, "detail", base + n as i64, total, true);
            // Refresh the inbox periodically as detail lands (it reconciles summary columns).
            if n.is_multiple_of(25) {
                emit_changed(&app);
            }
        });
    }
    while set.join_next().await.is_some() {}

    // Only mark complete when nothing is still missing — a report that erred every retry stays
    // null and keeps the flag off so the next launch tries again.
    if store.ids_missing_detail(program_handle)?.is_empty() {
        sync_state.backfill_detail_complete = true;
    }
    store.put_sync_state(sync_state)?;
    emit_changed(app);
    Ok(())
}

// Opaque timestamp marker for last_sync_at bookkeeping (never parsed back).
fn now_marker() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("@{secs}")
}
