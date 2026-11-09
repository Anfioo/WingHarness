// Ported from Porter (https://github.com/t21dev/porter-app), MIT License.
// See ../UPSTREAM.md for the porting record.

use serde::{Deserialize, Serialize};

/// Persisted settings: the pinned port numbers and the "pinned only" view.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PortsSettings {
    /// Pinned port numbers, ascending, at most 50.
    pub pinned_ports: Vec<u16>,
    /// Show only the pinned ports.
    pub pinned_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortStatus {
    Free,
    Occupied,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Tcp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessBrief {
    pub pid: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortEntry {
    pub port: u16,
    pub status: PortStatus,
    pub protocol: Protocol,
    /// The local listen address, or `None` for a pinned port nothing listens on.
    pub address: Option<String>,
    pub process: Option<ProcessBrief>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDetail {
    pub pid: u32,
    pub name: String,
    pub path: Option<String>,
    pub command: Option<String>,
    pub working_dir: Option<String>,
    pub memory_bytes: Option<u64>,
    /// Unix seconds.
    pub started_at: Option<i64>,
    pub user: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortDetail {
    pub port: u16,
    pub status: PortStatus,
    pub protocol: Protocol,
    pub address: Option<String>,
    pub process: Option<ProcessDetail>,
}

pub const DEFAULT_PINNED_PORTS: [u16; 5] = [3000, 5173, 8080, 5432, 27017];
pub const MAX_PINNED_PORTS: usize = 50;
