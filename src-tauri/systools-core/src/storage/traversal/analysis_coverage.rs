//! Bridge for the analysis coverage fingerprint.
//!
//! The analysis service lane owns this policy fingerprint. The shared kernel
//! needs the same cache key before that lane lands, so the policy version,
//! exclusion fingerprint, and elevation boundary are combined here unchanged.

use crate::storage::analysis::models::ANALYSIS_SCAN_POLICY_VERSION;

pub(crate) fn configuration_fingerprint(
    exclusions: [u8; 32],
    elevation: Option<bool>,
) -> [u8; 32] {
    let mut hash = blake3::Hasher::new();
    hash.update(b"analysis-scan-policy");
    hash.update(&ANALYSIS_SCAN_POLICY_VERSION.to_le_bytes());
    hash.update(&exclusions);
    // A cache measured by an unelevated reader must not mask newly readable scopes.
    hash.update(&[match elevation {
        None => 0,
        Some(false) => 1,
        Some(true) => 2,
    }]);
    *hash.finalize().as_bytes()
}

/// Reports whether this process can read scopes hidden from an unelevated reader.
///
/// The elevation broker owns privileged launches; the scan kernel only needs the
/// boundary value for its cache fingerprint.
pub(crate) fn process_elevation() -> Option<bool> {
    None
}
