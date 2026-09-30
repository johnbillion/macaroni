//! Touch ID gate at launch.
//!
//! The credentials and database key sit in the login keychain, which a signed build reads
//! silently once the user has clicked "Always Allow". This puts an explicit unlock in front
//! of that read: the system Touch ID sheet (Apple Watch or the account password as
//! fallback) via LocalAuthentication. It is a gate on the app, not on the keychain item —
//! that would need the data-protection keychain, whose entitlement requires a provisioning
//! profile — so a machine with no biometrics skips it rather than asking for the password
//! the gate exists to avoid.

/// Ask the user to authenticate. `Ok` means proceed; `Err` carries the reason not to.
#[cfg(not(target_os = "macos"))]
pub fn require_device_owner() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn require_device_owner() -> Result<(), String> {
    imp::require_device_owner()
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::mpsc;

    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};

    pub fn require_device_owner() -> Result<(), String> {
        let ctx = unsafe { LAContext::new() };
        let can_use_biometrics = unsafe {
            ctx.canEvaluatePolicy_error(
                LAPolicy::DeviceOwnerAuthenticationWithBiometricsOrCompanion,
            )
        }
        .is_ok();
        if !can_use_biometrics {
            return Ok(());
        }

        // The reply lands on a private queue, so block here until it does. The sheet is drawn
        // by the system, not by us, so it doesn't need our run loop to be going yet.
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let reply = RcBlock::new(move |ok: Bool, err: *mut NSError| {
            let result = if ok.as_bool() {
                Ok(())
            } else {
                Err(unsafe { err.as_ref() }
                    .map(|e| e.localizedDescription().to_string())
                    .unwrap_or_else(|| "authentication failed".into()))
            };
            let _ = tx.send(result);
        });
        let reason = NSString::from_str("unlock your HackerOne credentials");
        unsafe {
            // Biometrics first, with the password as the system's own fallback.
            ctx.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthentication,
                &reason,
                &reply,
            );
        }
        rx.recv()
            .unwrap_or_else(|_| Err("no reply from LocalAuthentication".into()))
    }
}
