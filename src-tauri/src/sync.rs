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
// Page size for the on-focus incremental refresh. Smaller than the 100-per-page backfill so each
// refresh request stays fast; the initial population and full backfills still use the 100 max.
const REFRESH_PAGE_SIZE: u32 = 50;
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

// The sync engine's only outward side effect, abstracted so the orchestration can be unit-tested
// without a Tauri runtime. Production forwards to the Tauri event bus; tests use a recorder.
pub trait SyncEvents: Send + Sync {
    fn status(&self, status: SyncStatus);
    fn changed(&self);
}

pub struct TauriSyncEvents(pub AppHandle);

impl SyncEvents for TauriSyncEvents {
    fn status(&self, status: SyncStatus) {
        let _ = self.0.emit("sync:status", status);
    }
    fn changed(&self) {
        let _ = self.0.emit("sync:changed", ());
    }
}

fn emit_status(events: &Arc<dyn SyncEvents>, phase: &str, done: i64, total: i64, running: bool) {
    events.status(SyncStatus {
        phase: phase.to_string(),
        done,
        total,
        running,
    });
}

fn emit_changed(events: &Arc<dyn SyncEvents>) {
    events.changed();
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
// detail backfill. The `running` flag guards against overlapping runs; setting `cancel` asks an
// in-flight run to stop before its next write (see `commands::log_out`, which wipes the mirror).
pub async fn run_sync(
    app: AppHandle,
    api: Arc<dyn HackerOneApi>,
    store: Arc<dyn ReportStore>,
    running: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    program_handle: String,
) {
    // compare_exchange: bail if a sync is already in flight.
    if running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    // A cancellation from a previous run has been honoured by now — this run starts clean.
    cancel.store(false, Ordering::SeqCst);
    let events: Arc<dyn SyncEvents> = Arc::new(TauriSyncEvents(app));
    let _ = run_sync_inner(&events, &api, &store, &cancel, &program_handle).await;
    running.store(false, Ordering::SeqCst);
    emit_status(&events, "idle", 0, 0, false);
}

fn cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::SeqCst)
}

async fn run_sync_inner(
    events: &Arc<dyn SyncEvents>,
    api: &Arc<dyn HackerOneApi>,
    store: &Arc<dyn ReportStore>,
    cancel: &Arc<AtomicBool>,
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
    emit_status(events, "initial", 0, 0, true);
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
    if cancelled(cancel) {
        return Ok(());
    }
    if let Some(page) = initial {
        store.upsert_summaries(program_handle, &page.items)?;
        emit_changed(events);
    }

    // --- Incremental update sync: reports touched since the last watermark. ---
    if let Some(watermark) = sync_state.update_watermark.clone() {
        incremental_sync(
            events,
            api,
            store,
            cancel,
            program_handle,
            &watermark,
            &mut sync_state,
        )
        .await?;
    }

    // --- Phase A: full summary backfill, oldest-first for pagination stability. ---
    if !sync_state.backfill_summaries_complete {
        backfill_summaries(events, api, store, cancel, program_handle, &mut sync_state).await?;
    }

    // --- Phase B: full detail backfill for any report lacking cached detail. Runs every sync,
    // not just until the first clean pass: the initial page and the incremental catch-up above
    // both mirror reports whose detail we haven't fetched, and the catch-up explicitly marks
    // touched reports' detail stale. It's a no-op once nothing is missing. ---
    backfill_detail(events, api, store, cancel, program_handle).await?;

    if cancelled(cancel) {
        return Ok(());
    }
    sync_state.last_sync_at = Some(now_marker());
    store.put_sync_state(&sync_state)?;
    Ok(())
}

async fn incremental_sync(
    events: &Arc<dyn SyncEvents>,
    api: &Arc<dyn HackerOneApi>,
    store: &Arc<dyn ReportStore>,
    cancel: &Arc<AtomicBool>,
    program_handle: &str,
    watermark: &str,
    sync_state: &mut SyncState,
) -> Result<(), AppError> {
    emit_status(events, "summaries", 0, 0, true);
    let mut cursor: Option<String> = None;
    let mut newest = sync_state.update_watermark.clone();
    let mut touched = 0i64;
    loop {
        let query = ReportQuery {
            program_handle: program_handle.to_string(),
            sort: Some("-reports.last_activity_at".to_string()),
            page_cursor: cursor.clone(),
            page_size: Some(REFRESH_PAGE_SIZE),
            ..Default::default()
        };
        let Some(page) = fetch_page(api, query).await else {
            break;
        };
        if cancelled(cancel) {
            return Ok(());
        }
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
            // No total to report: we don't know how many reports changed until we hit one that
            // predates the watermark.
            emit_status(events, "summaries", touched, 0, true);
        }
        if caught_up || page.next_cursor.is_none() {
            break;
        }
        cursor = page.next_cursor;
        tokio::time::sleep(std::time::Duration::from_millis(PAGE_DELAY_MS)).await;
    }
    if touched > 0 {
        emit_changed(events);
    }
    sync_state.update_watermark = newest;
    store.put_sync_state(sync_state)?;
    Ok(())
}

async fn backfill_summaries(
    events: &Arc<dyn SyncEvents>,
    api: &Arc<dyn HackerOneApi>,
    store: &Arc<dyn ReportStore>,
    cancel: &Arc<AtomicBool>,
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
        if cancelled(cancel) {
            return Ok(());
        }
        if !page.items.is_empty() {
            store.upsert_summaries(program_handle, &page.items)?;
            newest = max_activity(&page.items, newest);
            let total = store.count_reports(program_handle)?;
            emit_status(events, "summaries", total, total, true);
            emit_changed(events);
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
    emit_changed(events);
    Ok(())
}

async fn backfill_detail(
    events: &Arc<dyn SyncEvents>,
    api: &Arc<dyn HackerOneApi>,
    store: &Arc<dyn ReportStore>,
    cancel: &Arc<AtomicBool>,
    program_handle: &str,
) -> Result<(), AppError> {
    let ids = store.ids_missing_detail(program_handle)?;
    let total = store.count_reports(program_handle)?;
    let already = store.count_detail(program_handle)?;
    if ids.is_empty() {
        return Ok(());
    }

    let sem = Arc::new(tokio::sync::Semaphore::new(DETAIL_CONCURRENCY));
    let done = Arc::new(AtomicUsize::new(0));
    let mut set = tokio::task::JoinSet::new();

    for id in ids {
        if cancelled(cancel) {
            break;
        }
        let Ok(permit) = sem.clone().acquire_owned().await else {
            break;
        };
        let api = api.clone();
        let store = store.clone();
        let done = done.clone();
        let events = events.clone();
        let cancel = cancel.clone();
        let base = already;
        set.spawn(async move {
            let _permit = permit;
            // Best-effort per report: a single failure shouldn't abort the whole backfill. A
            // report we can't fetch stays detail-null and gets retried on the next launch.
            for attempt in 0..=MAX_RETRIES {
                match api.get_report(&id).await {
                    Ok(detail) => {
                        if !cancelled(&cancel) {
                            let _ = store.upsert_detail(&detail);
                        }
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
            emit_status(&events, "detail", base + n as i64, total, true);
            // Refresh the inbox periodically as detail lands (it reconciles summary columns).
            if n.is_multiple_of(25) {
                emit_changed(&events);
            }
        });
    }
    while set.join_next().await.is_some() {}

    emit_changed(events);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppResult;
    use crate::hackerone::{Activity, Organization, Program, ReportDetail, TeamMember, UserRef};
    use crate::local_db::SqliteStore;

    // A HackerOne API stand-in backed by a fixed set of summaries. list_reports serves them
    // according to the requested sort (open-only for the initial page; all reports otherwise),
    // and get_report synthesises a detail from the matching summary.
    struct MockApi {
        reports: Vec<ReportSummary>,
    }

    #[async_trait::async_trait]
    impl HackerOneApi for MockApi {
        async fn validate(&self) -> AppResult<()> {
            Ok(())
        }
        async fn list_organizations(&self) -> AppResult<Vec<Organization>> {
            Ok(vec![])
        }
        async fn list_programs(&self, _org_id: &str) -> AppResult<Vec<Program>> {
            Ok(vec![])
        }
        async fn list_program_members(&self, _program_id: &str) -> AppResult<Vec<TeamMember>> {
            Ok(vec![])
        }
        async fn list_reports(&self, query: ReportQuery) -> AppResult<ReportPage> {
            let sort = query.sort.as_deref().unwrap_or("");
            let mut items: Vec<ReportSummary> = if !query.states.is_empty() {
                // Initial page: filter to the requested (open) states.
                self.reports
                    .iter()
                    .filter(|r| query.states.contains(&r.state))
                    .cloned()
                    .collect()
            } else {
                self.reports.clone()
            };
            match sort {
                "reports.created_at" => items.sort_by(|a, b| a.created_at.cmp(&b.created_at)),
                "-reports.created_at" => items.sort_by(|a, b| b.created_at.cmp(&a.created_at)),
                "-reports.last_activity_at" => {
                    items.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at))
                }
                _ => {}
            }
            // Single page, no cursor — enough to exercise the orchestration.
            Ok(ReportPage {
                items,
                next_cursor: None,
            })
        }
        async fn get_report(&self, report_id: &str) -> AppResult<ReportDetail> {
            let s = self
                .reports
                .iter()
                .find(|r| r.id == report_id)
                .ok_or_else(|| AppError::NotFound {
                    message: report_id.into(),
                })?;
            Ok(ReportDetail {
                id: s.id.clone(),
                title: s.title.clone(),
                state: s.state.clone(),
                main_state: "open".into(),
                severity_rating: s.severity_rating.clone(),
                created_at: s.created_at.clone(),
                vulnerability_information: s.vulnerability_information.clone(),
                issue_tracker_reference_id: None,
                issue_tracker_reference_url: None,
                reporter: s.reporter.clone(),
                weakness: None,
                asset: None,
                inboxes: vec![],
                cve_ids: None,
                activities: vec![Activity::Comment {
                    id: format!("{}-c1", s.id),
                    created_at: s.created_at.clone(),
                    message: "hello".into(),
                    internal: false,
                    actor: None,
                    attachments: vec![],
                }],
                attachments: vec![],
            })
        }
    }

    struct NoopEvents;
    impl SyncEvents for NoopEvents {
        fn status(&self, _status: SyncStatus) {}
        fn changed(&self) {}
    }

    fn summary(id: &str, state: &str, last_activity: &str) -> ReportSummary {
        ReportSummary {
            id: id.to_string(),
            title: format!("report {id}"),
            vulnerability_information: format!("body {id}"),
            state: state.to_string(),
            severity_rating: Some("high".into()),
            created_at: format!("2024-01-{id:0>2}T00:00:00.000Z"),
            last_activity_at: Some(last_activity.to_string()),
            issue_tracker_reference_id: None,
            issue_tracker_reference_url: None,
            asset: None,
            weakness: None,
            reporter: UserRef {
                id: "u1".into(),
                username: "alice".into(),
                name: None,
                profile_picture_url: None,
            },
            assignee: None,
            inboxes: vec![],
            bounty: None,
        }
    }

    fn events() -> Arc<dyn SyncEvents> {
        Arc::new(NoopEvents)
    }

    fn no_cancel() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[tokio::test]
    async fn full_sync_mirrors_all_reports_and_detail() {
        let api: Arc<dyn HackerOneApi> = Arc::new(MockApi {
            reports: vec![
                summary("1", "new", "2024-02-01T00:00:00.000Z"),
                summary("2", "resolved", "2024-02-02T00:00:00.000Z"),
                summary("3", "triaged", "2024-02-03T00:00:00.000Z"),
            ],
        });
        let store: Arc<dyn ReportStore> = Arc::new(SqliteStore::in_memory());

        run_sync_inner(&events(), &api, &store, &no_cancel(), "wp")
            .await
            .unwrap();

        // All reports mirrored (open + closed), all detail hydrated.
        assert_eq!(store.count_reports("wp").unwrap(), 3);
        assert_eq!(store.count_detail("wp").unwrap(), 3);
        assert!(store.ids_missing_detail("wp").unwrap().is_empty());

        let state = store.get_sync_state().unwrap();
        assert!(state.backfill_summaries_complete);
        // Watermark advanced to the newest last_activity_at seen.
        assert_eq!(
            state.update_watermark.as_deref(),
            Some("2024-02-03T00:00:00.000Z")
        );

        // Cached detail reconstructs correctly.
        let detail = store.get_detail("3").unwrap().unwrap();
        assert_eq!(detail.main_state, "open");
        assert_eq!(detail.activities.len(), 1);
    }

    #[tokio::test]
    async fn detail_marked_stale_is_refetched_by_a_later_sync() {
        // A completed first sync must not stop later syncs from hydrating detail: the
        // incremental pass marks a touched report's detail stale, and only the detail pass
        // re-fetches it. Anything derived from the detail blob (bounty ineligibility, say)
        // stays wrong until it does.
        let api: Arc<dyn HackerOneApi> = Arc::new(MockApi {
            reports: vec![summary("1", "new", "2024-02-01T00:00:00.000Z")],
        });
        let store: Arc<dyn ReportStore> = Arc::new(SqliteStore::in_memory());
        run_sync_inner(&events(), &api, &store, &no_cancel(), "wp")
            .await
            .unwrap();
        assert_eq!(store.count_detail("wp").unwrap(), 1);

        store.mark_detail_stale(&["1"]).unwrap();
        assert_eq!(store.count_detail("wp").unwrap(), 0);

        run_sync_inner(&events(), &api, &store, &no_cancel(), "wp")
            .await
            .unwrap();
        assert_eq!(store.count_detail("wp").unwrap(), 1);
        assert!(store.ids_missing_detail("wp").unwrap().is_empty());
    }

    // A cancelled sync must not write: `log_out` cancels before wiping the mirror, so a write
    // from a run that already has the API's response in hand would resurrect deleted reports.
    #[tokio::test]
    async fn a_cancelled_sync_mirrors_nothing() {
        let api: Arc<dyn HackerOneApi> = Arc::new(MockApi {
            reports: vec![summary("1", "new", "2024-02-01T00:00:00.000Z")],
        });
        let store: Arc<dyn ReportStore> = Arc::new(SqliteStore::in_memory());
        let cancel = Arc::new(AtomicBool::new(true));

        run_sync_inner(&events(), &api, &store, &cancel, "wp")
            .await
            .unwrap();

        assert_eq!(store.count_reports("wp").unwrap(), 0);
    }

    #[tokio::test]
    async fn incremental_sync_only_takes_reports_newer_than_watermark() {
        // Two reports active after the watermark, one before → only the two are taken.
        let api: Arc<dyn HackerOneApi> = Arc::new(MockApi {
            reports: vec![
                summary("1", "new", "2024-05-10T00:00:00.000Z"),
                summary("2", "new", "2024-05-09T00:00:00.000Z"),
                summary("3", "new", "2024-04-01T00:00:00.000Z"),
            ],
        });
        let store: Arc<dyn ReportStore> = Arc::new(SqliteStore::in_memory());
        let mut sync_state = SyncState {
            program_handle: Some("wp".into()),
            update_watermark: Some("2024-05-01T00:00:00.000Z".into()),
            ..Default::default()
        };

        incremental_sync(
            &events(),
            &api,
            &store,
            &no_cancel(),
            "wp",
            "2024-05-01T00:00:00.000Z",
            &mut sync_state,
        )
        .await
        .unwrap();

        // Reports 1 and 2 (after the watermark) were mirrored; report 3 (before) was not.
        assert_eq!(store.count_reports("wp").unwrap(), 2);
        assert!(store.get_detail("3").unwrap().is_none());
        assert_eq!(
            sync_state.update_watermark.as_deref(),
            Some("2024-05-10T00:00:00.000Z")
        );
    }
}
