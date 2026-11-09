// TODO(B1): enumerate the TCP listening table and join it with process info.

use crate::error::PortsResult;
use crate::models::{PortDetail, PortEntry};

pub fn list_listening_ports() -> PortsResult<Vec<PortEntry>> {
    Ok(Vec::new())
}

pub fn scan_ports(_ports: &[u16]) -> PortsResult<Vec<PortEntry>> {
    Ok(Vec::new())
}

pub fn port_detail(_port: u16) -> PortsResult<Option<PortDetail>> {
    Ok(None)
}
