// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! TCP and UDP endpoints with their owning process. Stub baseline: enumeration
//! and `SetTcpEntry` land with the connection port.

use crate::actions::ActionError;
use crate::models::Connection;

/// Every IPv4/IPv6 TCP and UDP endpoint. Enumeration failures are skipped by
/// the real reader rather than failing the whole list.
pub fn list() -> Vec<Connection> {
    Vec::new()
}

/// Resets an IPv4 TCP connection. The real implementation uses `SetTcpEntry`
/// and reports `ActionError::AccessDenied` without administrator rights.
pub fn close_tcp(
    _local_address: &str,
    _local_port: u16,
    _remote_address: &str,
    _remote_port: u16,
) -> Result<(), ActionError> {
    Err(ActionError::Refused)
}
