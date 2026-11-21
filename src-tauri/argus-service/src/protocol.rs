// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! Versioned operation whitelist and the argument checks around it.

use argus_core::actions::{self, ActionError, Priority};
use argus_core::services::{ServiceAction, ServiceCatalog, StartType};
use serde::{Deserialize, Serialize};

pub const MAX_FRAME: usize = 16 * 1024;
pub const MAX_REPLY: usize = 1024 * 1024;

pub(crate) struct Context {
    network: crate::network::NetworkMonitor,
    disk: crate::disk::DiskMonitor,
    services: ServiceCatalog,
}

impl Context {
    pub fn new() -> Self {
        Self {
            network: crate::network::NetworkMonitor::spawn(),
            disk: crate::disk::DiskMonitor::new(),
            services: ServiceCatalog::default(),
        }
    }

    #[cfg(test)]
    pub fn testing() -> Self {
        Self {
            network: crate::network::NetworkMonitor::disabled(),
            disk: crate::disk::DiskMonitor::disabled(),
            services: ServiceCatalog::default(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation {
    Ping,
    NetworkSnapshot,
    DiskSnapshot {},
    Terminate {
        pid: u32,
        create_time: i64,
        /// The caller already confirmed a critical process can be ended.
        #[serde(default)]
        force: bool,
    },
    Priority {
        pid: u32,
        create_time: i64,
        priority: Priority,
    },
    Efficiency {
        pid: u32,
        create_time: i64,
        on: bool,
    },
    ControlService {
        name: String,
        action: ServiceAction,
    },
    // The enum's `rename_all` renames variants only, so camelCase fields need
    // the rule at variant level.
    #[serde(rename_all = "camelCase")]
    ServiceStartType {
        name: String,
        start_type: StartType,
    },
    /// Resets an established IPv4 TCP connection. Added in protocol version 4.
    #[serde(rename_all = "camelCase")]
    CloseConnection {
        local_address: String,
        local_port: u16,
        remote_address: String,
        remote_port: u16,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub protocol: u32,
    pub operation: Operation,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Reply {
    Pong {
        version: String,
        protocol: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diagnostics: Option<crate::diagnostics::ServiceDiagnostics>,
    },
    Done,
    Network(Option<crate::NetworkFrame>),
    Disk(Option<argus_core::disk_process::DiskSnapshot>),
    /// The service's disk query failed: why, in fixed words and codes.
    DiskFailed(argus_core::disk_process::DiskFailure),
    Priority(Priority),
    Error(ActionError),
}

impl Operation {
    pub fn validate(&self) -> Result<(), ActionError> {
        match self {
            // The System process and Idle can never be touched, a zero
            // creation time cannot pin an instance, and a client cannot ask
            // the broker to end itself.
            Self::Terminate {
                pid, create_time, ..
            }
            | Self::Priority {
                pid, create_time, ..
            }
            | Self::Efficiency {
                pid, create_time, ..
            } => {
                if *pid <= 4 || *pid == std::process::id() || *create_time <= 0 {
                    return Err(ActionError::Refused);
                }
            }
            // Address validation for `CloseConnection` lands with the
            // connection module; it needs no process check either way.
            Self::Ping
            | Self::NetworkSnapshot
            | Self::DiskSnapshot {}
            | Self::CloseConnection { .. } => {}
            Self::ControlService { name, .. } | Self::ServiceStartType { name, .. } => {
                if name.trim().is_empty() || name.len() > 256 {
                    return Err(ActionError::Refused);
                }
            }
        }
        Ok(())
    }
}

pub fn execute(operation: Operation, context: &Context, client_pid: u32) -> Reply {
    if let Err(e) = operation.validate() {
        return Reply::Error(e);
    }
    let result = match operation {
        Operation::NetworkSnapshot => return Reply::Network(context.network.snapshot()),
        Operation::DiskSnapshot {} => {
            return match context.disk.snapshot() {
                Some(Ok(frame)) => Reply::Disk(Some(frame)),
                Some(Err(failure)) => Reply::DiskFailed(failure),
                None => Reply::Disk(None),
            };
        }
        Operation::Ping => {
            return Reply::Pong {
                version: crate::VERSION.into(),
                protocol: crate::PROTOCOL,
                diagnostics: crate::diagnostics::snapshot(),
            };
        }
        // A client cannot ask the broker to bypass the host's self-protection.
        Operation::Terminate { pid, .. } if pid == client_pid => Err(ActionError::Refused),
        Operation::Terminate {
            pid,
            create_time,
            force,
        } => actions::terminate(pid, create_time, force),
        Operation::Priority {
            pid,
            create_time,
            priority,
        } => {
            return match actions::set_priority(pid, create_time, priority) {
                Ok(p) => Reply::Priority(p),
                Err(e) => Reply::Error(e),
            };
        }
        Operation::Efficiency {
            pid,
            create_time,
            on,
        } => actions::set_efficiency_mode(pid, create_time, on),
        Operation::ControlService { name, action } => context.services.control(&name, action),
        Operation::ServiceStartType { name, start_type } => {
            context.services.set_start_type(&name, start_type)
        }
        // Replaced when the connection module is ported.
        Operation::CloseConnection { .. } => return Reply::Error(ActionError::Refused),
    };
    result.map_or_else(Reply::Error, |_| Reply::Done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_snapshot_is_fixed_and_fits_the_reply_budget() {
        assert!(serde_json::from_str::<Operation>(r#"{"op":"diskSnapshot","pid":42}"#).is_err());
        let reply = Reply::Disk(Some(argus_core::disk_process::DiskSnapshot {
            sampled_at_ms: u64::MAX,
            counters: vec![
                (u32::MAX, i64::MAX, u64::MAX, u64::MAX);
                argus_core::disk_process::MAX_PROCESSES
            ],
        }));
        let bytes = serde_json::to_vec(&reply).unwrap();
        assert!(bytes.len() < MAX_REPLY);
        assert!(serde_json::from_slice::<Reply>(&bytes).is_ok());
        assert!(matches!(
            execute(Operation::DiskSnapshot {}, &Context::testing(), 123),
            Reply::Disk(None)
        ));
        // A failure crosses as its category and code, nothing else.
        use argus_core::disk_process::DiskFailure;
        for failure in [
            DiskFailure::Query(0xC000_0022_u32 as i32),
            DiskFailure::Length,
            DiskFailure::Misaligned,
            DiskFailure::Truncated,
            DiskFailure::ProcessId,
            DiskFailure::TooMany,
        ] {
            let bytes = serde_json::to_vec(&Reply::DiskFailed(failure)).unwrap();
            assert!(matches!(
                serde_json::from_slice::<Reply>(&bytes).unwrap(),
                Reply::DiskFailed(back) if back == failure
            ));
        }
        assert_eq!(
            serde_json::to_string(&Reply::DiskFailed(DiskFailure::Query(-1073741790))).unwrap(),
            r#"{"kind":"diskFailed","value":{"query":-1073741790}}"#
        );
        assert!(serde_json::from_str::<Reply>(r#"{"kind":"diskFailed","value":"path"}"#).is_err());
    }

    #[test]
    fn largest_network_snapshot_fits_the_reply_budget() {
        let reply = Reply::Network(Some(crate::NetworkFrame {
            epoch: "0".repeat(38),
            elapsed_us: u64::MAX,
            counters: (0..crate::network::MAX_COUNTERS)
                .map(|_| (u32::MAX, u64::MAX, u64::MAX, u64::MAX, u64::MAX))
                .collect(),
        }));
        assert!(serde_json::to_vec(&reply).unwrap().len() < MAX_REPLY);
    }

    #[test]
    fn rejects_unchecked_processes() {
        assert!(
            Operation::Terminate {
                pid: 100,
                create_time: 0,
                force: false,
            }
            .validate()
            .is_err()
        );
        assert!(
            Operation::Terminate {
                pid: 4,
                create_time: 1,
                force: false,
            }
            .validate()
            .is_err()
        );
        assert!(
            Operation::Terminate {
                pid: 0,
                create_time: 1,
                force: false,
            }
            .validate()
            .is_err()
        );
        // The broker itself is never a target.
        assert!(
            Operation::Efficiency {
                pid: std::process::id(),
                create_time: 1,
                on: true,
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn service_operations_are_fixed_and_validated() {
        let operation: Operation = serde_json::from_str(
            r#"{"op":"controlService","name":"Spooler","action":"restart"}"#,
        )
        .unwrap();
        assert!(matches!(
            operation,
            Operation::ControlService { action: ServiceAction::Restart, .. }
        ));
        let operation: Operation = serde_json::from_str(
            r#"{"op":"serviceStartType","name":"Spooler","startType":"autoDelayed"}"#,
        )
        .unwrap();
        assert!(matches!(
            operation,
            Operation::ServiceStartType {
                start_type: StartType::AutoDelayed,
                ..
            }
        ));

        // Unknown actions, snake_case fields and extra fields are rejected.
        for bad in [
            r#"{"op":"controlService","name":"x","action":"pause"}"#,
            r#"{"op":"serviceStartType","name":"x","start_type":"auto"}"#,
            r#"{"op":"controlService","name":"x","action":"start","pid":1}"#,
            r#"{"op":"serviceStartType","name":"x","startType":"boot"}"#,
        ] {
            assert!(serde_json::from_str::<Operation>(bad).is_err(), "{bad}");
        }

        // An empty or overlong name never reaches the SCM.
        for operation in [
            Operation::ControlService {
                name: String::new(),
                action: ServiceAction::Start,
            },
            Operation::ControlService {
                name: "   ".into(),
                action: ServiceAction::Stop,
            },
            Operation::ServiceStartType {
                name: "x".repeat(257),
                start_type: StartType::Manual,
            },
        ] {
            assert!(operation.validate().is_err());
        }
        assert!(
            Operation::ControlService {
                name: "Spooler".into(),
                action: ServiceAction::Start,
            }
            .validate()
            .is_ok()
        );
    }

    #[test]
    fn rejects_unknown_operations_and_fields() {
        assert!(serde_json::from_str::<Operation>(r#"{"op":"reboot"}"#).is_err());
        assert!(serde_json::from_str::<Operation>(r#"{"op":"restoreTaskManager"}"#).is_err());
        assert!(
            serde_json::from_str::<Operation>(
                r#"{"op":"terminate","pid":5,"create_time":1,"reason":"x"}"#
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<Request>(
                r#"{"protocol":1,"operation":{"op":"execute","command":"cmd"}}"#
            )
            .is_err()
        );
        // A missing force is a non-forced termination, never a bypass.
        assert!(matches!(
            serde_json::from_str::<Operation>(r#"{"op":"terminate","pid":5,"create_time":1}"#)
                .unwrap(),
            Operation::Terminate { force: false, .. }
        ));
        // Version mismatches deserialize; the pipe rejects them before running.
        assert!(
            serde_json::from_str::<Request>(
                r#"{"protocol":99,"operation":{"op":"networkSnapshot"}}"#
            )
            .is_ok()
        );
    }
}
