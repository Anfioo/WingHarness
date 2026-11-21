// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! TCP and UDP endpoints with their owning process (what `netstat -ano` shows).

use std::net::{Ipv4Addr, Ipv6Addr};

use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, SetTcpEntry, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_LH,
    MIB_TCPROW_LH_0, MIB_TCPROW_OWNER_PID, MIB_TCP_STATE_DELETE_TCB, MIB_UDP6ROW_OWNER_PID,
    MIB_UDPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
};
use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};

use crate::actions::ActionError;
use crate::models::Connection;
use crate::util::AlignedBuf;

pub fn list() -> Vec<Connection> {
    let mut out = Vec::new();
    tcp4(&mut out);
    tcp6(&mut out);
    udp4(&mut out);
    udp6(&mut out);
    out
}

/// Ports are stored in network byte order in the low 16 bits.
fn port(raw: u32) -> u16 {
    u16::from_be(raw as u16)
}

fn table(fill: impl Fn(Option<*mut core::ffi::c_void>, &mut u32) -> u32) -> Option<AlignedBuf> {
    let mut size = 0u32;
    let mut buf = AlignedBuf::with_capacity(64 * 1024);
    for _ in 0..4 {
        size = size.max(buf.len() as u32);
        match fill(Some(buf.as_mut_ptr()), &mut size) {
            r if r == NO_ERROR.0 => return Some(buf),
            r if r == ERROR_INSUFFICIENT_BUFFER.0 => buf.grow_to(size as usize + 4096),
            _ => return None,
        }
    }
    None
}

/// Rows of a `MIB_*TABLE_OWNER_PID`: a u32 count followed by the rows.
fn rows<T>(buf: &AlignedBuf) -> &[T] {
    let count = unsafe { *(buf.as_ptr() as *const u32) } as usize;
    let offset = std::mem::align_of::<T>().max(4);
    let max = (buf.len() - offset) / std::mem::size_of::<T>();
    unsafe { std::slice::from_raw_parts(buf.as_ptr().add(offset) as *const T, count.min(max)) }
}

fn tcp_state(state: u32) -> &'static str {
    match state {
        1 => "closed",
        2 => "listen",
        3 => "synSent",
        4 => "synReceived",
        5 => "established",
        6 => "finWait1",
        7 => "finWait2",
        8 => "closeWait",
        9 => "closing",
        10 => "lastAck",
        11 => "timeWait",
        _ => "closed",
    }
}

fn tcp4(out: &mut Vec<Connection>) {
    let Some(buf) = table(|p, size| unsafe {
        GetExtendedTcpTable(p, size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0)
    }) else {
        log::warn!("Failed to enumerate IPv4 TCP connections");
        return;
    };
    for r in rows::<MIB_TCPROW_OWNER_PID>(&buf) {
        let listening = r.dwState == 2;
        out.push(Connection {
            protocol: "tcp",
            ipv6: false,
            local_address: Ipv4Addr::from(r.dwLocalAddr.to_ne_bytes()).to_string(),
            local_port: port(r.dwLocalPort),
            remote_address: (!listening)
                .then(|| Ipv4Addr::from(r.dwRemoteAddr.to_ne_bytes()).to_string()),
            remote_port: (!listening).then(|| port(r.dwRemotePort)),
            state: Some(tcp_state(r.dwState)),
            pid: r.dwOwningPid,
        });
    }
}

fn tcp6(out: &mut Vec<Connection>) {
    let Some(buf) = table(|p, size| unsafe {
        GetExtendedTcpTable(
            p,
            size,
            false,
            AF_INET6.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    }) else {
        log::warn!("Failed to enumerate IPv6 TCP connections");
        return;
    };
    for r in rows::<MIB_TCP6ROW_OWNER_PID>(&buf) {
        let listening = r.dwState == 2;
        out.push(Connection {
            protocol: "tcp",
            ipv6: true,
            local_address: Ipv6Addr::from(r.ucLocalAddr).to_string(),
            local_port: port(r.dwLocalPort),
            remote_address: (!listening).then(|| Ipv6Addr::from(r.ucRemoteAddr).to_string()),
            remote_port: (!listening).then(|| port(r.dwRemotePort)),
            state: Some(tcp_state(r.dwState)),
            pid: r.dwOwningPid,
        });
    }
}

fn udp4(out: &mut Vec<Connection>) {
    let Some(buf) = table(|p, size| unsafe {
        GetExtendedUdpTable(p, size, false, AF_INET.0 as u32, UDP_TABLE_OWNER_PID, 0)
    }) else {
        log::warn!("Failed to enumerate IPv4 UDP connections");
        return;
    };
    for r in rows::<MIB_UDPROW_OWNER_PID>(&buf) {
        out.push(Connection {
            protocol: "udp",
            ipv6: false,
            local_address: Ipv4Addr::from(r.dwLocalAddr.to_ne_bytes()).to_string(),
            local_port: port(r.dwLocalPort),
            remote_address: None,
            remote_port: None,
            state: None,
            pid: r.dwOwningPid,
        });
    }
}

fn udp6(out: &mut Vec<Connection>) {
    let Some(buf) = table(|p, size| unsafe {
        GetExtendedUdpTable(p, size, false, AF_INET6.0 as u32, UDP_TABLE_OWNER_PID, 0)
    }) else {
        log::warn!("Failed to enumerate IPv6 UDP connections");
        return;
    };
    for r in rows::<MIB_UDP6ROW_OWNER_PID>(&buf) {
        out.push(Connection {
            protocol: "udp",
            ipv6: true,
            local_address: Ipv6Addr::from(r.ucLocalAddr).to_string(),
            local_port: port(r.dwLocalPort),
            remote_address: None,
            remote_port: None,
            state: None,
            pid: r.dwOwningPid,
        });
    }
}

/// Resets an established IPv4 TCP connection.
pub fn close_tcp(
    local_address: &str,
    local_port: u16,
    remote_address: &str,
    remote_port: u16,
) -> Result<(), ActionError> {
    if local_port == 0 || remote_port == 0 {
        return Err(ActionError::Refused);
    }
    let local = local_address
        .parse::<Ipv4Addr>()
        .map_err(|_| ActionError::Refused)?;
    let remote = remote_address
        .parse::<Ipv4Addr>()
        .map_err(|_| ActionError::Refused)?;
    let row = MIB_TCPROW_LH {
        Anonymous: MIB_TCPROW_LH_0 {
            State: MIB_TCP_STATE_DELETE_TCB,
        },
        dwLocalAddr: u32::from_ne_bytes(local.octets()),
        dwLocalPort: local_port.to_be() as u32,
        dwRemoteAddr: u32::from_ne_bytes(remote.octets()),
        dwRemotePort: remote_port.to_be() as u32,
    };
    match unsafe { SetTcpEntry(&row) } {
        0 => Ok(()),
        5 | 317 => Err(ActionError::AccessDenied),
        code => Err(ActionError::Os(format!(
            "SetTcpEntry failed with Windows error {code}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_network_order_ports() {
        assert_eq!(port(0x3412), 0x1234);
    }

    #[test]
    fn maps_tcp_states() {
        assert_eq!(tcp_state(2), "listen");
        assert_eq!(tcp_state(5), "established");
        assert_eq!(tcp_state(99), "closed");
    }

    #[test]
    fn rejects_invalid_close_targets() {
        assert!(matches!(
            close_tcp("::1", 1, "127.0.0.1", 2),
            Err(ActionError::Refused)
        ));
        assert!(matches!(
            close_tcp("127.0.0.1", 0, "127.0.0.1", 2),
            Err(ActionError::Refused)
        ));
    }

    #[test]
    #[ignore = "requires a live Windows TCP connection and administrator rights"]
    fn closes_real_connection() {
        let _ = close_tcp("127.0.0.1", 1, "127.0.0.1", 2);
    }
}
