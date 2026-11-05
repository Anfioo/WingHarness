//! Bind the loopback channel to the actual OS process at its other endpoint.
//! A session secret is useful for correlation, but must not be the only boundary
//! if another local process can observe bootstrap arguments or race a connection.

use std::{
    ffi::c_void,
    io,
    net::{Ipv4Addr, TcpStream},
    ptr,
};
use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS};

/// `GetExtendedTcpTable` lives behind the `Win32_NetworkManagement_IpHelper`
/// feature, which this crate does not currently enable. Declaring the single
/// entry point here keeps the OS peer check available without widening the
/// manifest for one function.
#[repr(C)]
struct MibTcpRowOwnerPid {
    state: u32,
    local_addr: u32,
    local_port: u32,
    remote_addr: u32,
    remote_port: u32,
    owning_pid: u32,
}

#[repr(C)]
struct MibTcpTableOwnerPid {
    num_entries: u32,
    table: [MibTcpRowOwnerPid; 1],
}

/// `TCP_TABLE_OWNER_PID_ALL` from `TCP_TABLE_CLASS`.
const TCP_TABLE_OWNER_PID_ALL: u32 = 5;
/// `AF_INET` from the Winsock address family list.
const AF_INET: u32 = 2;

#[link(name = "iphlpapi")]
extern "system" {
    fn GetExtendedTcpTable(
        table: *mut c_void,
        size: *mut u32,
        order: i32,
        address_family: u32,
        table_class: u32,
        reserved: u32,
    ) -> u32;
}

pub(super) fn verify_peer_process(stream: &TcpStream, expected_pid: u32) -> io::Result<()> {
    let local = stream.local_addr()?;
    let peer = stream.peer_addr()?;
    if local.ip() != Ipv4Addr::LOCALHOST || peer.ip() != Ipv4Addr::LOCALHOST {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut size = 0;
    let code = unsafe {
        GetExtendedTcpTable(
            ptr::null_mut(),
            &mut size,
            0,
            AF_INET,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if code != ERROR_INSUFFICIENT_BUFFER {
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    // The connection table can grow between sizing and reading. Retry a bounded
    // number of times and cap memory rather than trusting the returned byte count.
    for _ in 0..3 {
        if !(4..=4 * 1024 * 1024).contains(&size) {
            return Err(io::ErrorKind::InvalidData.into());
        }
        // DWORD storage provides the alignment required by the native table.
        let mut storage = vec![0_u32; (size as usize).div_ceil(4)];
        let code = unsafe {
            GetExtendedTcpTable(
                storage.as_mut_ptr().cast(),
                &mut size,
                0,
                AF_INET,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };
        if code == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        if code != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        let count = storage[0] as usize;
        let offset = std::mem::offset_of!(MibTcpTableOwnerPid, table);
        if count > (size as usize).saturating_sub(offset) / std::mem::size_of::<MibTcpRowOwnerPid>()
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        // Read only the initialized rows, after checking both returned size and allocation.
        if size as usize > storage.len() * 4 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let rows = unsafe {
            std::slice::from_raw_parts(
                storage
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<MibTcpRowOwnerPid>(),
                count,
            )
        };
        let loopback = u32::from_ne_bytes(Ipv4Addr::LOCALHOST.octets());
        let matches = rows.iter().any(|row| {
            row.owning_pid == expected_pid
                && row.local_addr == loopback
                && row.remote_addr == loopback
                && u16::from_be(row.local_port as u16) == peer.port()
                && u16::from_be(row.remote_port as u16) == local.port()
        });
        return if matches {
            Ok(())
        } else {
            Err(io::ErrorKind::PermissionDenied.into())
        };
    }
    Err(io::ErrorKind::WouldBlock.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn channel_accepts_its_real_peer_and_rejects_a_different_process() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        verify_peer_process(&client, std::process::id()).unwrap();
        verify_peer_process(&server, std::process::id()).unwrap();
        assert!(verify_peer_process(&server, u32::MAX).is_err());
    }
}
