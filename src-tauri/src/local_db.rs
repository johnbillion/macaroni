use crate::db_key::DbKey;
use crate::error::{AppError, AppResult};
use crate::hackerone::{Activity, Attachment, InboxRef, ReportDetail, ReportSummary, UserRef};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use zeroize::Zeroize;

#[derive(Debug, Clone, Serialize)]
pub struct TriageRecord {
    pub summary: String,
    pub validity: Option<String>,
    // Absolute paths to files claude wrote during the run. May be empty.
    pub new_files: Vec<String>,
    // The `claude` session the run happened in, so it can be resumed from the terminal. `None`
    // for triages saved before this was recorded, or if the run emitted no session id.
    pub session_id: Option<String>,
}

// Persisted progress of the background sync engine (see sync.rs). A single row keyed to the
// program handle currently mirrored into the DB. `update_watermark` is the newest
// `last_activity_at` seen across all synced reports — the incremental poll fetches everything
// updated after it.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncState {
    pub program_handle: Option<String>,
    pub backfill_summaries_complete: bool,
    pub update_watermark: Option<String>,
    pub last_sync_at: Option<String>,
}

// Filter for a local report query. Empty vecs mean "no constraint on this field". `severities`
// may contain the UI-only "unrated" sentinel, which matches reports with a null severity_rating.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct LocalQuery {
    pub program_handle: String,
    #[serde(default)]
    pub states: Vec<String>,
    #[serde(default)]
    pub severities: Vec<String>,
    // Asset *identifiers* (e.g. "bbPress Core"), not the sidebar's numeric asset ids — see the
    // asset_identifier generated column for why.
    #[serde(default)]
    pub asset_identifiers: Vec<String>,
    #[serde(default)]
    pub assignees: Vec<String>,
    // Inbox *ids*. A report matches when any of its inboxes has one of these ids. There's no
    // HackerOne API to filter reports by inbox, so this is done entirely in SQL over the
    // `$.inboxes` array in each report's summary blob.
    #[serde(default)]
    pub inbox_ids: Vec<String>,
    #[serde(default)]
    pub keyword: Option<String>,
    // When set, each keyword term matches only at word boundaries (so "RCE" no longer
    // matches "source").
    #[serde(default)]
    pub whole_words: bool,
}

// A row of the inbox list: the report's summary blob plus the one list-level fact that isn't in
// it. Whether a report has been marked not eligible for a bounty is recorded by HackerOne only as
// an `activity-not-eligible-for-bounty` event, which the /reports list endpoint doesn't carry — so
// it's derived on read from the detail blob's activities rather than stored anywhere. Flattened,
// so the frontend sees one flat report object.
#[derive(Debug, Clone, Serialize)]
pub struct ReportListItem {
    #[serde(flatten)]
    pub summary: ReportSummary,
    pub bounty_ineligible: bool,
}

// A row of the discussion feed: one comment, with just enough of its report to identify it. Every
// field is read out of data the mirror already holds — the comment out of the report's detail blob,
// the title out of its summary blob — so nothing is fetched or stored for this view.
#[derive(Debug, Clone, Serialize)]
pub struct CommentListItem {
    // The activity id, which is also the scroll target in the detail pane's thread.
    pub id: String,
    pub report_id: String,
    pub report_title: String,
    pub created_at: String,
    pub message: String,
    pub internal: bool,
    pub actor: Option<UserRef>,
}

pub trait ReportStore: Send + Sync {
    // Insert or update the list-level data for a batch of reports (the summary shape from the
    // /reports endpoint). Only the blob is written; the queryable columns derive from it.
    fn upsert_summaries(&self, program_handle: &str, items: &[ReportSummary]) -> AppResult<()>;
    // Store a report's full detail (activities, attachments) and patch the overlapping fields
    // into the summary blob so the inbox row reflects the freshest data. The program handle is
    // taken from the existing row (the report has always been seen at list level first).
    fn upsert_detail(&self, detail: &ReportDetail) -> AppResult<()>;
    // Run a filtered query against the local DB, newest-created first. Returns every match.
    fn query(&self, q: &LocalQuery) -> AppResult<Vec<ReportListItem>>;
    // The newest `limit` comments across every report stored for a program, regardless of report
    // state. Derived on read by expanding the activities in each report's detail blob — comments
    // are neither stored nor indexed separately.
    fn recent_comments(&self, program_handle: &str, limit: i64) -> AppResult<Vec<CommentListItem>>;
    // Distinct inboxes across every report stored for a program, sorted by name. Drives the
    // sidebar inbox filter — HackerOne has no endpoint to enumerate a program's inboxes, so the
    // set is derived from the inboxes seen on synced reports.
    fn distinct_inboxes(&self, program_handle: &str) -> AppResult<Vec<InboxRef>>;
    // Handles of every program with reports mirrored locally, sorted. Lets the frontend pick the
    // program at launch without waiting for the HackerOne programs endpoint.
    fn distinct_program_handles(&self) -> AppResult<Vec<String>>;
    // Distinct asset identifiers across a program's synced reports, sorted. Drives the sidebar
    // asset filter, which matches on the identifier anyway — see the asset_identifier column.
    // Assets with only a single report are omitted: filtering to one report isn't worth a facet.
    fn distinct_asset_identifiers(&self, program_handle: &str) -> AppResult<Vec<String>>;
    // The cached full detail for a report, if we've fetched it before.
    fn get_detail(&self, id: &str) -> AppResult<Option<ReportDetail>>;
    // Ids of reports for this program that have no cached detail yet (drives detail backfill).
    fn ids_missing_detail(&self, program_handle: &str) -> AppResult<Vec<String>>;
    // Clear the cached-detail marker for a set of reports so the detail backfill re-fetches them
    // (used when the incremental poll sees a report's activity advance).
    fn mark_detail_stale(&self, ids: &[&str]) -> AppResult<()>;
    // Total reports stored for a program, and how many of those have cached detail.
    fn count_reports(&self, program_handle: &str) -> AppResult<i64>;
    fn count_detail(&self, program_handle: &str) -> AppResult<i64>;
    // Drop every mirrored report (with its triage) and the sync bookkeeping, reclaiming the
    // freed pages. Backs "log out and delete the local database"; the mirror is fully
    // reconstructible from the API, so nothing here is unrecoverable.
    fn wipe(&self) -> AppResult<()>;

    fn get_sync_state(&self) -> AppResult<SyncState>;
    fn put_sync_state(&self, state: &SyncState) -> AppResult<()>;

    fn get_triage(&self, id: &str) -> AppResult<Option<TriageRecord>>;
    fn set_triage(
        &self,
        id: &str,
        summary: &str,
        validity: Option<&str>,
        new_files: &[String],
        session_id: Option<&str>,
    ) -> AppResult<()>;
    // Overwrite just the stored new-files list for a report (used after a file is deleted).
    fn set_triage_new_files(&self, id: &str, new_files: &[String]) -> AppResult<()>;
    // For the subset of `ids` that have a triage saved, return (id, validity).
    fn list_triage_validity(&self, ids: &[&str]) -> AppResult<Vec<(String, Option<String>)>>;
}

pub struct SqliteStore {
    conn: Mutex<Connection>,
}

// The report's data lives in exactly one place per record: the `summary_json` blob (list-level
// fields) and the `detail_json` blob (activities/attachments). Everything the app filters or
// sorts on is a VIRTUAL generated column derived from `summary_json` via json_extract — computed
// on read, never stored, so no field value is duplicated. Only the indexes over those generated
// columns hold copies, which is what an index is. The non-blob real columns are the primary key,
// the program handle (context attached at sync time — not part of the report JSON), local sync
// bookkeeping, and triage data (ours, not HackerOne's).
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS reports (
    id                TEXT PRIMARY KEY,
    program_handle    TEXT NOT NULL,
    summary_json      TEXT NOT NULL,
    detail_json       TEXT,
    detail_fetched_at TEXT,
    triage            TEXT,
    triage_validity   TEXT,
    triage_new_files  TEXT,
    triage_session_id TEXT,

    state            TEXT GENERATED ALWAYS AS (json_extract(summary_json, '$.state')) VIRTUAL,
    severity_rating  TEXT GENERATED ALWAYS AS (json_extract(summary_json, '$.severity_rating')) VIRTUAL,
    created_at       TEXT GENERATED ALWAYS AS (json_extract(summary_json, '$.created_at')) VIRTUAL,
    last_activity_at TEXT GENERATED ALWAYS AS (json_extract(summary_json, '$.last_activity_at')) VIRTUAL,
    -- The report's structured_scope carries the asset *identifier* (e.g. \"bbPress Core\"), which
    -- is what the assets endpoint keys on too — the numeric structured_scope id does NOT match the
    -- asset id the sidebar filters by, so we match on the identifier.
    asset_identifier TEXT GENERATED ALWAYS AS (json_extract(summary_json, '$.asset.asset_identifier')) VIRTUAL,
    assignee_token   TEXT GENERATED ALWAYS AS (
        CASE WHEN json_extract(summary_json, '$.assignee.type') = 'group'
             THEN json_extract(summary_json, '$.assignee.name')
             ELSE json_extract(summary_json, '$.assignee.username') END) VIRTUAL
);
CREATE INDEX IF NOT EXISTS reports_program ON reports(program_handle);
CREATE INDEX IF NOT EXISTS reports_state ON reports(state);
CREATE INDEX IF NOT EXISTS reports_created ON reports(created_at);
CREATE INDEX IF NOT EXISTS reports_last_activity ON reports(last_activity_at);
CREATE INDEX IF NOT EXISTS reports_assignee ON reports(assignee_token);

CREATE TABLE IF NOT EXISTS sync_state (
    id                          INTEGER PRIMARY KEY CHECK (id = 1),
    program_handle              TEXT,
    backfill_summaries_complete INTEGER NOT NULL DEFAULT 0,
    update_watermark            TEXT,
    last_sync_at                TEXT
);
";

impl SqliteStore {
    pub fn open(path: &Path, key: &DbKey) -> AppResult<Self> {
        migrate_plaintext(path, key)?;
        let conn = Connection::open(path).map_err(AppError::other)?;
        // 0600 before WAL mode is enabled, so the -wal/-shm sidecars (which SQLite creates
        // with the main file's permissions) are born restricted too.
        restrict_permissions(path);
        apply_key(&conn, key)?;
        // Probe before touching the schema: with a wrong key every statement fails with the
        // unhelpful "file is not a database", so turn it into something actionable.
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
            .map_err(|_| AppError::Other {
                message: format!(
                    "the local database at {} cannot be decrypted with the key in the keychain; \
                     delete it to re-sync from scratch",
                    path.display()
                ),
            })?;
        // WAL keeps background sync writes from blocking foreground queries; busy_timeout gives
        // any contended lock a moment to clear rather than erroring out immediately.
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(AppError::other)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(AppError::other)?;
        conn.execute_batch(SCHEMA).map_err(AppError::other)?;
        // Idempotent migration: databases created before `asset_identifier` existed get the
        // VIRTUAL generated column added in place (no row rewrite). Errors when it already
        // exists, which we ignore. Its index is created afterwards, once the column is present.
        let _ = conn.execute(
            "ALTER TABLE reports ADD COLUMN asset_identifier TEXT
             GENERATED ALWAYS AS (json_extract(summary_json, '$.asset.asset_identifier')) VIRTUAL",
            [],
        );
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS reports_asset ON reports(asset_identifier);",
        )
        .map_err(AppError::other)?;
        // Same idempotent-migration trick for the triage session id, added after the triage
        // columns shipped. Existing rows keep a NULL — those runs' sessions aren't recoverable.
        let _ = conn.execute("ALTER TABLE reports ADD COLUMN triage_session_id TEXT", []);
        register_word_match(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    // Test-only in-memory store for unit tests in this crate (schema only, no WAL).
    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(SCHEMA).expect("init schema");
        register_word_match(&conn).expect("register word_match");
        Self {
            conn: Mutex::new(conn),
        }
    }
}

fn apply_key(conn: &Connection, key: &DbKey) -> AppResult<()> {
    let mut keyspec = key.keyspec();
    let result = conn.pragma_update(None, "key", &keyspec);
    keyspec.zeroize();
    // Never stringify this error wholesale: rusqlite's `SqlInputError` embeds the offending SQL,
    // which here is the `PRAGMA key` statement carrying the raw key.
    result.map_err(|e| AppError::Other {
        message: match e {
            rusqlite::Error::SqliteFailure(code, msg) => format!(
                "failed to apply the database key: sqlite error {} ({})",
                code.extended_code,
                msg.as_deref().unwrap_or("no detail")
            ),
            _ => "failed to apply the database key".to_string(),
        },
    })
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_owned();
    os.push(suffix);
    PathBuf::from(os)
}

// The database holds the full text of every report in the program, so it must not be readable
// by other local user accounts. Same-user processes are out of scope here — that's what the
// encryption is for.
#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    for p in [
        path.to_path_buf(),
        sidecar(path, "-wal"),
        sidecar(path, "-shm"),
    ] {
        if p.exists() {
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
        }
    }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

// Databases created before encryption shipped are plaintext SQLite, identified by the magic
// header (an encrypted database's first page is indistinguishable from random bytes). Export
// into an encrypted copy with sqlcipher_export and swap it into place. The plaintext pages
// linger on unallocated disk sectors afterwards; full-disk encryption is the floor there.
fn migrate_plaintext(path: &Path, key: &DbKey) -> AppResult<()> {
    use std::io::Read;
    let mut header = [0u8; 16];
    match std::fs::File::open(path) {
        Ok(mut f) => {
            if f.read_exact(&mut header).is_err() || &header != b"SQLite format 3\0" {
                return Ok(());
            }
        }
        Err(_) => return Ok(()),
    }

    let tmp = sidecar(path, ".migrating");
    let _ = std::fs::remove_file(&tmp);
    let plain = Connection::open(path).map_err(AppError::other)?;
    let mut keyspec = key.keyspec();
    let attached = plain.execute(
        "ATTACH DATABASE ?1 AS encrypted KEY ?2",
        params![tmp.to_string_lossy().into_owned(), keyspec],
    );
    keyspec.zeroize();
    attached.map_err(AppError::other)?;
    plain
        .query_row("SELECT sqlcipher_export('encrypted')", [], |_| Ok(()))
        .map_err(AppError::other)?;
    plain
        .execute("DETACH DATABASE encrypted", [])
        .map_err(AppError::other)?;
    drop(plain);
    std::fs::rename(&tmp, path).map_err(AppError::other)?;
    // The encrypted copy never had these sidecars; any left behind are plaintext remnants.
    let _ = std::fs::remove_file(sidecar(path, "-wal"));
    let _ = std::fs::remove_file(sidecar(path, "-shm"));
    Ok(())
}

// Best-effort, macOS only: the mirror is fully reconstructible from the API, so there's no
// reason for report contents to propagate into Time Machine backups. The exclusion is an
// xattr on the file, so it's re-applied every launch (sidecars get deleted and recreated).
#[cfg(target_os = "macos")]
pub fn exclude_from_backups(path: &Path) {
    let paths: Vec<PathBuf> = [
        path.to_path_buf(),
        sidecar(path, "-wal"),
        sidecar(path, "-shm"),
    ]
    .into_iter()
    .filter(|p| p.exists())
    .collect();
    if paths.is_empty() {
        return;
    }
    let status = std::process::Command::new("tmutil")
        .arg("addexclusion")
        .args(&paths)
        .status();
    if !matches!(status, Ok(s) if s.success()) {
        log::warn!("failed to exclude the local database from Time Machine backups");
    }
}

#[cfg(not(target_os = "macos"))]
pub fn exclude_from_backups(_path: &Path) {}

fn summary_from_row(json: &str) -> Option<ReportSummary> {
    serde_json::from_str(json).ok()
}

// Case-insensitive whole-word match: the term must appear in the haystack with no letter,
// digit, or underscore immediately on either side. Backs the `word_match` SQL function.
fn word_match(term: &str, haystack: &str) -> bool {
    let term = term.to_lowercase();
    if term.is_empty() {
        return false;
    }
    let hay = haystack.to_lowercase();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut start = 0;
    while let Some(pos) = hay[start..].find(&term) {
        let at = start + pos;
        let before_ok = hay[..at].chars().next_back().is_none_or(|c| !is_word(c));
        let after_ok = hay[at + term.len()..]
            .chars()
            .next()
            .is_none_or(|c| !is_word(c));
        if before_ok && after_ok {
            return true;
        }
        // Advance one character, not one term-length — occurrences can overlap.
        start = at + hay[at..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

// Make `word_match(term, text)` available to SQL. NULL text (e.g. a report with no
// description) is simply no match, mirroring how LIKE treats NULL.
fn register_word_match(conn: &Connection) -> AppResult<()> {
    conn.create_scalar_function(
        "word_match",
        2,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let term = ctx.get::<String>(0)?;
            let hay = ctx.get::<Option<String>>(1)?;
            Ok(hay.is_some_and(|h| word_match(&term, &h)))
        },
    )
    .map_err(AppError::other)
}

// Escape LIKE wildcards so a user's keyword is matched literally, and wrap it as a substring
// pattern. Paired with `ESCAPE '\\'` in the SQL.
fn like_pattern(term: &str) -> String {
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

impl SqliteStore {
    // Writing a report is just storing the blob (plus the program handle it belongs to). Every
    // queryable column derives from `summary_json`, so there's nothing else to write.
    fn upsert_one_summary(
        conn: &Connection,
        program_handle: &str,
        s: &ReportSummary,
    ) -> AppResult<()> {
        let summary_json = serde_json::to_string(s).map_err(AppError::other)?;
        conn.execute(
            "INSERT INTO reports (id, program_handle, summary_json) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
                program_handle = excluded.program_handle,
                summary_json = excluded.summary_json",
            params![s.id, program_handle, summary_json],
        )
        .map_err(AppError::other)?;
        Ok(())
    }
}

impl ReportStore for SqliteStore {
    fn upsert_summaries(&self, program_handle: &str, items: &[ReportSummary]) -> AppResult<()> {
        if items.is_empty() {
            return Ok(());
        }
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction().map_err(AppError::other)?;
        for s in items {
            Self::upsert_one_summary(&tx, program_handle, s)?;
        }
        tx.commit().map_err(AppError::other)?;
        Ok(())
    }

    fn upsert_detail(&self, detail: &ReportDetail) -> AppResult<()> {
        // `detail_json` stores ONLY the fields the summary blob doesn't already have — activities,
        // attachments, and main_state. Everything else is refreshed into `summary_json` (the single
        // source of truth for those fields) so there's no value stored in two places.
        let extra = ReportDetailExtra {
            main_state: detail.main_state.clone(),
            cve_ids: detail.cve_ids.clone(),
            activities: detail.activities.clone(),
            attachments: detail.attachments.clone(),
        };
        let extra_json = serde_json::to_string(&extra).map_err(AppError::other)?;
        let c = self.conn.lock().unwrap();

        // Refresh the summary blob's shared fields from this fresher detail. Build one from the
        // detail if we've somehow never seen this report at list level.
        let existing: Option<(String, String)> = c
            .query_row(
                "SELECT program_handle, summary_json FROM reports WHERE id = ?1",
                params![detail.id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(AppError::other)?;

        let program_handle = existing
            .as_ref()
            .map(|(h, _)| h.clone())
            .unwrap_or_default();
        let mut summary = existing
            .as_ref()
            .and_then(|(_, j)| summary_from_row(j))
            .unwrap_or_else(|| summary_from_detail(detail));
        summary.title = detail.title.clone();
        summary.state = detail.state.clone();
        summary.severity_rating = detail.severity_rating.clone();
        summary.vulnerability_information = detail.vulnerability_information.clone();
        summary.issue_tracker_reference_id = detail.issue_tracker_reference_id.clone();
        summary.issue_tracker_reference_url = detail.issue_tracker_reference_url.clone();
        summary.reporter = detail.reporter.clone();
        summary.weakness = detail.weakness.clone();
        summary.asset = detail.asset.clone();
        summary.inboxes = detail.inboxes.clone();

        Self::upsert_one_summary(&c, &program_handle, &summary)?;
        c.execute(
            "UPDATE reports SET detail_json = ?2, detail_fetched_at = ?3 WHERE id = ?1",
            params![detail.id, extra_json, now_iso()],
        )
        .map_err(AppError::other)?;
        Ok(())
    }

    fn query(&self, q: &LocalQuery) -> AppResult<Vec<ReportListItem>> {
        let c = self.conn.lock().unwrap();
        let mut sql = String::from(
            "SELECT summary_json,
                    EXISTS (SELECT 1 FROM json_each(detail_json, '$.activities')
                            WHERE json_extract(value, '$.kind') = 'not-eligible-for-bounty')
             FROM reports WHERE program_handle = ?1",
        );
        let mut binds: Vec<String> = vec![q.program_handle.clone()];

        if !q.states.is_empty() {
            let ph = placeholders(binds.len(), q.states.len());
            sql.push_str(&format!(" AND state IN ({ph})"));
            binds.extend(q.states.iter().cloned());
        }
        if !q.severities.is_empty() {
            let rated: Vec<&String> = q.severities.iter().filter(|s| *s != "unrated").collect();
            let include_unrated = q.severities.iter().any(|s| s == "unrated");
            let mut clauses: Vec<String> = Vec::new();
            if !rated.is_empty() {
                let ph = placeholders(binds.len(), rated.len());
                clauses.push(format!("severity_rating IN ({ph})"));
                binds.extend(rated.into_iter().cloned());
            }
            if include_unrated {
                clauses.push("severity_rating IS NULL".to_string());
            }
            if !clauses.is_empty() {
                sql.push_str(&format!(" AND ({})", clauses.join(" OR ")));
            }
        }
        if !q.asset_identifiers.is_empty() {
            let ph = placeholders(binds.len(), q.asset_identifiers.len());
            sql.push_str(&format!(" AND asset_identifier IN ({ph})"));
            binds.extend(q.asset_identifiers.iter().cloned());
        }
        if !q.assignees.is_empty() {
            let ph = placeholders(binds.len(), q.assignees.len());
            sql.push_str(&format!(" AND assignee_token IN ({ph})"));
            binds.extend(q.assignees.iter().cloned());
        }
        // A report matches when any of its inboxes (a JSON array in the summary blob) has one of
        // the selected ids. json_each expands the array so a plain IN over the ids does the job.
        if !q.inbox_ids.is_empty() {
            let ph = placeholders(binds.len(), q.inbox_ids.len());
            sql.push_str(&format!(
                " AND EXISTS (SELECT 1 FROM json_each(summary_json, '$.inboxes')
                              WHERE json_extract(value, '$.id') IN ({ph}))"
            ));
            binds.extend(q.inbox_ids.iter().cloned());
        }
        // Keyword search: every whitespace-separated term must appear (case-insensitive
        // substring) in the title or the description. At a few tens of thousands of rows a scan
        // with LIKE is effectively instant, so there's no full-text index to maintain.
        if let Some(kw) = q.keyword.as_deref() {
            for term in kw.split_whitespace() {
                let n = binds.len() + 1;
                let mut clause = if q.whole_words {
                    format!(
                        "word_match(?{n}, json_extract(summary_json, '$.title'))
                         OR word_match(?{n}, json_extract(summary_json, '$.vulnerability_information'))"
                    )
                } else {
                    format!(
                        "json_extract(summary_json, '$.title') LIKE ?{n} ESCAPE '\\'
                         OR json_extract(summary_json, '$.vulnerability_information') LIKE ?{n} ESCAPE '\\'"
                    )
                };
                binds.push(if q.whole_words {
                    term.to_string()
                } else {
                    like_pattern(term)
                });
                // An all-digits term is very likely a report number, which is the row's primary
                // key rather than anything inside the blob. Matched exactly — a substring match
                // on ids would drag in every report whose number merely contains the digits.
                if term.chars().all(|c| c.is_ascii_digit()) {
                    let n = binds.len() + 1;
                    clause.push_str(&format!(" OR id = ?{n}"));
                    binds.push(term.to_string());
                }
                sql.push_str(&format!(" AND ({clause})"));
            }
        }
        sql.push_str(" ORDER BY created_at DESC");

        let mut stmt = c.prepare(&sql).map_err(AppError::other)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })
            .map_err(AppError::other)?;
        let mut out = Vec::new();
        for r in rows {
            let (json, bounty_ineligible) = r.map_err(AppError::other)?;
            if let Some(summary) = summary_from_row(&json) {
                out.push(ReportListItem {
                    summary,
                    bounty_ineligible,
                });
            }
        }
        Ok(out)
    }

    fn recent_comments(&self, program_handle: &str, limit: i64) -> AppResult<Vec<CommentListItem>> {
        let c = self.conn.lock().unwrap();
        // json_each expands each report's activities into rows, so the whole feed is one join over
        // the blobs we already store. `created_at` is ISO-8601 UTC throughout, which sorts
        // chronologically as text. Reports with no detail synced yet contribute nothing.
        let mut stmt = c
            .prepare(
                "SELECT r.id,
                        json_extract(r.summary_json, '$.title'),
                        json_extract(a.value, '$.id'),
                        json_extract(a.value, '$.created_at'),
                        json_extract(a.value, '$.message'),
                        json_extract(a.value, '$.internal'),
                        json_extract(a.value, '$.actor')
                 FROM reports r, json_each(r.detail_json, '$.activities') a
                 WHERE r.program_handle = ?1
                   AND r.detail_json IS NOT NULL
                   AND json_extract(a.value, '$.type') = 'comment'
                   -- hackbot's pre-submission trigger notices aren't discussion, and the detail
                   -- pane already hides them (see isHackbotPreSubmissionTrigger). They're a
                   -- sizeable share of all comments, so they'd otherwise swamp the feed.
                   AND NOT (
                       lower(coalesce(json_extract(a.value, '$.actor.username'), '')) = 'hackbot'
                       AND json_extract(a.value, '$.message') LIKE '%pre-submission%trigger%'
                   )
                 ORDER BY json_extract(a.value, '$.created_at') DESC
                 LIMIT ?2",
            )
            .map_err(AppError::other)?;
        let rows = stmt
            .query_map(params![program_handle, limit], |row| {
                Ok(CommentListItem {
                    report_id: row.get(0)?,
                    report_title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    id: row.get(2)?,
                    created_at: row.get(3)?,
                    message: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    internal: row.get::<_, Option<bool>>(5)?.unwrap_or(false),
                    actor: row
                        .get::<_, Option<String>>(6)?
                        .and_then(|j| serde_json::from_str(&j).ok()),
                })
            })
            .map_err(AppError::other)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(AppError::other)?);
        }
        Ok(out)
    }

    fn distinct_inboxes(&self, program_handle: &str) -> AppResult<Vec<InboxRef>> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare(
                "SELECT DISTINCT json_extract(value, '$.id')   AS inbox_id,
                                 json_extract(value, '$.name') AS inbox_name,
                                 json_extract(value, '$.kind') AS inbox_kind
                 FROM reports, json_each(reports.summary_json, '$.inboxes')
                 WHERE reports.program_handle = ?1 AND inbox_id IS NOT NULL
                 ORDER BY inbox_name COLLATE NOCASE",
            )
            .map_err(AppError::other)?;
        let rows = stmt
            .query_map(params![program_handle], |row| {
                Ok(InboxRef {
                    id: row.get::<_, String>(0)?,
                    name: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    kind: row.get::<_, Option<String>>(2)?,
                })
            })
            .map_err(AppError::other)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::other)
    }

    fn distinct_program_handles(&self) -> AppResult<Vec<String>> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare(
                "SELECT DISTINCT program_handle FROM reports
                 ORDER BY program_handle COLLATE NOCASE",
            )
            .map_err(AppError::other)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(AppError::other)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::other)
    }

    fn distinct_asset_identifiers(&self, program_handle: &str) -> AppResult<Vec<String>> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare(
                "SELECT asset_identifier FROM reports
                 WHERE program_handle = ?1 AND asset_identifier IS NOT NULL
                 GROUP BY asset_identifier
                 HAVING count(*) > 1
                 ORDER BY asset_identifier COLLATE NOCASE",
            )
            .map_err(AppError::other)?;
        let rows = stmt
            .query_map(params![program_handle], |row| row.get::<_, String>(0))
            .map_err(AppError::other)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::other)
    }

    fn get_detail(&self, id: &str) -> AppResult<Option<ReportDetail>> {
        let c = self.conn.lock().unwrap();
        // Reconstruct the full detail by merging the summary blob (shared fields) with the
        // detail-only extra blob. Returns None until the detail has actually been fetched.
        let row: Option<(String, Option<String>)> = c
            .query_row(
                "SELECT summary_json, detail_json FROM reports WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(AppError::other)?;
        let Some((summary_json, Some(extra_json))) = row else {
            return Ok(None);
        };
        let (Some(summary), Ok(extra)) = (
            summary_from_row(&summary_json),
            serde_json::from_str::<ReportDetailExtra>(&extra_json),
        ) else {
            return Ok(None);
        };
        Ok(Some(report_detail_from(&summary, &extra)))
    }

    fn ids_missing_detail(&self, program_handle: &str) -> AppResult<Vec<String>> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare(
                "SELECT id FROM reports
                 WHERE program_handle = ?1 AND detail_fetched_at IS NULL
                 ORDER BY created_at DESC",
            )
            .map_err(AppError::other)?;
        let rows = stmt
            .query_map(params![program_handle], |row| row.get::<_, String>(0))
            .map_err(AppError::other)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::other)
    }

    fn mark_detail_stale(&self, ids: &[&str]) -> AppResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction().map_err(AppError::other)?;
        for id in ids {
            tx.execute(
                "UPDATE reports SET detail_fetched_at = NULL WHERE id = ?1",
                params![id],
            )
            .map_err(AppError::other)?;
        }
        tx.commit().map_err(AppError::other)?;
        Ok(())
    }

    fn count_reports(&self, program_handle: &str) -> AppResult<i64> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT COUNT(*) FROM reports WHERE program_handle = ?1",
            params![program_handle],
            |row| row.get(0),
        )
        .map_err(AppError::other)
    }

    fn count_detail(&self, program_handle: &str) -> AppResult<i64> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT COUNT(*) FROM reports WHERE program_handle = ?1 AND detail_fetched_at IS NOT NULL",
            params![program_handle],
            |row| row.get(0),
        )
        .map_err(AppError::other)
    }

    fn wipe(&self) -> AppResult<()> {
        let c = self.conn.lock().unwrap();
        c.execute_batch("DELETE FROM reports; DELETE FROM sync_state;")
            .map_err(AppError::other)?;
        // Deleting rows only marks their pages free — the report text stays in the file (and its
        // WAL) until something reuses them. VACUUM rewrites the database from live content only.
        c.execute_batch("VACUUM").map_err(AppError::other)
    }

    fn get_sync_state(&self) -> AppResult<SyncState> {
        let c = self.conn.lock().unwrap();
        let state = c
            .query_row(
                "SELECT program_handle, backfill_summaries_complete, update_watermark, last_sync_at
                 FROM sync_state WHERE id = 1",
                [],
                |row| {
                    Ok(SyncState {
                        program_handle: row.get(0)?,
                        backfill_summaries_complete: row.get::<_, i64>(1)? != 0,
                        update_watermark: row.get(2)?,
                        last_sync_at: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(AppError::other)?;
        Ok(state.unwrap_or_default())
    }

    fn put_sync_state(&self, state: &SyncState) -> AppResult<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO sync_state (id, program_handle, backfill_summaries_complete,
                                     update_watermark, last_sync_at)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                program_handle = excluded.program_handle,
                backfill_summaries_complete = excluded.backfill_summaries_complete,
                update_watermark = excluded.update_watermark,
                last_sync_at = excluded.last_sync_at",
            params![
                state.program_handle,
                state.backfill_summaries_complete as i64,
                state.update_watermark,
                state.last_sync_at,
            ],
        )
        .map_err(AppError::other)?;
        Ok(())
    }

    fn get_triage(&self, id: &str) -> AppResult<Option<TriageRecord>> {
        let c = self.conn.lock().unwrap();
        type TriageRow = (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let result: rusqlite::Result<TriageRow> = c.query_row(
            "SELECT triage, triage_validity, triage_new_files, triage_session_id
             FROM reports WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        );
        match result {
            Ok((Some(summary), validity, new_files, session_id)) => Ok(Some(TriageRecord {
                summary,
                validity,
                new_files: new_files
                    .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
                    .unwrap_or_default(),
                session_id,
            })),
            Ok((None, ..)) => Ok(None),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(AppError::other(e)),
        }
    }

    fn set_triage(
        &self,
        id: &str,
        summary: &str,
        validity: Option<&str>,
        new_files: &[String],
        session_id: Option<&str>,
    ) -> AppResult<()> {
        let files_json = serde_json::to_string(new_files).map_err(AppError::other)?;
        let c = self.conn.lock().unwrap();
        // A triage can be saved for a report before it's been synced into the DB (unlikely, but
        // the triage panel keys off the selected report). Keep the row valid by supplying the
        // NOT NULL columns; a later summary upsert fills in the real data.
        c.execute(
            "INSERT INTO reports (id, program_handle, summary_json, triage, triage_validity, triage_new_files, triage_session_id)
             VALUES (?1, '', '{}', ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET triage = excluded.triage,
                                           triage_validity = excluded.triage_validity,
                                           triage_new_files = excluded.triage_new_files,
                                           triage_session_id = excluded.triage_session_id",
            params![id, summary, validity, files_json, session_id],
        )
        .map_err(AppError::other)?;
        Ok(())
    }

    fn set_triage_new_files(&self, id: &str, new_files: &[String]) -> AppResult<()> {
        let files_json = serde_json::to_string(new_files).map_err(AppError::other)?;
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE reports SET triage_new_files = ?2 WHERE id = ?1",
            params![id, files_json],
        )
        .map_err(AppError::other)?;
        Ok(())
    }

    fn list_triage_validity(&self, ids: &[&str]) -> AppResult<Vec<(String, Option<String>)>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let c = self.conn.lock().unwrap();
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id, triage_validity FROM reports
             WHERE triage IS NOT NULL AND id IN ({placeholders})"
        );
        let mut stmt = c.prepare(&sql).map_err(AppError::other)?;
        let rows = stmt
            .query_map(params_from_iter(ids.iter()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(AppError::other)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::other)
    }
}

// The detail-only slice of a report: everything a `ReportDetail` carries that a `ReportSummary`
// does not. This is what `detail_json` stores, so no field is duplicated across the two blobs.
#[derive(Serialize, Deserialize)]
struct ReportDetailExtra {
    main_state: String,
    #[serde(default)]
    cve_ids: Option<Vec<String>>,
    activities: Vec<Activity>,
    attachments: Vec<Attachment>,
}

// Reconstruct a full `ReportDetail` from the summary blob (shared fields) plus the detail-only
// extra blob. The inverse of the split done in `upsert_detail`.
fn report_detail_from(s: &ReportSummary, extra: &ReportDetailExtra) -> ReportDetail {
    ReportDetail {
        id: s.id.clone(),
        title: s.title.clone(),
        state: s.state.clone(),
        main_state: extra.main_state.clone(),
        severity_rating: s.severity_rating.clone(),
        created_at: s.created_at.clone(),
        vulnerability_information: s.vulnerability_information.clone(),
        issue_tracker_reference_id: s.issue_tracker_reference_id.clone(),
        issue_tracker_reference_url: s.issue_tracker_reference_url.clone(),
        reporter: s.reporter.clone(),
        weakness: s.weakness.clone(),
        asset: s.asset.clone(),
        inboxes: s.inboxes.clone(),
        cve_ids: extra.cve_ids.clone(),
        activities: extra.activities.clone(),
        attachments: extra.attachments.clone(),
    }
}

// Build a list-level summary from a full detail, for the rare case we cache detail for a report
// we've never seen at list level. The detail endpoint carries no assignee/bounty/last_activity,
// so those are left empty until a summary upsert supplies them.
fn summary_from_detail(d: &ReportDetail) -> ReportSummary {
    ReportSummary {
        id: d.id.clone(),
        title: d.title.clone(),
        vulnerability_information: d.vulnerability_information.clone(),
        state: d.state.clone(),
        severity_rating: d.severity_rating.clone(),
        created_at: d.created_at.clone(),
        last_activity_at: None,
        issue_tracker_reference_id: d.issue_tracker_reference_id.clone(),
        issue_tracker_reference_url: d.issue_tracker_reference_url.clone(),
        asset: d.asset.clone(),
        weakness: d.weakness.clone(),
        reporter: d.reporter.clone(),
        assignee: None,
        inboxes: d.inboxes.clone(),
        bounty: None,
    }
}

fn placeholders(offset: usize, count: usize) -> String {
    (0..count)
        .map(|i| format!("?{}", offset + 1 + i))
        .collect::<Vec<_>>()
        .join(",")
}

// Current time as an ISO8601 UTC string, used only for `detail_fetched_at` bookkeeping.
fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Good enough as an opaque, monotonic-ish marker; we never parse it back.
    format!("@{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hackerone::{Activity, AssetRef, AssigneeRef, ReportDetail, ReportSummary, UserRef};

    fn store() -> SqliteStore {
        SqliteStore::in_memory()
    }

    fn summary(id: &str, title: &str, state: &str, severity: Option<&str>) -> ReportSummary {
        ReportSummary {
            id: id.to_string(),
            title: title.to_string(),
            vulnerability_information: format!("body for {title}"),
            state: state.to_string(),
            severity_rating: severity.map(String::from),
            created_at: format!("2024-01-{id:0>2}T00:00:00.000Z"),
            last_activity_at: Some("2024-02-01T00:00:00.000Z".to_string()),
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

    #[test]
    fn wipe_removes_every_program_and_the_sync_state() {
        let s = store();
        s.upsert_summaries("wp", &[summary("1", "One", "new", None)])
            .unwrap();
        s.upsert_summaries("other", &[summary("2", "Two", "new", None)])
            .unwrap();
        s.set_triage("1", "a summary", Some("valid"), &[], None)
            .unwrap();
        assert!(s.get_triage("1").unwrap().is_some());
        s.put_sync_state(&SyncState {
            program_handle: Some("wp".into()),
            backfill_summaries_complete: true,
            update_watermark: Some("2024-02-01T00:00:00.000Z".into()),
            last_sync_at: Some("@1".into()),
        })
        .unwrap();

        s.wipe().unwrap();

        assert_eq!(s.count_reports("wp").unwrap(), 0);
        assert_eq!(s.count_reports("other").unwrap(), 0);
        assert!(s.distinct_program_handles().unwrap().is_empty());
        assert!(s.get_triage("1").unwrap().is_none());
        let state = s.get_sync_state().unwrap();
        assert!(state.program_handle.is_none());
        assert!(!state.backfill_summaries_complete);
        assert!(state.update_watermark.is_none());
    }

    #[test]
    fn distinct_asset_identifiers_are_scoped_to_the_program() {
        let s = store();
        let asset = |id: &str, ident: &str| {
            Some(AssetRef {
                id: id.to_string(),
                asset_identifier: ident.to_string(),
                asset_type: Some("SOURCE_CODE".into()),
            })
        };
        let mut r1 = summary("1", "One", "new", None);
        r1.asset = asset("2752", "bbPress Core");
        let mut r2 = summary("2", "Two", "new", None);
        r2.asset = asset("2752", "bbPress Core");
        // No asset at all — must not surface as an empty option.
        let r3 = summary("3", "Three", "new", None);
        let mut r4 = summary("4", "Four", "new", None);
        r4.asset = asset("2750", "WordPress Core");
        let mut r5 = summary("5", "Five", "new", None);
        r5.asset = asset("2750", "WordPress Core");
        s.upsert_summaries("wp", &[r1, r2, r3]).unwrap();
        s.upsert_summaries("other", &[r4, r5]).unwrap();

        assert_eq!(
            s.distinct_asset_identifiers("wp").unwrap(),
            vec!["bbPress Core".to_string()]
        );
        assert_eq!(
            s.distinct_asset_identifiers("other").unwrap(),
            vec!["WordPress Core".to_string()]
        );
    }

    #[test]
    fn distinct_asset_identifiers_skips_assets_with_a_single_report() {
        let s = store();
        let asset = |id: &str, ident: &str| {
            Some(AssetRef {
                id: id.to_string(),
                asset_identifier: ident.to_string(),
                asset_type: Some("SOURCE_CODE".into()),
            })
        };
        let mut r1 = summary("1", "One", "new", None);
        r1.asset = asset("2752", "bbPress Core");
        let mut r2 = summary("2", "Two", "new", None);
        r2.asset = asset("2752", "bbPress Core");
        // Only one report against this asset — no point offering it as a filter.
        let mut r3 = summary("3", "Three", "new", None);
        r3.asset = asset("2750", "WordPress Core");
        s.upsert_summaries("wp", &[r1, r2, r3]).unwrap();

        assert_eq!(
            s.distinct_asset_identifiers("wp").unwrap(),
            vec!["bbPress Core".to_string()]
        );
    }

    #[test]
    fn distinct_program_handles_lists_each_program_once() {
        let s = store();
        assert!(s.distinct_program_handles().unwrap().is_empty());

        s.upsert_summaries(
            "wp",
            &[
                summary("1", "SQL injection", "new", Some("high")),
                summary("2", "XSS bug", "resolved", Some("low")),
            ],
        )
        .unwrap();
        assert_eq!(s.distinct_program_handles().unwrap(), vec!["wp"]);

        s.upsert_summaries("bbpress", &[summary("3", "CSRF", "new", None)])
            .unwrap();
        assert_eq!(
            s.distinct_program_handles().unwrap(),
            vec!["bbpress".to_string(), "wp".to_string()]
        );
    }

    #[test]
    fn upsert_and_query_by_state_and_severity() {
        let s = store();
        s.upsert_summaries(
            "wp",
            &[
                summary("1", "SQL injection", "new", Some("high")),
                summary("2", "XSS bug", "resolved", Some("low")),
                summary("3", "Unrated thing", "new", None),
            ],
        )
        .unwrap();

        let all = s
            .query(&LocalQuery {
                program_handle: "wp".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(all.len(), 3);
        // newest created_at first
        assert_eq!(all[0].summary.id, "3");

        let new_only = s
            .query(&LocalQuery {
                program_handle: "wp".into(),
                states: vec!["new".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(new_only.len(), 2);

        let unrated = s
            .query(&LocalQuery {
                program_handle: "wp".into(),
                severities: vec!["unrated".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(unrated.len(), 1);
        assert_eq!(unrated[0].summary.id, "3");
    }

    #[test]
    fn keyword_search_uses_like() {
        let s = store();
        s.upsert_summaries(
            "wp",
            &[
                summary("1", "SQL injection in login", "new", Some("high")),
                summary("2", "Reflected XSS", "new", Some("low")),
            ],
        )
        .unwrap();

        let query_kw = |kw: &str| {
            s.query(&LocalQuery {
                program_handle: "wp".into(),
                keyword: Some(kw.into()),
                ..Default::default()
            })
            .unwrap()
        };

        // Substring match against the title.
        let hits = query_kw("inject");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].summary.id, "1");

        // Multiple terms are AND-ed; both must appear (here, in the title).
        assert_eq!(query_kw("sql login").len(), 1);
        assert_eq!(query_kw("sql nope").len(), 0);

        // Matches the description too (the summary() helper sets body = "body for <title>").
        assert_eq!(query_kw("body for reflected").len(), 1);

        // LIKE wildcards in the keyword are escaped, so they match literally rather than
        // acting as wildcards — a bare "%" matches nothing here.
        assert_eq!(query_kw("%").len(), 0);
    }

    #[test]
    fn whole_words_keyword_matches_at_word_boundaries() {
        let s = store();
        s.upsert_summaries(
            "wp",
            &[
                summary("1", "RCE via file upload", "new", Some("high")),
                summary("2", "Leaked source code", "new", Some("low")),
                summary("3", "Force-RCE, twice", "new", Some("low")),
            ],
        )
        .unwrap();

        let query_kw = |kw: &str, whole_words: bool| {
            s.query(&LocalQuery {
                program_handle: "wp".into(),
                keyword: Some(kw.into()),
                whole_words,
                ..Default::default()
            })
            .unwrap()
        };

        // Substring search drags in "source"; whole-word search doesn't.
        assert_eq!(query_kw("rce", false).len(), 3);
        let hits = query_kw("rce", true);
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|h| h.summary.id != "2"));

        // Punctuation counts as a boundary; a mid-word occurrence doesn't.
        assert_eq!(query_kw("force", true).len(), 1);
        assert_eq!(query_kw("upload", true).len(), 1);
        assert_eq!(query_kw("uploa", true).len(), 0);

        // Multiple terms still AND, each at word boundaries.
        assert_eq!(query_kw("rce upload", true).len(), 1);
        assert_eq!(query_kw("rce source", true).len(), 0);
    }

    #[test]
    fn word_match_boundaries() {
        assert!(word_match("rce", "RCE at the start"));
        assert!(word_match("rce", "ends with RCE"));
        assert!(word_match("RCE", "an rce, with punctuation"));
        assert!(!word_match("rce", "source"));
        assert!(!word_match(
            "rce",
            "rce_id has no boundary before underscore"
        ));
        assert!(!word_match("rce", ""));
        assert!(!word_match("", "anything"));
        // Overlapping occurrences: the valid one after an invalid prefix is still found.
        assert!(word_match("aa", "xaa aa"));
    }

    #[test]
    fn numeric_keyword_matches_report_number() {
        let s = store();
        s.upsert_summaries(
            "wp",
            &[
                summary("31337", "SQL injection in login", "new", Some("high")),
                summary("313370", "Reflected XSS", "new", Some("low")),
            ],
        )
        .unwrap();

        let query_kw = |kw: &str| {
            s.query(&LocalQuery {
                program_handle: "wp".into(),
                keyword: Some(kw.into()),
                ..Default::default()
            })
            .unwrap()
        };

        // A numeric term also matches the report number, exactly — not as a substring, so the
        // longer id isn't dragged in.
        let hits = query_kw("31337");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].summary.id, "31337");

        // A number that isn't a report id (and appears in no title/body) still matches nothing.
        assert_eq!(query_kw("999").len(), 0);
    }

    #[test]
    fn assignee_token_generated_from_blob() {
        let s = store();
        let mut user_report = summary("1", "assigned to user", "new", Some("high"));
        user_report.assignee = Some(AssigneeRef {
            kind: "user".into(),
            id: "u9".into(),
            username: Some("bob".into()),
            name: Some("Bob".into()),
            profile_picture_url: None,
        });
        let mut group_report = summary("2", "assigned to group", "new", Some("high"));
        group_report.assignee = Some(AssigneeRef {
            kind: "group".into(),
            id: "g1".into(),
            username: None,
            name: Some("Triage Team".into()),
            profile_picture_url: None,
        });
        s.upsert_summaries("wp", &[user_report, group_report])
            .unwrap();

        // User assignee filters by username; group assignee filters by group name.
        let by_user = s
            .query(&LocalQuery {
                program_handle: "wp".into(),
                assignees: vec!["bob".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(by_user.len(), 1);
        assert_eq!(by_user[0].summary.id, "1");

        let by_group = s
            .query(&LocalQuery {
                program_handle: "wp".into(),
                assignees: vec!["Triage Team".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(by_group.len(), 1);
        assert_eq!(by_group[0].summary.id, "2");
    }

    #[test]
    fn asset_filter_matches_on_identifier() {
        let s = store();
        let asset = |id: &str, ident: &str| {
            Some(AssetRef {
                id: id.to_string(),
                asset_identifier: ident.to_string(),
                asset_type: Some("SOURCE_CODE".into()),
            })
        };
        let mut r1 = summary("1", "core bug", "new", Some("high"));
        r1.asset = asset("2752", "bbPress Core");
        let mut r2 = summary("2", "other bug", "new", Some("high"));
        r2.asset = asset("2751", "BuddyPress Core");
        s.upsert_summaries("wp", &[r1, r2]).unwrap();

        // Filter by the asset *identifier* (the sidebar's numeric id 2100930 wouldn't match the
        // report's structured_scope id 2752 — that mismatch was the bug).
        let hits = s
            .query(&LocalQuery {
                program_handle: "wp".into(),
                asset_identifiers: vec!["bbPress Core".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].summary.id, "1");
    }

    #[test]
    fn inbox_filter_and_distinct_inboxes() {
        let s = store();
        let inbox = |id: &str, name: &str, kind: &str| InboxRef {
            id: id.to_string(),
            name: name.to_string(),
            kind: Some(kind.to_string()),
        };
        let mut r1 = summary("1", "in triage inbox", "new", Some("high"));
        r1.inboxes = vec![inbox("10", "Triage", "custom")];
        let mut r2 = summary("2", "in two inboxes", "new", Some("high"));
        r2.inboxes = vec![
            inbox("20", "Default", "default"),
            inbox("10", "Triage", "custom"),
        ];
        let r3 = summary("3", "no inbox", "new", Some("high"));
        s.upsert_summaries("wp", &[r1, r2, r3]).unwrap();

        // Distinct inboxes across all reports, deduped and name-sorted.
        let inboxes = s.distinct_inboxes("wp").unwrap();
        assert_eq!(inboxes.len(), 2);
        assert_eq!(inboxes[0].name, "Default");
        assert_eq!(inboxes[1].name, "Triage");

        // Filtering by a single inbox id matches every report carrying it.
        let triage = s
            .query(&LocalQuery {
                program_handle: "wp".into(),
                inbox_ids: vec!["10".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(triage.len(), 2);

        // Multiple ids OR together (a report matches if it's in any selected inbox).
        let either = s
            .query(&LocalQuery {
                program_handle: "wp".into(),
                inbox_ids: vec!["10".into(), "20".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(either.len(), 2);

        let default_only = s
            .query(&LocalQuery {
                program_handle: "wp".into(),
                inbox_ids: vec!["20".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(default_only.len(), 1);
        assert_eq!(default_only[0].summary.id, "2");
    }

    #[test]
    fn sync_state_round_trip() {
        let s = store();
        assert!(s.get_sync_state().unwrap().program_handle.is_none());
        s.put_sync_state(&SyncState {
            program_handle: Some("wp".into()),
            backfill_summaries_complete: true,
            update_watermark: Some("2024-05-01T00:00:00.000Z".into()),
            last_sync_at: Some("@123".into()),
        })
        .unwrap();
        let got = s.get_sync_state().unwrap();
        assert_eq!(got.program_handle.as_deref(), Some("wp"));
        assert!(got.backfill_summaries_complete);
        assert_eq!(
            got.update_watermark.as_deref(),
            Some("2024-05-01T00:00:00.000Z")
        );
    }

    #[test]
    fn triage_new_files_round_trip() {
        let s = store();
        let files = vec!["/tmp/a.php".to_string(), "/tmp/b.txt".to_string()];
        s.set_triage("r1", "summary", Some("valid"), &files, Some("sess-1"))
            .unwrap();
        let rec = s.get_triage("r1").unwrap().unwrap();
        assert_eq!(rec.new_files, files);

        s.set_triage_new_files("r1", &["/tmp/b.txt".to_string()])
            .unwrap();
        let rec = s.get_triage("r1").unwrap().unwrap();
        assert_eq!(rec.summary, "summary");
        assert_eq!(rec.validity.as_deref(), Some("valid"));
        assert_eq!(rec.new_files, vec!["/tmp/b.txt".to_string()]);
        assert_eq!(rec.session_id.as_deref(), Some("sess-1"));
    }

    #[test]
    fn triage_session_id_is_optional() {
        let s = store();
        s.set_triage("r1", "summary", None, &[], None).unwrap();
        assert!(s.get_triage("r1").unwrap().unwrap().session_id.is_none());
    }

    #[test]
    fn detail_round_trips_without_duplicating_shared_fields() {
        let s = store();
        s.upsert_summaries("wp", &[summary("1", "SQL injection", "new", Some("high"))])
            .unwrap();

        let detail = ReportDetail {
            id: "1".into(),
            title: "SQL injection".into(),
            state: "triaged".into(),
            main_state: "open".into(),
            severity_rating: Some("high".into()),
            created_at: "2024-01-01T00:00:00.000Z".into(),
            vulnerability_information: "body for SQL injection".into(),
            issue_tracker_reference_id: None,
            issue_tracker_reference_url: None,
            reporter: UserRef {
                id: "u1".into(),
                username: "alice".into(),
                name: None,
                profile_picture_url: None,
            },
            weakness: None,
            asset: None,
            inboxes: vec![],
            cve_ids: None,
            activities: vec![Activity::Comment {
                id: "a1".into(),
                created_at: "2024-01-02T00:00:00.000Z".into(),
                message: "looking into it".into(),
                internal: false,
                actor: None,
                attachments: vec![],
            }],
            attachments: vec![],
        };
        s.upsert_detail(&detail).unwrap();

        // Reconstructed detail merges summary (shared fields) + extra (detail-only fields).
        let got = s.get_detail("1").unwrap().unwrap();
        assert_eq!(got.main_state, "open");
        assert_eq!(got.activities.len(), 1);
        assert_eq!(got.title, "SQL injection");
        // upsert_detail refreshed the summary's shared state field from the fresher detail.
        assert_eq!(got.state, "triaged");

        // The detail_json blob must NOT contain the shared title/description — those live only in
        // summary_json. It should contain the detail-only activity message.
        let raw: String = {
            let c = s.conn.lock().unwrap();
            c.query_row("SELECT detail_json FROM reports WHERE id = '1'", [], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert!(
            !raw.contains("SQL injection"),
            "shared title leaked into detail_json"
        );
        assert!(
            !raw.contains("body for SQL injection"),
            "description leaked into detail_json"
        );
        assert!(
            raw.contains("looking into it"),
            "activity missing from detail_json"
        );
    }

    #[test]
    fn bounty_ineligibility_is_derived_from_the_activity() {
        let s = store();
        s.upsert_summaries(
            "wp",
            &[
                summary("1", "Ineligible", "resolved", Some("low")),
                summary("2", "Eligible", "resolved", Some("low")),
            ],
        )
        .unwrap();
        s.upsert_detail(&detail_with_activities(
            &summary("1", "Ineligible", "resolved", Some("low")),
            vec![event("e1", "not-eligible-for-bounty")],
        ))
        .unwrap();
        s.upsert_detail(&detail_with_activities(
            &summary("2", "Eligible", "resolved", Some("low")),
            vec![event("e2", "bug-resolved")],
        ))
        .unwrap();

        let rows = s
            .query(&LocalQuery {
                program_handle: "wp".into(),
                ..Default::default()
            })
            .unwrap();
        let by_id = |id: &str| {
            rows.iter()
                .find(|r| r.summary.id == id)
                .unwrap()
                .bounty_ineligible
        };
        assert!(by_id("1"));
        assert!(!by_id("2"));
    }

    #[test]
    fn recent_comments_span_reports_newest_first_and_respect_the_limit() {
        let s = store();
        let one = summary("1", "One", "new", None);
        let two = summary("2", "Two", "resolved", None);
        s.upsert_summaries("wp", &[one.clone(), two.clone()])
            .unwrap();
        s.upsert_summaries("other", &[summary("3", "Three", "new", None)])
            .unwrap();
        s.upsert_detail(&detail_with_activities(
            &one,
            vec![
                comment("c1", "2024-03-01T00:00:00.000Z", "oldest", false),
                event("e1", "bug-triaged"),
                comment("c2", "2024-03-03T00:00:00.000Z", "newest", true),
            ],
        ))
        .unwrap();
        s.upsert_detail(&detail_with_activities(
            &two,
            vec![comment("c3", "2024-03-02T00:00:00.000Z", "middle", false)],
        ))
        .unwrap();
        // Another program's comments never leak in, and a report with no detail synced yet
        // simply contributes nothing.
        s.upsert_detail(&detail_with_activities(
            &summary("3", "Three", "new", None),
            vec![comment(
                "c4",
                "2024-03-04T00:00:00.000Z",
                "other program",
                false,
            )],
        ))
        .unwrap();

        let rows = s.recent_comments("wp", 100).unwrap();
        let ids: Vec<&str> = rows.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["c2", "c3", "c1"]);
        assert_eq!(rows[0].report_id, "1");
        assert_eq!(rows[0].report_title, "One");
        assert_eq!(rows[0].message, "newest");
        assert!(rows[0].internal);
        assert_eq!(rows[0].actor.as_ref().unwrap().username, "carol");
        assert!(!rows[1].internal);
        assert_eq!(rows[1].report_id, "2");

        let capped = s.recent_comments("wp", 2).unwrap();
        assert_eq!(capped.len(), 2);
        assert_eq!(capped[0].id, "c2");
    }

    #[test]
    fn recent_comments_skip_hackbot_pre_submission_notices() {
        let s = store();
        let one = summary("1", "One", "new", None);
        s.upsert_summaries("wp", std::slice::from_ref(&one))
            .unwrap();
        s.upsert_detail(&detail_with_activities(
            &one,
            vec![
                bot_comment(
                    "b1",
                    "2024-03-05T00:00:00.000Z",
                    "A [pre-submission trigger](/x) was activated",
                ),
                // hackbot's other comments are ordinary discussion and stay.
                bot_comment("b2", "2024-03-04T00:00:00.000Z", "Ran a scan for you"),
                comment("c1", "2024-03-01T00:00:00.000Z", "human comment", false),
            ],
        ))
        .unwrap();

        let ids: Vec<String> = s
            .recent_comments("wp", 100)
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(ids, ["b2", "c1"]);
    }

    fn bot_comment(id: &str, created_at: &str, message: &str) -> Activity {
        Activity::Comment {
            id: id.to_string(),
            created_at: created_at.to_string(),
            message: message.to_string(),
            internal: true,
            actor: Some(UserRef {
                id: "u3".into(),
                username: "hackbot".into(),
                name: None,
                profile_picture_url: None,
            }),
            attachments: vec![],
        }
    }

    fn comment(id: &str, created_at: &str, message: &str, internal: bool) -> Activity {
        Activity::Comment {
            id: id.to_string(),
            created_at: created_at.to_string(),
            message: message.to_string(),
            internal,
            actor: Some(UserRef {
                id: "u2".into(),
                username: "carol".into(),
                name: None,
                profile_picture_url: None,
            }),
            attachments: vec![],
        }
    }

    fn event(id: &str, kind: &str) -> Activity {
        Activity::Event {
            id: id.to_string(),
            created_at: "2024-01-02T00:00:00.000Z".into(),
            kind: kind.to_string(),
            message: None,
            internal: false,
            actor: None,
            invitee: None,
            duplicate_report_id: None,
            original_report_id: None,
            old_scope: None,
            new_scope: None,
            new_weakness: None,
            group_name: None,
            old_severity: None,
            new_severity: None,
            old_title: None,
            new_title: None,
            bounty_amount: None,
            bonus_amount: None,
            assigned_user: None,
            reference: None,
        }
    }

    fn detail_with_activities(s: &ReportSummary, activities: Vec<Activity>) -> ReportDetail {
        report_detail_from(
            s,
            &ReportDetailExtra {
                main_state: "closed".into(),
                cve_ids: None,
                activities,
                attachments: vec![],
            },
        )
    }

    const PLAINTEXT_MAGIC: &[u8; 16] = b"SQLite format 3\0";

    fn file_header(path: &Path) -> [u8; 16] {
        use std::io::Read;
        let mut header = [0u8; 16];
        std::fs::File::open(path)
            .unwrap()
            .read_exact(&mut header)
            .unwrap();
        header
    }

    #[test]
    fn fresh_db_is_encrypted_with_restricted_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("macaroni.db");
        let key = DbKey::parse("ab".repeat(32)).unwrap();
        let store = SqliteStore::open(&path, &key).unwrap();
        store
            .upsert_summaries("wp", &[summary("1", "t", "new", None)])
            .unwrap();
        drop(store);

        assert_ne!(&file_header(&path), PLAINTEXT_MAGIC);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn plaintext_db_is_migrated_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("macaroni.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute(
                "INSERT INTO sync_state (id, program_handle) VALUES (1, 'acme')",
                [],
            )
            .unwrap();
        }
        assert_eq!(&file_header(&path), PLAINTEXT_MAGIC);

        let key = DbKey::parse("cd".repeat(32)).unwrap();
        let store = SqliteStore::open(&path, &key).unwrap();
        assert_eq!(
            store.get_sync_state().unwrap().program_handle.as_deref(),
            Some("acme")
        );
        drop(store);
        assert_ne!(&file_header(&path), PLAINTEXT_MAGIC);
    }

    #[test]
    fn wrong_key_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("macaroni.db");
        drop(SqliteStore::open(&path, &DbKey::parse("11".repeat(32)).unwrap()).unwrap());
        assert!(SqliteStore::open(&path, &DbKey::parse("22".repeat(32)).unwrap()).is_err());
    }
}
