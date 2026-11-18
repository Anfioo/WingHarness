//! Privilege state of the running application.
//!
//! A0 freezes the signatures only; B3 ports the token queries.

/// Whether this process runs with an elevated (administrator) token.
pub fn is_elevated() -> bool {
    todo!("privilege detection is implemented by B3")
}

/// Enables SeDebugPrivilege when the token holds it (i.e. when elevated), which
/// lets us open nearly every process. Returns whether it is now enabled.
pub fn enable_debug_privilege() -> bool {
    todo!("privilege enabling is implemented by B3")
}
