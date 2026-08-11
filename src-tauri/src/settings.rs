use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

// Embedded at compile time so distribution builds don't depend on the developer's source tree
// being present at the absolute path it was authored at.
pub const DEFAULT_TRIAGE_PROMPT: &str = include_str!("../prompts/triage.md");

// Non-secret user preferences, persisted as a small JSON file in the app data dir (next to
// the SQLite db). Secrets live in the keychain via `CredentialStore`; this is for everything
// that's just configuration. `triage_working_dir` is the directory `run_triage` spawns
// `claude` in — there's no default, so it stays `None` until the user picks one. A cleared
// `triage_prompt` stores `None` rather than a copy of `DEFAULT_TRIAGE_PROMPT`, so the shipped
// prompt keeps applying as the app updates.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub triage_working_dir: Option<String>,
    #[serde(default)]
    pub triage_prompt: Option<String>,
    #[serde(default)]
    pub ai_notice_acknowledged: bool,
}

impl Settings {
    pub fn triage_prompt(&self) -> &str {
        self.triage_prompt
            .as_deref()
            .unwrap_or(DEFAULT_TRIAGE_PROMPT)
    }
}

pub trait SettingsStore: Send + Sync {
    fn load(&self) -> AppResult<Settings>;
    fn save(&self, settings: &Settings) -> AppResult<()>;
}

pub struct FileSettingsStore {
    path: PathBuf,
    // Serialises read-modify-write so a load()/save() pair from one command can't interleave
    // with another's and clobber it. Cheap on a single-user desktop app.
    lock: Mutex<()>,
}

impl FileSettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }
}

impl SettingsStore for FileSettingsStore {
    fn load(&self) -> AppResult<Settings> {
        let _guard = self.lock.lock().unwrap();
        match std::fs::read_to_string(&self.path) {
            Ok(s) => Ok(serde_json::from_str(&s)?),
            // A missing file just means nothing's been configured yet — start from defaults.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(AppError::other(e)),
        }
    }

    fn save(&self, settings: &Settings) -> AppResult<()> {
        let _guard = self.lock.lock().unwrap();
        let json = serde_json::to_string_pretty(settings)?;
        std::fs::write(&self.path, json).map_err(AppError::other)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_default() {
        let dir = std::env::temp_dir().join("macaroni-settings-test-missing");
        let _ = std::fs::remove_file(&dir);
        let store = FileSettingsStore::new(dir);
        let loaded = store.load().unwrap();
        assert!(loaded.triage_working_dir.is_none());
        assert!(loaded.triage_prompt.is_none());
        assert!(!loaded.ai_notice_acknowledged);
        assert_eq!(loaded.triage_prompt(), DEFAULT_TRIAGE_PROMPT);
    }

    #[test]
    fn roundtrip() {
        let path = std::env::temp_dir().join("macaroni-settings-test-roundtrip.json");
        let _ = std::fs::remove_file(&path);
        let store = FileSettingsStore::new(path.clone());
        store
            .save(&Settings {
                triage_working_dir: Some("/tmp/wp".into()),
                triage_prompt: Some("custom".into()),
                ai_notice_acknowledged: true,
            })
            .unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.triage_working_dir.as_deref(), Some("/tmp/wp"));
        assert_eq!(loaded.triage_prompt(), "custom");
        assert!(loaded.ai_notice_acknowledged);
        let _ = std::fs::remove_file(&path);
    }
}
