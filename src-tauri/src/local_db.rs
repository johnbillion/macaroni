use crate::error::{AppError, AppResult};
use rusqlite::{params, params_from_iter, Connection};
use std::path::Path;
use std::sync::Mutex;

pub trait ReportStore: Send + Sync {
    fn upsert(&self, ids: &[&str]) -> AppResult<()>;
    fn mark_read(&self, id: &str) -> AppResult<()>;
    fn list_read(&self, ids: &[&str]) -> AppResult<Vec<String>>;
}

pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    pub fn open(path: &Path) -> AppResult<Self> {
        let conn = Connection::open(path).map_err(AppError::other)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS reports (
                id   TEXT PRIMARY KEY,
                read INTEGER NOT NULL DEFAULT 0
            );",
        )
        .map_err(AppError::other)?;
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_memory() -> SqliteStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS reports (
                id   TEXT PRIMARY KEY,
                read INTEGER NOT NULL DEFAULT 0
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
    fn upsert_preserves_read_state() {
        let s = in_memory();
        s.upsert(&["a"]).unwrap();
        s.mark_read("a").unwrap();
        s.upsert(&["a", "b"]).unwrap();
        let read = s.list_read(&["a", "b"]).unwrap();
        assert_eq!(read, vec!["a".to_string()]);
    }
}
