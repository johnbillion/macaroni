use crate::error::AppResult;
use serde::{Deserialize, Serialize};

pub const SERVICE: &str = "com.johnbillion.macaroni";
pub const ACCOUNT: &str = "default";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub username: String,
    pub token: String,
}

pub trait CredentialStore: Send + Sync {
    fn load(&self) -> AppResult<Option<Credentials>>;
    fn save(&self, creds: &Credentials) -> AppResult<()>;
    fn clear(&self) -> AppResult<()>;
}

pub struct KeyringStore {
    service: String,
    account: String,
}

impl KeyringStore {
    pub fn new() -> Self {
        Self { service: SERVICE.to_string(), account: ACCOUNT.to_string() }
    }

    fn entry(&self) -> AppResult<keyring::Entry> {
        Ok(keyring::Entry::new(&self.service, &self.account)?)
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialStore for KeyringStore {
    fn load(&self) -> AppResult<Option<Credentials>> {
        match self.entry()?.get_password() {
            Ok(s) => Ok(Some(serde_json::from_str(&s)?)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn save(&self, creds: &Credentials) -> AppResult<()> {
        let serialized = serde_json::to_string(creds)?;
        self.entry()?.set_password(&serialized)?;
        Ok(())
    }

    fn clear(&self) -> AppResult<()> {
        match self.entry()?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
pub struct InMemoryStore {
    inner: std::sync::Mutex<Option<Credentials>>,
}

#[cfg(test)]
impl InMemoryStore {
    pub fn new() -> Self {
        Self { inner: std::sync::Mutex::new(None) }
    }
}

#[cfg(test)]
impl CredentialStore for InMemoryStore {
    fn load(&self) -> AppResult<Option<Credentials>> {
        Ok(self.inner.lock().unwrap().clone())
    }
    fn save(&self, creds: &Credentials) -> AppResult<()> {
        *self.inner.lock().unwrap() = Some(creds.clone());
        Ok(())
    }
    fn clear(&self) -> AppResult<()> {
        *self.inner.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_roundtrip() {
        let store = InMemoryStore::new();
        assert!(store.load().unwrap().is_none());
        store
            .save(&Credentials { username: "u".into(), token: "t".into() })
            .unwrap();
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(loaded.username, "u");
        assert_eq!(loaded.token, "t");
        store.clear().unwrap();
        assert!(store.load().unwrap().is_none());
    }
}
