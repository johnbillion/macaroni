use crate::db_key::DbKey;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const SERVICE: &str = "com.johnbillion.macaroni";
pub const ACCOUNT: &str = "default";

// Everything secret the app holds, in a single keychain item, to avoid multiple prompts for access.
#[derive(Serialize, Deserialize)]
struct Secrets {
    db_key: String,
    #[serde(default)]
    credentials: Option<Credentials>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Stored {
    Current(Secrets),
    // v0.2.0 stored the credentials on their own under this account, before the database
    // key joined them in the same item.
    Legacy(Credentials),
}

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
        Self {
            service: SERVICE.to_string(),
            account: ACCOUNT.to_string(),
        }
    }

    fn entry(&self) -> AppResult<keyring::Entry> {
        Ok(keyring::Entry::new(&self.service, &self.account)?)
    }

    fn read_stored(&self) -> AppResult<Option<Stored>> {
        match self.entry()?.get_password() {
            // `s` is the cleartext JSON blob holding the token and the database key — parse
            // it, then wipe it before it's dropped.
            Ok(mut s) => {
                let parsed = serde_json::from_str(&s);
                s.zeroize();
                Ok(Some(parsed?))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn read(&self) -> AppResult<Option<Secrets>> {
        Ok(match self.read_stored()? {
            None => None,
            Some(Stored::Current(secrets)) => Some(secrets),
            // Fold pre-existing credentials into the current shape with a fresh database
            // key and write them straight back, so the token survives the upgrade.
            Some(Stored::Legacy(creds)) => {
                let secrets = Secrets {
                    db_key: DbKey::generate()?.hex().to_string(),
                    credentials: Some(creds),
                };
                self.write(&secrets)?;
                Some(secrets)
            }
        })
    }

    fn write(&self, secrets: &Secrets) -> AppResult<()> {
        let mut serialized = serde_json::to_string(secrets)?;
        let result = self.entry()?.set_password(&serialized);
        serialized.zeroize();
        Ok(result?)
    }

    // Called once during setup, before the database is opened, so every later credential
    // read or write finds the item already there.
    pub fn load_or_create_db_key(&self) -> AppResult<DbKey> {
        if let Some(secrets) = self.read()? {
            return DbKey::parse(secrets.db_key);
        }
        let key = DbKey::generate()?;
        self.write(&Secrets {
            db_key: key.hex().to_string(),
            credentials: None,
        })?;
        Ok(key)
    }

    fn read_for_update(&self) -> AppResult<Secrets> {
        self.read()?.ok_or_else(|| AppError::Keychain {
            message: "keychain item is missing".into(),
        })
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialStore for KeyringStore {
    fn load(&self) -> AppResult<Option<Credentials>> {
        let Some(mut secrets) = self.read()? else {
            return Ok(None);
        };
        let creds = secrets.credentials.take();
        secrets.db_key.zeroize();
        Ok(creds)
    }

    fn save(&self, creds: &Credentials) -> AppResult<()> {
        let mut secrets = self.read_for_update()?;
        secrets.credentials = Some(creds.clone());
        let result = self.write(&secrets);
        secrets.db_key.zeroize();
        result
    }

    // Clears the credentials but keeps the item: deleting it would take the database key
    // with it, leaving an undecryptable mirror on disk.
    fn clear(&self) -> AppResult<()> {
        let Some(mut secrets) = self.read()? else {
            return Ok(());
        };
        secrets.credentials = None;
        let result = self.write(&secrets);
        secrets.db_key.zeroize();
        result
    }
}

#[cfg(test)]
pub struct InMemoryStore {
    inner: std::sync::Mutex<Option<Credentials>>,
}

#[cfg(test)]
impl InMemoryStore {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(None),
        }
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
        let creds = Credentials {
            username: "alice".into(),
            token: "super-secret-token".into(),
        };
        let rendered = format!("{creds:?}");
        assert!(rendered.contains("alice"));
        assert!(!rendered.contains("super-secret-token"));
        assert!(rendered.contains("<redacted>"));
    }

    #[test]
    fn stored_blob_without_a_key_is_read_as_legacy_credentials() {
        let stored: Stored = serde_json::from_str(r#"{"username":"u","token":"t"}"#).unwrap();
        let Stored::Legacy(creds) = stored else {
            panic!("expected the legacy shape");
        };
        assert_eq!(creds.username, "u");
        assert_eq!(creds.token, "t");
    }

    #[test]
    fn stored_blob_holds_the_key_alongside_the_credentials() {
        let json = r#"{"db_key":"ab","credentials":{"username":"u","token":"t"}}"#;
        let stored: Stored = serde_json::from_str(json).unwrap();
        let Stored::Current(secrets) = stored else {
            panic!("expected the current shape");
        };
        assert_eq!(secrets.db_key, "ab");
        assert_eq!(secrets.credentials.unwrap().token, "t");
    }

    // The item is created at launch with the key alone, before any credentials exist.
    #[test]
    fn stored_blob_may_hold_the_key_alone() {
        let stored: Stored = serde_json::from_str(r#"{"db_key":"ab"}"#).unwrap();
        let Stored::Current(secrets) = stored else {
            panic!("expected the current shape");
        };
        assert!(secrets.credentials.is_none());
    }

    #[test]
    fn in_memory_roundtrip() {
        let store = InMemoryStore::new();
        assert!(store.load().unwrap().is_none());
        store
            .save(&Credentials {
                username: "u".into(),
                token: "t".into(),
            })
            .unwrap();
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(loaded.username, "u");
        assert_eq!(loaded.token, "t");
        store.clear().unwrap();
        assert!(store.load().unwrap().is_none());
    }
}
