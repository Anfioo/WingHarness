// Ported from Porter (https://github.com/t21dev/porter-app), MIT License.
// See ../UPSTREAM.md for the porting record.

use std::collections::{HashMap, HashSet};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::error::{PortsError, PortsResult};
use crate::models::{PortDetail, PortEntry, PortStatus, ProcessBrief, ProcessDetail, Protocol};

/// One row of the TCP listener table.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Listener {
    port: u16,
    address: String,
    pid: u32,
}

/// Every listening TCP port, with the name and PID of the process behind it.
pub fn list_listening_ports() -> PortsResult<Vec<PortEntry>> {
    let listeners = read_listeners()?;
    entries_from(&listeners)
}

/// The requested ports, in ascending order. A port nothing listens on comes
/// back as a free placeholder with no address, so a pinned port can be shown
/// before its service starts.
pub fn scan_ports(ports: &[u16]) -> PortsResult<Vec<PortEntry>> {
    let listeners = read_listeners()?;
    Ok(scan_entries(ports, entries_from(&listeners)?))
}

/// One port with everything known about its process, or `None` if nothing
/// listens on it.
pub fn port_detail(port: u16) -> PortsResult<Option<PortDetail>> {
    detail_for(port, &read_listeners()?)
}

fn status_for(has_process: bool, pid: u32) -> PortStatus {
    if !has_process {
        PortStatus::Free
    } else if pid < 1000 {
        // Windows system processes keep low PIDs; this is a heuristic, not a
        // privilege check.
        PortStatus::System
    } else {
        PortStatus::Occupied
    }
}

fn status_of(process: Option<&ProcessBrief>, pid: u32) -> PortStatus {
    status_for(process.is_some(), pid)
}

/// Same port on IPv4 and IPv6 (or several addresses) is one port: the first
/// row wins, and the result is ascending by port.
fn dedupe(listeners: Vec<Listener>) -> Vec<Listener> {
    let mut seen = HashSet::new();
    let mut deduped: Vec<Listener> = listeners
        .into_iter()
        .filter(|listener| seen.insert(listener.port))
        .collect();
    deduped.sort_by_key(|listener| listener.port);
    deduped
}

fn entries_from(listeners: &[Listener]) -> PortsResult<Vec<PortEntry>> {
    let names = process_names(listeners)?;
    Ok(listeners
        .iter()
        .map(|listener| {
            let process = names.get(&listener.pid).map(|name| ProcessBrief {
                pid: listener.pid,
                name: name.clone(),
            });
            entry_for(listener, process)
        })
        .collect())
}

fn entry_for(listener: &Listener, process: Option<ProcessBrief>) -> PortEntry {
    PortEntry {
        port: listener.port,
        status: status_of(process.as_ref(), listener.pid),
        protocol: Protocol::Tcp,
        address: Some(listener.address.clone()),
        process,
    }
}

fn free_entry(port: u16) -> PortEntry {
    PortEntry {
        port,
        status: PortStatus::Free,
        protocol: Protocol::Tcp,
        address: None,
        process: None,
    }
}

fn scan_entries(ports: &[u16], listening: Vec<PortEntry>) -> Vec<PortEntry> {
    let mut by_port: HashMap<u16, PortEntry> = listening
        .into_iter()
        .map(|entry| (entry.port, entry))
        .collect();
    let mut wanted = ports.to_vec();
    wanted.sort_unstable();
    wanted.dedup();
    wanted
        .into_iter()
        .map(|port| by_port.remove(&port).unwrap_or_else(|| free_entry(port)))
        .collect()
}

/// Names of the processes that own a listened port. Only those PIDs are
/// refreshed, never the whole process table.
fn process_names(listeners: &[Listener]) -> PortsResult<HashMap<u32, String>> {
    let mut pids: Vec<Pid> = listeners
        .iter()
        .filter(|listener| listener.pid > 0)
        .map(|listener| Pid::from_u32(listener.pid))
        .collect();
    pids.sort_unstable_by_key(|pid| pid.as_u32());
    pids.dedup();
    if pids.is_empty() {
        return Ok(HashMap::new());
    }

    let mut system = System::new().map_err(snapshot_error)?;
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing(),
    );

    Ok(pids
        .into_iter()
        .filter_map(|pid| {
            system
                .process(pid)
                .map(|process| (pid.as_u32(), process.name().to_string_lossy().into_owned()))
        })
        .collect())
}

fn snapshot_error(error: impl std::fmt::Display) -> PortsError {
    PortsError::internal(format!("Failed to snapshot the process table: {error}"))
}

fn detail_for(port: u16, listeners: &[Listener]) -> PortsResult<Option<PortDetail>> {
    let Some(listener) = listeners.iter().find(|listener| listener.port == port) else {
        return Ok(None);
    };
    let process = process_detail(listener.pid)?;
    Ok(Some(PortDetail {
        port: listener.port,
        status: status_for(process.is_some(), listener.pid),
        protocol: Protocol::Tcp,
        address: Some(listener.address.clone()),
        process,
    }))
}

/// Everything known about one process. Only this PID is read.
fn process_detail(pid: u32) -> PortsResult<Option<ProcessDetail>> {
    if pid == 0 {
        return Ok(None);
    }
    let pid = Pid::from_u32(pid);
    let mut system = System::new().map_err(snapshot_error)?;
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(std::slice::from_ref(&pid)),
        true,
        ProcessRefreshKind::nothing()
            .with_memory()
            .with_exe(UpdateKind::Always)
            .with_cmd(UpdateKind::Always)
            .with_cwd(UpdateKind::Always)
            .with_user(UpdateKind::Always),
    );
    let Some(process) = system.process(pid) else {
        return Ok(None);
    };
    Ok(Some(ProcessDetail {
        pid: pid.as_u32(),
        name: process.name().to_string_lossy().into_owned(),
        path: process
            .exe()
            .map(|path| path.to_string_lossy().into_owned()),
        command: Some(
            process
                .cmd()
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(" "),
        ),
        working_dir: process
            .cwd()
            .map(|path| path.to_string_lossy().into_owned()),
        memory_bytes: Some(process.memory()),
        started_at: Some(process.start_time() as i64),
        user: process.user_id().map(|uid| format!("{uid:?}")),
    }))
}

#[cfg(windows)]
fn read_listeners() -> PortsResult<Vec<Listener>> {
    use windows::Win32::NetworkManagement::IpHelper::{
        MIB_TCP6TABLE_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};

    let mut listeners = Vec::new();

    let ipv4 = tcp_table(AF_INET.0 as u32, "IPv4")?;
    if !ipv4.is_empty() {
        // SAFETY: `tcp_table` returned a buffer holding a `MIB_TCPTABLE_OWNER_PID`
        // with `dwNumEntries` rows, and the buffer outlives the borrowed slice.
        unsafe {
            let table = &*(ipv4.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
            let rows =
                std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize);
            for row in rows {
                listeners.push(Listener {
                    port: u16::from_be(row.dwLocalPort as u16),
                    address: std::net::Ipv4Addr::from(u32::from_be(row.dwLocalAddr)).to_string(),
                    pid: row.dwOwningPid,
                });
            }
        }
    }

    let ipv6 = tcp_table(AF_INET6.0 as u32, "IPv6")?;
    if !ipv6.is_empty() {
        // SAFETY: same contract as above, for `MIB_TCP6TABLE_OWNER_PID`.
        unsafe {
            let table = &*(ipv6.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID);
            let rows =
                std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize);
            for row in rows {
                listeners.push(Listener {
                    port: u16::from_be(row.dwLocalPort as u16),
                    address: std::net::Ipv6Addr::from(row.ucLocalAddr).to_string(),
                    pid: row.dwOwningPid,
                });
            }
        }
    }

    Ok(dedupe(listeners))
}

/// One TCP listener table, retried when it grows between the size query and
/// the read.
#[cfg(windows)]
fn tcp_table(family: u32, label: &str) -> PortsResult<Vec<u32>> {
    use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER,
    };

    let mut size: u32 = 0;
    // SAFETY: the size query passes no buffer, so Windows only writes `size`.
    let status = unsafe {
        GetExtendedTcpTable(
            None,
            &mut size,
            false,
            family,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if status == ERROR_SUCCESS.0 {
        // An empty table is reported without a buffer at all.
        return Ok(Vec::new());
    }
    if status != ERROR_INSUFFICIENT_BUFFER.0 {
        return Err(table_error(label, status));
    }

    for _ in 0..4 {
        if size == 0 {
            return Ok(Vec::new());
        }
        // `u32` elements keep the buffer aligned for the table structs.
        let mut buffer = vec![0u32; (size as usize).div_ceil(4)];
        // SAFETY: the buffer holds `size` bytes and is properly aligned.
        let status = unsafe {
            GetExtendedTcpTable(
                Some(buffer.as_mut_ptr() as *mut _),
                &mut size,
                false,
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if status == ERROR_SUCCESS.0 {
            return Ok(buffer);
        }
        if status != ERROR_INSUFFICIENT_BUFFER.0 {
            return Err(table_error(label, status));
        }
        // The table grew; `size` now holds the new size, so the next
        // iteration allocates again.
    }

    Err(PortsError::internal(format!(
        "Failed to read the {label} TCP listener table after 4 attempts."
    )))
}

#[cfg(windows)]
fn table_error(label: &str, status: u32) -> PortsError {
    PortsError::internal(format!(
        "Failed to read the {label} TCP listener table (error {status})."
    ))
}

#[cfg(not(windows))]
fn read_listeners() -> PortsResult<Vec<Listener>> {
    Err(PortsError::internal(
        "Port scanning is only implemented on Windows.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brief(pid: u32) -> ProcessBrief {
        ProcessBrief {
            pid,
            name: "service.exe".to_string(),
        }
    }

    fn entry(port: u16, status: PortStatus) -> PortEntry {
        PortEntry {
            port,
            status,
            protocol: Protocol::Tcp,
            address: Some("0.0.0.0".to_string()),
            process: Some(brief(4321)),
        }
    }

    #[test]
    fn status_follows_the_process_and_the_pid() {
        assert_eq!(status_of(Some(&brief(4321)), 4321), PortStatus::Occupied);
        assert_eq!(status_of(Some(&brief(4)), 4), PortStatus::System);
        assert_eq!(status_of(None, 0), PortStatus::Free);
    }

    #[test]
    fn status_boundary_is_one_thousand() {
        assert_eq!(status_of(Some(&brief(999)), 999), PortStatus::System);
        assert_eq!(status_of(Some(&brief(1000)), 1000), PortStatus::Occupied);

        // Without a process name nothing is known about the owner, so the row
        // is free rather than system, whatever the PID.
        assert_eq!(status_of(None, 999), PortStatus::Free);
    }

    #[test]
    fn entry_for_carries_the_address_and_the_status() {
        let listener = Listener {
            port: 445,
            address: "0.0.0.0".to_string(),
            pid: 4,
        };

        let entry = entry_for(&listener, Some(brief(4)));

        assert_eq!(entry.status, PortStatus::System);
        assert_eq!(entry.address.as_deref(), Some("0.0.0.0"));
        assert_eq!(entry.process.as_ref().map(|process| process.pid), Some(4));
    }

    #[test]
    fn listeners_are_deduped_by_port_and_sorted() {
        let listeners = vec![
            Listener {
                port: 8080,
                address: "0.0.0.0".to_string(),
                pid: 12,
            },
            Listener {
                port: 8080,
                address: "::".to_string(),
                pid: 13,
            },
            Listener {
                port: 3000,
                address: "127.0.0.1".to_string(),
                pid: 14,
            },
        ];

        let deduped = dedupe(listeners);

        assert_eq!(
            deduped
                .iter()
                .map(|listener| listener.port)
                .collect::<Vec<_>>(),
            vec![3000, 8080]
        );
        assert_eq!(deduped[1].address, "0.0.0.0");
        assert_eq!(deduped[1].pid, 12);
    }

    #[test]
    fn scan_entries_fills_unlistened_ports_as_free_placeholders() {
        let scanned = scan_entries(&[8080, 1], vec![entry(8080, PortStatus::Occupied)]);

        assert_eq!(
            scanned.iter().map(|entry| entry.port).collect::<Vec<_>>(),
            vec![1, 8080]
        );
        assert_eq!(scanned[0].status, PortStatus::Free);
        assert!(scanned[0].address.is_none());
        assert!(scanned[0].process.is_none());
        assert_eq!(scanned[1].status, PortStatus::Occupied);
        assert_eq!(scanned[1].address.as_deref(), Some("0.0.0.0"));
    }

    #[test]
    fn scan_entries_keeps_one_row_per_requested_port() {
        let scanned = scan_entries(&[8080, 8080], vec![entry(8080, PortStatus::Occupied)]);

        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].port, 8080);
    }

    #[test]
    fn dedupe_and_scan_entries_accept_empty_input() {
        assert!(dedupe(Vec::new()).is_empty());
        assert!(scan_entries(&[], vec![entry(8080, PortStatus::Occupied)]).is_empty());
    }

    #[test]
    fn detail_for_a_port_nothing_listens_on_matches_nothing() {
        let listeners = vec![Listener {
            port: 8080,
            address: "0.0.0.0".to_string(),
            pid: 4321,
        }];

        // The port is absent from the table, so no process table is read.
        assert!(detail_for(7171, &listeners).expect("detail").is_none());
    }

    #[test]
    #[ignore = "reads the live TCP listener table"]
    fn list_listening_ports_reads_the_live_table() {
        let ports = list_listening_ports().expect("list_listening_ports");

        assert!(ports.windows(2).all(|pair| pair[0].port < pair[1].port));
        for entry in &ports {
            assert!(entry.address.is_some());
            assert_eq!(entry.protocol, Protocol::Tcp);
        }
    }

    #[test]
    #[ignore = "reads the live TCP listener table"]
    fn scan_ports_reports_an_unlistened_port_as_free() {
        let scanned = scan_ports(&[8080, 1]).expect("scan_ports");

        assert_eq!(
            scanned.iter().map(|entry| entry.port).collect::<Vec<_>>(),
            vec![1, 8080]
        );
        assert_eq!(scanned[0].status, PortStatus::Free);
        assert!(scanned[0].address.is_none());
    }

    #[test]
    #[ignore = "reads the live TCP listener table"]
    fn port_detail_on_an_unlistened_port_is_none() {
        let detail = port_detail(1).expect("port_detail");

        assert!(detail.is_none_or(|detail| detail.port == 1));
    }
}
