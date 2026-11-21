// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! Programs that start at logon: Run keys, Startup folders and packaged tasks.
//! Stub baseline: the registry and shortcut readers land with the startup port.

mod packaged;

use crate::actions::ActionError;
use crate::meta::MetaStore;
use crate::models::StartupItem;

/// Every startup entry known to this machine. Read-only and safe without
/// administrator rights; missing sources are skipped rather than failing.
pub fn list(meta: &MetaStore) -> Vec<StartupItem> {
    packaged::list(meta)
}

/// Enables or disables an entry by its `<location>|<entry>` id.
pub fn set_enabled(id: &str, enabled: bool) -> Result<(), ActionError> {
    match id.split_once('|') {
        Some(("package", name)) => packaged::set_enabled(name, enabled),
        _ => Err(ActionError::Refused),
    }
}
