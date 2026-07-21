//! Bridges the macOS system accent colour into the frontend.
//!
//! WKWebView doesn't expose the user's chosen accent colour to CSS (the standard
//! `AccentColor` system-colour keyword is unimplemented in WebKit), so we read
//! `NSColor.controlAccentColor` natively, resolve it to sRGB, and hand the frontend a
//! hex value plus a contrasting foreground. The frontend drops these into the `--accent`
//! / `--on-accent` CSS variables that the whole theme derives from. We also observe the
//! system "colours changed" notification so flipping the accent in System Settings →
//! Appearance updates the running app without a relaunch.

#[derive(Clone, serde::Serialize)]
pub struct AccentColor {
    /// The accent as `#rrggbb`.
    pub accent: String,
    /// Black or white — whichever reads on top of the accent (matches how macOS pairs
    /// dark text with the light yellow accent and white with everything else).
    pub on_accent: String,
}

impl AccentColor {
    /// Used when we're off macOS or the native read fails: Apple's system blue, so the
    /// app still looks like a native control rather than the old indigo.
    fn fallback() -> Self {
        Self {
            accent: "#007aff".into(),
            on_accent: "#ffffff".into(),
        }
    }
}

/// Resolve the current system accent colour.
#[cfg(not(target_os = "macos"))]
pub fn accent_color(_app: &tauri::AppHandle) -> AccentColor {
    AccentColor::fallback()
}

/// Register the accent-change observer. No-op off macOS.
#[cfg(not(target_os = "macos"))]
pub fn watch_accent_changes(_app: &tauri::AppHandle) {}

#[cfg(target_os = "macos")]
mod imp {
    use core::ptr::NonNull;

    use block2::RcBlock;
    use objc2_app_kit::{NSColor, NSColorSpace, NSSystemColorsDidChangeNotification};
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    use tauri::{AppHandle, Emitter};

    use super::AccentColor;

    /// Read the current accent colour. **Must be called on the main thread** — the dynamic
    /// `controlAccentColor` resolves against the main thread's current appearance, so calling
    /// it elsewhere yields the wrong light/dark variant.
    fn read_accent() -> AccentColor {
        let srgb = NSColorSpace::sRGBColorSpace();
        let accent = NSColor::controlAccentColor();
        let Some(rgb) = accent.colorUsingColorSpace(&srgb) else {
            return AccentColor::fallback();
        };
        let r = rgb.redComponent();
        let g = rgb.greenComponent();
        let b = rgb.blueComponent();
        AccentColor {
            accent: to_hex(r, g, b),
            on_accent: on_accent_for(r, g, b).into(),
        }
    }

    fn to_hex(r: f64, g: f64, b: f64) -> String {
        let byte = |c: f64| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
        format!("#{:02x}{:02x}{:02x}", byte(r), byte(g), byte(b))
    }

    /// Pick black or white foreground by relative luminance. The 0.5 threshold mirrors macOS:
    /// only the light accents (yellow and near-white) get black text; every saturated colour
    /// keeps white, matching Apple's own accent buttons.
    fn on_accent_for(r: f64, g: f64, b: f64) -> &'static str {
        fn lin(c: f64) -> f64 {
            if c <= 0.03928 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        }
        let luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        if luminance > 0.5 {
            "#000000"
        } else {
            "#ffffff"
        }
    }

    /// Resolve the accent colour, hopping onto the main thread for a correct read.
    pub fn accent_color(app: &AppHandle) -> AccentColor {
        let (tx, rx) = std::sync::mpsc::channel();
        if app
            .run_on_main_thread(move || {
                let _ = tx.send(read_accent());
            })
            .is_err()
        {
            return AccentColor::fallback();
        }
        rx.recv().unwrap_or_else(|_| AccentColor::fallback())
    }

    /// Register a system-wide observer that re-reads the accent and emits `theme:accent-changed`
    /// whenever the user changes it in System Settings. Call once, from the main thread (Tauri's
    /// `setup` runs there). The observer token is intentionally leaked so it lives for the whole
    /// app session.
    pub fn watch_accent_changes(app: &AppHandle) {
        let app = app.clone();
        let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
            let _ = app.emit("theme:accent-changed", read_accent());
        });
        let center = NSNotificationCenter::defaultCenter();
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSSystemColorsDidChangeNotification),
                None,
                None,
                &block,
            )
        };
        std::mem::forget(token);
    }
}

#[cfg(target_os = "macos")]
pub use imp::{accent_color, watch_accent_changes};
