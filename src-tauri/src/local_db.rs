use crate::error::{AppError, AppResult};
use rusqlite::{params, params_from_iter, Connection};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct TriageRecord {
    pub summary: String,
    pub validity: Option<String>,
    // Absolute paths to files claude wrote during the run. May be empty.
    pub new_files: Vec<String>,
}

pub trait ReportStore: Send + Sync {
    fn upsert(&self, ids: &[&str]) -> AppResult<()>;
    fn mark_read(&self, id: &str) -> AppResult<()>;
    fn mark_read_many(&self, ids: &[&str]) -> AppResult<()>;
    fn list_read(&self, ids: &[&str]) -> AppResult<Vec<String>>;
    fn get_triage(&self, id: &str) -> AppResult<Option<TriageRecord>>;
    fn set_triage(
        &self,
        id: &str,
        summary: &str,
        validity: Option<&str>,
        new_files: &[String],
    ) -> AppResult<()>;
    // Overwrite just the stored new-files list for a report (used after a file is deleted).
    fn set_triage_new_files(&self, id: &str, new_files: &[String]) -> AppResult<()>;
    // For the subset of `ids` that have a triage saved, return (id, validity).
    // Validity may be null in the DB (e.g. legacy rows from before we asked claude for JSON).
    fn list_triage_validity(&self, ids: &[&str]) -> AppResult<Vec<(String, Option<String>)>>;
}

pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    pub fn open(path: &Path) -> AppResult<Self> {
        let conn = Connection::open(path).map_err(AppError::other)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS reports (
                id              TEXT PRIMARY KEY,
                read            INTEGER NOT NULL DEFAULT 0,
                triage          TEXT,
                triage_validity TEXT,
                triage_new_files TEXT
            );",
        )
        .map_err(AppError::other)?;
        // Idempotent adds for databases created before these columns existed.
        let _ = conn.execute("ALTER TABLE reports ADD COLUMN triage TEXT", []);
        let _ = conn.execute("ALTER TABLE reports ADD COLUMN triage_validity TEXT", []);
        let _ = conn.execute("ALTER TABLE reports ADD COLUMN triage_new_files TEXT", []);
        Ok(Self { conn: Mutex::new(conn) })
    }
}

impl ReportStore for SqliteStore {
    fn upsert(&self, ids: &[&str]) -> AppResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction().map_err(AppError::other)?;
        for id in ids {
            tx.execute(
                "INSERT OR IGNORE INTO reports (id, read) VALUES (?1, 0)",
                params![id],
            )
            .map_err(AppError::other)?;
        }
        tx.commit().map_err(AppError::other)?;
        Ok(())
    }

    fn mark_read(&self, id: &str) -> AppResult<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO reports (id, read) VALUES (?1, 1)
             ON CONFLICT(id) DO UPDATE SET read = 1",
            params![id],
        )
        .map_err(AppError::other)?;
        Ok(())
    }

    fn mark_read_many(&self, ids: &[&str]) -> AppResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction().map_err(AppError::other)?;
        for id in ids {
            tx.execute(
                "INSERT INTO reports (id, read) VALUES (?1, 1)
                 ON CONFLICT(id) DO UPDATE SET read = 1",
                params![id],
            )
            .map_err(AppError::other)?;
        }
        tx.commit().map_err(AppError::other)?;
        Ok(())
    }

    fn list_read(&self, ids: &[&str]) -> AppResult<Vec<String>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let c = self.conn.lock().unwrap();
        let placeholders = std::iter::repeat("?").take(ids.len()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT id FROM reports WHERE read = 1 AND id IN ({placeholders})"
        );
        let mut stmt = c.prepare(&sql).map_err(AppError::other)?;
        let rows = stmt
            .query_map(params_from_iter(ids.iter()), |row| row.get::<_, String>(0))
            .map_err(AppError::other)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::other)
    }

    fn get_triage(&self, id: &str) -> AppResult<Option<TriageRecord>> {
        let c = self.conn.lock().unwrap();
        let result: rusqlite::Result<(Option<String>, Option<String>, Option<String>)> = c
            .query_row(
                "SELECT triage, triage_validity, triage_new_files FROM reports WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            );
        match result {
            Ok((Some(summary), validity, new_files)) => Ok(Some(TriageRecord {
                summary,
                validity,
                // Stored as a JSON array; tolerate null/garbage by falling back to empty.
                new_files: new_files
                    .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
                    .unwrap_or_default(),
            })),
            Ok((None, _, _)) => Ok(None),
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
    ) -> AppResult<()> {
        let files_json = serde_json::to_string(new_files).map_err(AppError::other)?;
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO reports (id, read, triage, triage_validity, triage_new_files)
             VALUES (?1, 0, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET triage = excluded.triage,
                                           triage_validity = excluded.triage_validity,
                                           triage_new_files = excluded.triage_new_files",
            params![id, summary, validity, files_json],
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
        let placeholders = std::iter::repeat("?").take(ids.len()).collect::<Vec<_>>().join(",");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn in_memory() -> SqliteStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS reports (
                id              TEXT PRIMARY KEY,
                read            INTEGER NOT NULL DEFAULT 0,
                triage          TEXT,
                triage_validity TEXT,
                triage_new_files TEXT
            );",
        )
        .unwrap();
        SqliteStore { conn: Mutex::new(conn) }
    }

    #[test]
    fn upsert_then_read() {
        let s = in_memory();
        s.upsert(&["a", "b", "c"]).unwrap();
        assert!(s.list_read(&["a", "b", "c"]).unwrap().is_empty());
        s.mark_read("b").unwrap();
        let read = s.list_read(&["a", "b", "c"]).unwrap();
        assert_eq!(read, vec!["b".to_string()]);
    }

    #[test]
    fn mark_read_many_marks_all() {
        let s = in_memory();
        s.mark_read_many(&["a", "b", "c"]).unwrap();
        let mut read = s.list_read(&["a", "b", "c"]).unwrap();
        read.sort();
        assert_eq!(read, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn triage_new_files_round_trip() {
        let s = in_memory();
        let files = vec!["/tmp/a.php".to_string(), "/tmp/b.txt".to_string()];
        s.set_triage("r1", "summary", Some("valid"), &files).unwrap();
        let rec = s.get_triage("r1").unwrap().unwrap();
        assert_eq!(rec.new_files, files);

        // Deleting one rewrites just the list, leaving the summary/validity intact.
        s.set_triage_new_files("r1", &["/tmp/b.txt".to_string()]).unwrap();
        let rec = s.get_triage("r1").unwrap().unwrap();
        assert_eq!(rec.summary, "summary");
        assert_eq!(rec.validity.as_deref(), Some("valid"));
        assert_eq!(rec.new_files, vec!["/tmp/b.txt".to_string()]);
    }

    #[test]
    fn triage_new_files_defaults_empty_when_null() {
        let s = in_memory();
        s.upsert(&["r1"]).unwrap();
        s.set_triage("r1", "summary", None, &[]).unwrap();
        let rec = s.get_triage("r1").unwrap().unwrap();
        assert!(rec.new_files.is_empty());
    }

    #[test]
    fn upsert_preserves_read_state() {
        let s = in_memory();
        s.upsert(&["a"]).unwrap();
        s.mark_read("a").unwrap();
        s.upsert(&["a", "b"]).unwrap();
        let read = s.list_read(&["a", "b"]).unwrap();
        assert_eq!(read, vec!["a".to_string()]);
    }
}
