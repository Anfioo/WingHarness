// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! Packaged application startup tasks (AppModel). Stub baseline.

use crate::actions::ActionError;
use crate::meta::MetaStore;
use crate::models::StartupItem;

/// Packaged tasks registered for this user. Empty until the AppModel reader is
/// ported; it never fails the rest of the list.
pub fn list(_meta: &MetaStore) -> Vec<StartupItem> {
    Vec::new()
}

/// Changes the startup task state of a packaged entry.
pub fn set_enabled(_name: &str, _enabled: bool) -> Result<(), ActionError> {
    Err(ActionError::Refused)
}
