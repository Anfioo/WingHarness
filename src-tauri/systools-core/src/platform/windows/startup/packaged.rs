//! Packaged (MSIX/UWP) startup tasks declared in package manifests.
//!
//! Windows exposes the manifest declaration through PowerShell rather than a
//! native startup enumeration API. The script is a hard-coded constant with no
//! caller-controlled interpolation, and the child process is fully bounded.

use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::platform::windows::child_process::hidden_command;
use crate::startup::platform::{
    PlatformStartupArtifact, PlatformStartupConfiguredState, PlatformStartupControlCapability,
    PlatformStartupCoverageReason, PlatformStartupCoverageStatus, PlatformStartupDiagnosticCode,
    PlatformStartupIdentityConfidence, PlatformStartupOwner, PlatformStartupRuntimeState,
    PlatformStartupScope, PlatformStartupSourceKind, PlatformStartupSourceResult,
    PlatformStartupSummarySource, PlatformStartupTarget, PlatformStartupTargetKind,
    PlatformStartupTrigger, PlatformStartupTrustState, StartupCancellation,
};

use super::registry::modified_at_ms;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const STARTUP_TASK_SCRIPT: &str = r#"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProgressPreference = 'SilentlyContinue'
$items = @(
  Get-AppxPackage -ErrorAction SilentlyContinue |
    Where-Object { -not $_.IsFramework -and -not $_.IsResourcePackage -and -not $_.IsPartiallyStaged } |
    ForEach-Object {
      $package = $_
      $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction SilentlyContinue
      if ($null -eq $manifest) { return }
      foreach ($application in @($manifest.Package.Applications.Application)) {
        foreach ($extension in @($application.Extensions.Extension)) {
          if ([string]$extension.Category -ne 'windows.startupTask') { continue }
          $startup = $extension.StartupTask
          if ($null -eq $startup) { continue }
          $displayName = [string]$startup.DisplayName
          if (-not $displayName -or $displayName.StartsWith('ms-resource:')) { $displayName = [string]$package.Name }
          $description = [string]$manifest.Package.Properties.Description
          if ($description.StartsWith('ms-resource:')) { $description = '' }
          $publisher = [string]$manifest.Package.Properties.PublisherDisplayName
          if (-not $publisher -or $publisher.StartsWith('ms-resource:')) { $publisher = [string]$package.Publisher }
          [pscustomobject]@{
            packageFamilyName = [string]$package.PackageFamilyName
            packageName = [string]$package.Name
            version = [string]$package.Version
            publisher = $publisher
            description = $description
            installLocation = [string]$package.InstallLocation
            applicationId = [string]$application.Id
            taskId = [string]$startup.TaskId
            displayName = $displayName
            executable = [string]$extension.Executable
          }
        }
      }
    }
)
ConvertTo-Json -InputObject $items -Compress
"#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupTaskRecord {
    package_family_name: String,
    package_name: String,
    version: String,
    publisher: String,
    description: String,
    install_location: String,
    application_id: String,
    task_id: String,
    display_name: String,
    executable: String,
}

pub(super) fn scan(cancellation: &StartupCancellation) -> PlatformStartupSourceResult {
    let started = Instant::now();
    if cancellation.is_cancelled() {
        return result(
            Vec::new(),
            PlatformStartupCoverageStatus::Cancelled,
            Some(PlatformStartupCoverageReason::Cancelled),
            started,
        );
    }
    let json = match powershell_json(cancellation) {
        Ok(json) => json,
        Err(reason) => {
            return result(
                Vec::new(),
                PlatformStartupCoverageStatus::Unavailable,
                Some(reason),
                started,
            );
        }
    };
    let records = match parse_records(&json) {
        Ok(records) => records,
        Err(()) => {
            return result(
                Vec::new(),
                PlatformStartupCoverageStatus::Unavailable,
                Some(PlatformStartupCoverageReason::InvalidData),
                started,
            );
        }
    };
    let items: Vec<_> = records.into_iter().filter_map(record_artifact).collect();
    let state_unavailable = !items.is_empty();
    result(
        items,
        if state_unavailable {
            PlatformStartupCoverageStatus::Partial
        } else {
            PlatformStartupCoverageStatus::Complete
        },
        state_unavailable.then_some(PlatformStartupCoverageReason::StateUnavailable),
        started,
    )
}

fn parse_records(json: &str) -> Result<Vec<StartupTaskRecord>, ()> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Err(());
    }
    if let Ok(records) = serde_json::from_str::<Vec<StartupTaskRecord>>(trimmed) {
        return Ok(records);
    }
    // Windows PowerShell serializes a single-element array as an object in some
    // versions, so accept both shapes rather than failing the whole source.
    serde_json::from_str::<StartupTaskRecord>(trimmed)
        .map(|record| vec![record])
        .map_err(|_| ())
}

fn powershell_json(
    cancellation: &StartupCancellation,
) -> Result<String, PlatformStartupCoverageReason> {
    let powershell =
        system_powershell_path().ok_or(PlatformStartupCoverageReason::ApiUnavailable)?;
    let mut child = hidden_command(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-NoLogo",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            STARTUP_TASK_SCRIPT,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| PlatformStartupCoverageReason::ApiUnavailable)?;
    let stdout = child
        .stdout
        .take()
        .ok_or(PlatformStartupCoverageReason::ApiUnavailable)?;
    let stderr = child
        .stderr
        .take()
        .ok_or(PlatformStartupCoverageReason::ApiUnavailable)?;

    std::thread::scope(|scope| {
        let stdout_reader = scope.spawn(move || read_bounded(stdout, OUTPUT_LIMIT));
        let stderr_reader = scope.spawn(move || discard(stderr));
        let status = wait_with_timeout(&mut child, cancellation);
        let stdout = stdout_reader.join().ok();
        let _ = stderr_reader.join();
        let Some(status) = status? else {
            return Err(PlatformStartupCoverageReason::ApiUnavailable);
        };
        if !status.success() {
            return Err(PlatformStartupCoverageReason::ApiUnavailable);
        }
        match stdout {
            Some(ReaderOutcome::Complete(bytes)) => String::from_utf8(bytes)
                .map(|value| value.trim().to_string())
                .map_err(|_| PlatformStartupCoverageReason::InvalidData),
            Some(ReaderOutcome::Limit) => Err(PlatformStartupCoverageReason::InvalidData),
            Some(ReaderOutcome::Failed) | None => {
                Err(PlatformStartupCoverageReason::ApiUnavailable)
            }
        }
    })
}

/// Waits for the child, killing it on cancellation or timeout. `Ok(None)` means
/// the timeout expired; the process is already dead in that case.
fn wait_with_timeout(
    child: &mut std::process::Child,
    cancellation: &StartupCancellation,
) -> Result<Option<std::process::ExitStatus>, PlatformStartupCoverageReason> {
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    loop {
        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(PlatformStartupCoverageReason::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(PlatformStartupCoverageReason::ApiUnavailable);
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

enum ReaderOutcome {
    Complete(Vec<u8>),
    Limit,
    Failed,
}

fn read_bounded(mut pipe: impl Read, limit: usize) -> ReaderOutcome {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => return ReaderOutcome::Complete(buffer),
            Ok(count) => {
                if buffer.len().saturating_add(count) > limit {
                    return ReaderOutcome::Limit;
                }
                buffer.extend_from_slice(&chunk[..count]);
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return ReaderOutcome::Failed,
        }
    }
}

/// Drains stderr so the child cannot block on a full pipe, keeping no content.
fn discard(mut pipe: impl Read) {
    let mut chunk = [0u8; 8 * 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => return,
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return,
        }
    }
}

fn system_powershell_path() -> Option<PathBuf> {
    let system_root = std::env::var_os("SystemRoot")?;
    let path = PathBuf::from(system_root)
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    std::fs::metadata(&path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|_| path)
}

fn record_artifact(record: StartupTaskRecord) -> Option<PlatformStartupArtifact> {
    if record.package_family_name.trim().is_empty() || record.task_id.trim().is_empty() {
        return None;
    }
    let executable_path = (!record.executable.trim().is_empty()).then(|| {
        PathBuf::from(&record.install_location)
            .join(record.executable.trim_start_matches(['\\', '/']))
    });
    let mut diagnostics = vec![PlatformStartupDiagnosticCode::StateUnavailable];
    if executable_path
        .as_deref()
        .is_some_and(|path| !path.exists())
    {
        diagnostics.push(PlatformStartupDiagnosticCode::MissingTarget);
    }
    let package_identity = format!(
        "package:{}",
        record.package_family_name.to_ascii_lowercase()
    );
    let display_name = if record.display_name.trim().is_empty() {
        record.package_name.clone()
    } else {
        record.display_name.clone()
    };
    Some(PlatformStartupArtifact {
        provider_item_id: format!(
            "packaged-task:{}:{}",
            record.package_family_name.to_ascii_lowercase(),
            format!("{}:{}", record.application_id, record.task_id).to_ascii_lowercase()
        ),
        source_kind: PlatformStartupSourceKind::PackagedStartupTask,
        scope: PlatformStartupScope::CurrentUser,
        triggers: vec![PlatformStartupTrigger::UserLogon],
        display_name: display_name.clone(),
        configuration_path: None,
        target: PlatformStartupTarget {
            kind: PlatformStartupTargetKind::Application,
            identity_key: package_identity.clone(),
            path: executable_path.clone(),
            executable_name: executable_path
                .as_deref()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                .map(ToOwned::to_owned),
            arguments: Vec::new(),
        },
        owner: PlatformStartupOwner {
            identity_key: Some(package_identity),
            name: Some(display_name),
            publisher: nonempty(record.publisher),
            summary: nonempty(record.description),
            summary_source: PlatformStartupSummarySource::PackageManifest,
            version: nonempty(record.version),
            icon_path: executable_path.clone().filter(|path| path.exists()),
            confidence: PlatformStartupIdentityConfidence::Exact,
        },
        // Windows intentionally restricts third-party re-enabling after a user disables a packaged
        // startup task. Until a supported cross-package state API exists, preserve the declaration
        // and expose the state limitation instead of inferring enabled from manifest presence.
        configured_state: PlatformStartupConfiguredState::Unknown,
        runtime_state: PlatformStartupRuntimeState::Unknown,
        control_capability: PlatformStartupControlCapability::SystemManaged,
        trust: PlatformStartupTrustState::Unknown,
        modified_at_ms: executable_path.as_deref().and_then(modified_at_ms),
        diagnostics,
    })
}

fn nonempty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn result(
    items: Vec<PlatformStartupArtifact>,
    status: PlatformStartupCoverageStatus,
    reason: Option<PlatformStartupCoverageReason>,
    started: Instant,
) -> PlatformStartupSourceResult {
    PlatformStartupSourceResult {
        source_id: "windows.packaged_startup_tasks".to_string(),
        required: true,
        status,
        reason,
        items,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_require_package_and_task_identity() {
        let record = StartupTaskRecord {
            package_family_name: String::new(),
            package_name: "fixture".into(),
            version: "1.0.0.0".into(),
            publisher: String::new(),
            description: String::new(),
            install_location: r"C:\Fixture".into(),
            application_id: "App".into(),
            task_id: "Startup".into(),
            display_name: "Fixture".into(),
            executable: "fixture.exe".into(),
        };
        assert!(record_artifact(record).is_none());
    }

    #[test]
    fn single_object_and_array_payloads_are_both_accepted() {
        let object = r#"{"packageFamilyName":"Fixture_abc","packageName":"Fixture","version":"1.0.0.0","publisher":"Fixture","description":"","installLocation":"C:\\Fixture","applicationId":"App","taskId":"Startup","displayName":"Fixture","executable":"fixture.exe"}"#;
        assert_eq!(parse_records(object).expect("an object must parse").len(), 1);
        assert_eq!(
            parse_records(&format!("[{object}]"))
                .expect("an array must parse")
                .len(),
            1
        );
        assert!(parse_records("").is_err());
        assert!(parse_records("not json").is_err());
    }

    #[test]
    fn packaged_task_identity_is_lowercase_and_stable() {
        let artifact = record_artifact(StartupTaskRecord {
            package_family_name: "Fixture_ABC".into(),
            package_name: "Fixture".into(),
            version: "1.0.0.0".into(),
            publisher: "Fixture".into(),
            description: "Fixture package".into(),
            install_location: r"C:\Fixture".into(),
            application_id: "App".into(),
            task_id: "Startup".into(),
            display_name: "Fixture".into(),
            executable: "fixture.exe".into(),
        })
        .expect("a complete record must produce an artifact");

        assert_eq!(
            artifact.provider_item_id,
            "packaged-task:fixture_abc:app:startup"
        );
        assert_eq!(
            artifact.control_capability,
            PlatformStartupControlCapability::SystemManaged
        );
        assert!(artifact
            .diagnostics
            .contains(&PlatformStartupDiagnosticCode::StateUnavailable));
    }
}
