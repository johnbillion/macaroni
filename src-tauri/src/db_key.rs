use crate::error::{AppError, AppResult};
use std::fmt::Write as _;
use zeroize::{Zeroize, ZeroizeOnDrop};

// Raw 256-bit SQLCipher key, hex-encoded. Persisted in the same keychain item as the API
// credentials (see `credentials::KeyringStore`): macOS puts its access ACL on the item, not
// the service, so a separate item would mean a second access prompt at launch.
#[derive(ZeroizeOnDrop)]
pub struct DbKey {
    hex: String,
}

impl DbKey {
    pub fn generate() -> AppResult<Self> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(AppError::other)?;
        let mut hex = String::with_capacity(64);
        for b in &bytes {
            write!(hex, "{b:02x}").expect("write to string");
        }
        bytes.zeroize();
        Ok(Self { hex })
    }

    pub fn parse(mut hex: String) -> AppResult<Self> {
        if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            Ok(Self { hex })
        } else {
            hex.zeroize();
            Err(AppError::Keychain {
                message: "stored database key is malformed".into(),
            })
        }
    }

    // SQLCipher's raw-key form. The key is already random, so passphrase derivation (PBKDF2)
    // is skipped by design.
    pub fn keyspec(&self) -> String {
        format!("x'{}'", self.hex)
    }

    pub(crate) fn hex(&self) -> &str {
        &self.hex
    }
}

impl std::fmt::Debug for DbKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DbKey(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_produces_distinct_256_bit_keys() {
        let a = DbKey::generate().unwrap();
        let b = DbKey::generate().unwrap();
        assert_eq!(a.hex().len(), 64);
        assert!(a.hex().bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(a.hex(), b.hex());
    }

    #[test]
    fn keyspec_is_sqlcipher_raw_key_form() {
        let key = DbKey::parse("ab".repeat(32)).unwrap();
        assert_eq!(key.keyspec(), format!("x'{}'", "ab".repeat(32)));
    }

    #[test]
    fn parse_rejects_malformed_keys() {
        assert!(DbKey::parse(String::new()).is_err());
        assert!(DbKey::parse("ab".repeat(31)).is_err());
        assert!(DbKey::parse("zz".repeat(32)).is_err());
    }

    #[test]
    fn debug_redacts_key() {
        let key = DbKey::parse("ab".repeat(32)).unwrap();
        let rendered = format!("{key:?}");
        assert!(!rendered.contains("abab"));
        assert!(rendered.contains("<redacted>"));
    }
}
