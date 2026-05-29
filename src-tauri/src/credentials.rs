use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const SERVICE: &str = "com.johnbillion.macaroni";
pub const ACCOUNT: &str = "default";

// `ZeroizeOnDrop` wipes the heap backing the token (and username) when the value is dropped,
// so the cleartext secret doesn't linger in freed memory, swap, or a core dump. We reload
// from the keychain on every request rather than caching, so these are short-lived.
#[derive(Clone, Serialize, Deserialize, ZeroizeOnDrop)]
pub struct Credentials {
    pub username: String,
    pub token: String,
}

// Hand-written so the token can never reach a log line or panic message via `{:?}`. The
// derived `Debug` would print it in cleartext.
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("username", &self.username)
            .field("token", &"<redacted>")
            .finish()
    }
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
            // `s` is the cleartext JSON blob holding the token — parse it, then wipe it
            // before it's dropped.
            Ok(mut s) => {
                let parsed = serde_json::from_str(&s);
                s.zeroize();
                Ok(Some(parsed?))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn save(&self, creds: &Credentials) -> AppResult<()> {
        let mut serialized = serde_json::to_string(creds)?;
        let result = self.entry()?.set_password(&serialized);
        serialized.zeroize();
        result?;
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
    fn debug_redacts_token() {
        let creds = Credentials { username: "alice".into(), token: "super-secret-token".into() };
        let rendered = format!("{creds:?}");
        assert!(rendered.contains("alice"));
        assert!(!rendered.contains("super-secret-token"));
        assert!(rendered.contains("<redacted>"));
    }

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
