//! Internal contracts shared by the Windows adapters and the application domain.
//!
//! The reference engine used a cross-platform `Platform` trait. This port is
//! Windows-only, so the subset of platform shapes the application domain needs
//! lives here instead. Public wire models stay in `applications::models`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::applications::models::{
    ApplicationUninstallExecutionMode, ApplicationUninstallInstallerKind,
    ApplicationUninstallInventorySource,
};
use crate::platform::contracts::ApplicationUninstallDiagnostic;

/// Prefix of the opaque application identifier exposed to the UI.
pub(crate) const APPLICATION_ID_PREFIX: &str = "application-";

/// Stable identifier derived from the platform catalog identity.
pub(crate) fn application_id_for(catalog_identifier: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"systools-application-uninstall-v1");
    hasher.update(catalog_identifier.as_bytes());
    format!("{APPLICATION_ID_PREFIX}{}", &hasher.finalize().to_hex()[..24])
}

/// Cooperative cancellation shared by every cancellable application operation.
#[derive(Clone, Debug, Default)]
pub(crate) struct Cancellation {
    cancelled: Arc<AtomicBool>,
}

impl Cancellation {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub(crate) struct SystemInventory {
    pub(crate) applications: Vec<InstalledApplication>,
    /// False when at least one inventory source was unavailable or incomplete.
    pub(crate) complete: bool,
    pub(crate) revision: String,
}

/// One application record merged from every inventory source that owns it.
#[derive(Debug, Clone)]
pub(crate) struct InstalledApplication {
    /// Stable catalog identity. It never changes when another source enriches
    /// the same record.
    pub(crate) catalog_identifier: String,
    /// Primary platform identity: the uninstall registry key, the AppX package
    /// family name, or the Scoop package name.
    pub(crate) primary_identifier: String,
    pub(crate) identifiers: Vec<String>,
    pub(crate) source_identities: Vec<ApplicationSourceIdentity>,
    /// Signed as part of the operating system. Presentation evidence only.
    pub(crate) system_signed: bool,
    pub(crate) name: String,
    pub(crate) version: Option<String>,
    pub(crate) publisher: Option<String>,
    pub(crate) estimated_bytes: u64,
    pub(crate) installed_at_ms: Option<u64>,
    pub(crate) icon_path: Option<PathBuf>,
    pub(crate) bundle_path: Option<PathBuf>,
    pub(crate) executable_paths: Vec<PathBuf>,
    pub(crate) uninstall_registration: Option<ApplicationUninstallRegistration>,
    pub(crate) uninstall_diagnostic: Option<ApplicationUninstallDiagnostic>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum ApplicationInventorySource {
    WindowsRegistry,
    WindowsMsi,
    WindowsAppx,
    Winget,
    Steam,
    Scoop,
    Chocolatey,
}

impl ApplicationInventorySource {
    pub(crate) fn to_model(self) -> ApplicationUninstallInventorySource {
        match self {
            Self::WindowsRegistry => ApplicationUninstallInventorySource::WindowsRegistry,
            Self::WindowsMsi => ApplicationUninstallInventorySource::WindowsMsi,
            Self::WindowsAppx => ApplicationUninstallInventorySource::WindowsAppx,
            Self::Winget => ApplicationUninstallInventorySource::Winget,
            Self::Steam => ApplicationUninstallInventorySource::Steam,
            Self::Scoop => ApplicationUninstallInventorySource::Scoop,
            Self::Chocolatey => ApplicationUninstallInventorySource::Chocolatey,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct ApplicationSourceIdentity {
    pub(crate) source: ApplicationInventorySource,
    pub(crate) identifier: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum ApplicationInstallScope {
    CurrentUser,
    Machine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsRegistryView {
    Registry32,
    Registry64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsRegisteredUninstallKind {
    Executable,
    BatchScript,
    Rundll32,
    UserPowerShellScript,
    WingetProduct,
}

/// Typed uninstall authority discovered by the platform inventory.
///
/// Free-form command strings never cross this boundary: the descriptor keeps
/// the registry identity plus a digest of the validated command, and execution
/// reopens the same key and verifies the digest before launching anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ApplicationUninstallRegistration {
    WindowsMsi {
        product_code: String,
        scope: ApplicationInstallScope,
        estimated_bytes: u64,
    },
    WindowsAppx {
        package_family_name: String,
        package_full_name: String,
        estimated_bytes: u64,
    },
    WindowsRegistered {
        key_name: String,
        scope: ApplicationInstallScope,
        registry_view: WindowsRegistryView,
        command_kind: WindowsRegisteredUninstallKind,
        command_digest: String,
        estimated_bytes: u64,
    },
    Winget {
        package_id: String,
        source_name: String,
        estimated_bytes: u64,
    },
}

impl ApplicationUninstallRegistration {
    pub(crate) fn estimated_bytes(&self) -> u64 {
        match self {
            Self::WindowsMsi { estimated_bytes, .. }
            | Self::WindowsAppx { estimated_bytes, .. }
            | Self::WindowsRegistered { estimated_bytes, .. }
            | Self::Winget { estimated_bytes, .. } => *estimated_bytes,
        }
    }

    pub(crate) fn installer_kind(&self) -> ApplicationUninstallInstallerKind {
        match self {
            Self::WindowsMsi { .. } => ApplicationUninstallInstallerKind::WindowsMsi,
            Self::WindowsAppx { .. } => ApplicationUninstallInstallerKind::WindowsAppx,
            Self::WindowsRegistered { .. } => ApplicationUninstallInstallerKind::WindowsRegistered,
            Self::Winget { .. } => ApplicationUninstallInstallerKind::WindowsRegistered,
        }
    }

    pub(crate) fn execution_mode(&self) -> ApplicationUninstallExecutionMode {
        match self {
            Self::WindowsMsi { .. } | Self::WindowsAppx { .. } => {
                ApplicationUninstallExecutionMode::Silent
            }
            Self::WindowsRegistered { .. } => ApplicationUninstallExecutionMode::Interactive,
            Self::Winget { .. } => ApplicationUninstallExecutionMode::ExternalClient,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApplicationUninstallRegistrationState {
    Installed,
    Absent,
    Incomplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApplicationUninstallExecutionOutcome {
    Completed,
    RestartRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApplicationUninstallPlatformError {
    Unsupported,
    RequiresElevation,
    UserCancelled,
    RegistrationChanged,
    /// Execution ended, but the exact installation could not be confirmed absent.
    RemovalUnconfirmed,
    /// Dispatch may have started, but its process handle was not delivered. Never replay it.
    LaunchUnconfirmed(u32),
    NativeFailure(u32),
    /// The vendor failed, but postflight verified that this exact registration is absent.
    NativeFailureAfterRemoval(u32),
}

impl ApplicationUninstallPlatformError {
    pub(crate) const fn stable_code(self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported",
            Self::RequiresElevation => "requires_elevation",
            Self::UserCancelled => "user_cancelled",
            Self::RegistrationChanged => "registration_changed",
            Self::RemovalUnconfirmed => "removal_unconfirmed",
            Self::LaunchUnconfirmed(_) => "launch_unconfirmed",
            Self::NativeFailure(_) => "native_failure",
            Self::NativeFailureAfterRemoval(_) => "native_failure_after_removal",
        }
    }

    pub(crate) const fn native_code(self) -> Option<u32> {
        match self {
            Self::NativeFailure(code)
            | Self::NativeFailureAfterRemoval(code)
            | Self::LaunchUnconfirmed(code) => Some(code),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunningProcessIdentity {
    pub(crate) executable_name: String,
    pub(crate) executable_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ApplicationProcessTarget {
    pub(crate) executable_names: Vec<String>,
    pub(crate) executable_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApplicationProcessCloseMode {
    Graceful,
    Force,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ApplicationProcessCloseResult {
    pub(crate) matched_process_count: u64,
    pub(crate) requested_process_count: u64,
    pub(crate) remaining_processes: Vec<String>,
}

impl From<ApplicationProcessCloseMode> for crate::applications::models::ApplicationCloseMode {
    fn from(mode: ApplicationProcessCloseMode) -> Self {
        match mode {
            ApplicationProcessCloseMode::Graceful => {
                crate::applications::models::ApplicationCloseMode::Graceful
            }
            ApplicationProcessCloseMode::Force => {
                crate::applications::models::ApplicationCloseMode::Force
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_are_stable_and_prefixed() {
        let id = application_id_for("HKLM\\Uninstall\\Example");
        assert_eq!(id, application_id_for("HKLM\\Uninstall\\Example"));
        assert_ne!(id, application_id_for("HKLM\\Uninstall\\Other"));
        assert!(id.starts_with(APPLICATION_ID_PREFIX));
        assert_eq!(id.len(), APPLICATION_ID_PREFIX.len() + 24);
    }

    #[test]
    fn cancellation_is_shared_between_clones() {
        let cancellation = Cancellation::new();
        let clone = cancellation.clone();
        assert!(!clone.is_cancelled());
        cancellation.cancel();
        assert!(clone.is_cancelled());
    }
}
