//! Windows leftover discovery and reviewed permanent cleanup.
//!
//! A scan is read-only and bounded. It compares three kinds of evidence:
//! registry uninstall entries whose installation is gone, application facts
//! observed on earlier scans that the current catalog no longer lists, and the
//! leftover history written by earlier cleanups. Only directories, shortcuts,
//! and registry keys that match one of those removed applications are offered.
//!
//! Execution re-reads every candidate immediately before touching it, rechecks
//! that no installed application owns it, and compares the snapshot fingerprint
//! the user reviewed. One failed item never aborts the rest of the batch.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, REG_DWORD, REG_EXPAND_SZ, REG_SZ};
use winreg::RegKey;

use crate::applications::catalog::{Catalog, ProcessSnapshot};
use crate::applications::contracts::Cancellation;
use crate::applications::leftovers::deletion;
use crate::applications::models::{
    ApplicationLeftoverActionReason, ApplicationLeftoverActionResult,
    ApplicationLeftoverActionStatus, ApplicationLeftoverCandidate, ApplicationLeftoverConfidence,
    ApplicationLeftoverEvidence, ApplicationLeftoverPlanItem, ApplicationLeftoverResult,
    ApplicationLeftoverScanProgress, ApplicationLeftoverScanResult, ApplicationLeftoverScanStage,
    ApplicationLeftoverSource, APPLICATION_LEFTOVER_SCAN_SCHEMA_VERSION,
};
use crate::applications::progress::{LeftoverProgressSink, LeftoverScanProgressReporter};
use crate::applications::{process_control, service_state};
use crate::error::{SystoolsError, SystoolsResult};
use crate::platform::windows::shortcut_name;
use crate::shared::operation::{take_cancellation, CoordinatedOperationKind};

const MAX_CANDIDATES: usize = 500;
const SCAN_TIME_BUDGET: Duration = Duration::from_secs(20);
const MAX_MEASURED_ENTRIES: usize = 200_000;
const MAX_REGISTRY_KEYS: usize = 5_000;
const HISTORY_FILE_NAME: &str = "leftover-history.json";
const OBSERVATION_FILE_NAME: &str = "leftover-observations.json";
const HISTORY_SCHEMA_VERSION: u32 = 1;
const OBSERVATION_SCHEMA_VERSION: u32 = 1;
const HISTORY_LIMIT: usize = 200;
const OBSERVATION_LIMIT: usize = 400;

const UNINSTALL_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
const UNINSTALL_WOW64_KEY_PATH: &str =
    r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";

/// Shared vendor directories that must never be matched by a publisher or a
/// short application name, even when a removed application shares the token.
const SHARED_DIRECTORY_NAMES: &[&str] = &[
    "microsoft",
    "google",
    "mozilla",
    "adobe",
    "apple",
    "nvidia",
    "intel",
    "amd",
    "windows",
    "packages",
    "programs",
    "temp",
    "tmp",
    "commonfiles",
    "packagecache",
    "d3dscache",
    "crashdumps",
    "connecteddevicesplatform",
    "comms",
    "history",
    "temporaryinternetfiles",
    "applicationdata",
    "local",
    "roaming",
    "system32",
    "syswow64",
    "windowsapps",
    "microsoftedge",
    "edge",
    "onedrive",
    "dropbox",
    "steam",
    "epicgames",
    "gog",
    "ubisoft",
    "ea",
    "battle.net",
    "blizzard",
    "origin",
    "desktop",
    "documents",
    "downloads",
    "pictures",
    "music",
    "videos",
    "links",
    "favorites",
    "contacts",
    "savedgames",
    "searches",
    "3dobjects",
    "startmenu",
    "appdata",
    "userdata",
    "default",
    "public",
    "allusers",
    "defaultuser",
    "defaultuser0",
];

static ACTIVE_SCAN: OnceLock<Mutex<Option<Cancellation>>> = OnceLock::new();
static LAST_SCAN: OnceLock<Mutex<Vec<ApplicationLeftoverCandidate>>> = OnceLock::new();

fn active_scan_slot() -> &'static Mutex<Option<Cancellation>> {
    ACTIVE_SCAN.get_or_init(|| Mutex::new(None))
}

fn last_scan_slot() -> &'static Mutex<Vec<ApplicationLeftoverCandidate>> {
    LAST_SCAN.get_or_init(|| Mutex::new(Vec::new()))
}

fn lock<T>(slot: &'static Mutex<T>) -> MutexGuard<'static, T> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Requests cancellation of the active leftover scan.
///
/// Execution uses its own coordinated cancellation token, so this only affects
/// a running scan.
pub(crate) fn cancel() {
    if let Some(cancellation) = lock(active_scan_slot()).as_ref() {
        cancellation.cancel();
    }
}

/// Scans for leftovers of applications that the cached catalog no longer lists.
pub(crate) fn scan(
    cancellation: &Cancellation,
    progress_sink: LeftoverProgressSink<'_>,
) -> SystoolsResult<ApplicationLeftoverScanResult> {
    let _scan_guard = ScanGuard::install(cancellation.clone());
    let Some(catalog) = service_state::current() else {
        log::warn!("systools_leftover_scan_failed reason=application_catalog_unavailable");
        return Err(SystoolsError::invalid_input("systools_leftovers_scan"));
    };
    let progress = LeftoverScanProgressReporter::new(progress_sink);
    scan_with_catalog(cancellation, catalog.as_ref(), &progress)
}

fn scan_with_catalog(
    cancellation: &Cancellation,
    catalog: &Catalog,
    progress: &LeftoverScanProgressReporter<'_>,
) -> SystoolsResult<ApplicationLeftoverScanResult> {
    let started = Instant::now();
    let now_ms = unix_time_ms();
    let installed = installed_facts(catalog);

    let mut observations = load_observations();
    update_observations(&mut observations, &installed, now_ms);
    save_observations(&observations);

    let history = load_history();
    let mut state = ScanState::new(cancellation, started, installed, &observations, &history);

    progress.report(ApplicationLeftoverScanStage::UninstallRegistry, 5);
    scan_uninstall_registry(&mut state)?;
    progress.report(ApplicationLeftoverScanStage::OrphanRegistryGroups, 20);
    scan_orphan_registry_groups(&mut state)?;
    progress.report(ApplicationLeftoverScanStage::DataDirectories, 35);
    scan_data_directories(&mut state, progress)?;
    progress.report(ApplicationLeftoverScanStage::Shortcuts, 88);
    scan_shortcuts(&mut state)?;
    progress.report(ApplicationLeftoverScanStage::Shortcuts, 96);

    state
        .candidates
        .sort_by(|left, right| {
            left.application_name
                .to_ascii_lowercase()
                .cmp(&right.application_name.to_ascii_lowercase())
                .then_with(|| left.path.cmp(&right.path))
        });
    if state.candidates.len() > MAX_CANDIDATES {
        let dropped = state.candidates.len() - MAX_CANDIDATES;
        state.candidates.truncate(MAX_CANDIDATES);
        state.skipped = state.skipped.saturating_add(dropped as u64);
        state.truncated = true;
    }

    let inventory_complete = catalog.inventory.complete
        && !state.access_limited
        && !state.truncated
        && !cancellation.is_cancelled();
    // An incomplete inventory cannot prove that a directory is unowned, so the
    // whole result is presented for review only.
    if !inventory_complete {
        for candidate in &mut state.candidates {
            candidate.default_selected = false;
        }
    }

    let total_bytes = state
        .candidates
        .iter()
        .fold(0_u64, |total, item| total.saturating_add(item.bytes));
    let total_file_count = state
        .candidates
        .iter()
        .fold(0_u64, |total, item| total.saturating_add(item.file_count));
    let result = ApplicationLeftoverScanResult {
        schema_version: APPLICATION_LEFTOVER_SCAN_SCHEMA_VERSION,
        scanned_at_ms: now_ms,
        supported: true,
        inventory_complete,
        access_limited: state.access_limited,
        candidates: state.candidates.clone(),
        total_bytes,
        total_file_count,
        skipped_count: state.skipped,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    *lock(last_scan_slot()) = result.candidates.clone();
    log::info!(
        "systools_leftover_scan_finished candidates={} total_bytes={} skipped={} access_limited={} inventory_complete={} elapsed_ms={}",
        result.candidates.len(),
        result.total_bytes,
        result.skipped_count,
        result.access_limited,
        result.inventory_complete,
        result.elapsed_ms
    );
    Ok(result)
}

struct ScanGuard;

impl ScanGuard {
    fn install(cancellation: Cancellation) -> Self {
        *lock(active_scan_slot()) = Some(cancellation);
        Self
    }
}

impl Drop for ScanGuard {
    fn drop(&mut self) {
        *lock(active_scan_slot()) = None;
    }
}

// ---------------------------------------------------------------------------
// Application facts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct AppFact {
    identifier: String,
    name: String,
    publisher: Option<String>,
    normalized_name: String,
    normalized_publisher: Option<String>,
}

impl AppFact {
    fn new(name: &str, publisher: Option<&str>) -> Option<Self> {
        let normalized_name = normalize_token(name);
        if normalized_name.is_empty() {
            return None;
        }
        let publisher = publisher
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let normalized_publisher = publisher
            .as_deref()
            .map(normalize_token)
            .filter(|value| value.chars().count() >= 3);
        Some(Self {
            identifier: application_identifier(&normalized_name, normalized_publisher.as_deref()),
            name: name.trim().to_string(),
            publisher,
            normalized_name,
            normalized_publisher,
        })
    }
}

/// One application that is no longer installed but left artifacts behind.
#[derive(Debug, Clone)]
struct RemovedFact {
    identifier: String,
    name: String,
    publisher: Option<String>,
    normalized_name: String,
    normalized_publisher: Option<String>,
    related_paths: Vec<PathBuf>,
}

impl RemovedFact {
    fn new(name: &str, publisher: Option<&str>, related_paths: Vec<PathBuf>) -> Option<Self> {
        let normalized_name = normalize_token(name);
        if normalized_name.chars().count() < 2 {
            return None;
        }
        let publisher = publisher
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let normalized_publisher = publisher
            .as_deref()
            .map(normalize_token)
            .filter(|value| value.chars().count() >= 3);
        Some(Self {
            identifier: application_identifier(&normalized_name, normalized_publisher.as_deref()),
            name: name.trim().to_string(),
            publisher,
            normalized_name,
            normalized_publisher,
            related_paths,
        })
    }
}

fn installed_facts(catalog: &Catalog) -> Vec<AppFact> {
    catalog
        .applications()
        .iter()
        .filter_map(|application| {
            AppFact::new(&application.name, application.publisher.as_deref())
        })
        .collect()
}

fn application_identifier(normalized_name: &str, normalized_publisher: Option<&str>) -> String {
    format!(
        "{}|{}",
        normalized_name,
        normalized_publisher.unwrap_or_default()
    )
}

/// Identifier built from raw values, using the same publisher filtering as
/// [`AppFact::new`] so registry candidates match installed facts exactly.
fn identifier_for(name: &str, publisher: Option<&str>) -> String {
    let normalized_name = normalize_token(name);
    let normalized_publisher = publisher
        .map(normalize_token)
        .filter(|value| value.chars().count() >= 3);
    application_identifier(&normalized_name, normalized_publisher.as_deref())
}

/// Lowercase alphanumeric token used for conservative name matching.
fn normalize_token(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect()
}

// ---------------------------------------------------------------------------
// Scan state
// ---------------------------------------------------------------------------

struct ScanState<'a> {
    cancellation: &'a Cancellation,
    deadline: Instant,
    installed: Vec<AppFact>,
    installed_identifiers: HashSet<String>,
    installed_names: HashSet<String>,
    removed: Vec<RemovedFact>,
    candidates: Vec<ApplicationLeftoverCandidate>,
    seen_keys: HashSet<String>,
    skipped: u64,
    access_limited: bool,
    truncated: bool,
}

impl<'a> ScanState<'a> {
    fn new(
        cancellation: &'a Cancellation,
        started: Instant,
        installed: Vec<AppFact>,
        observations: &ObservationFile,
        history: &HistoryFile,
    ) -> Self {
        let installed_identifiers = installed
            .iter()
            .map(|fact| fact.identifier.clone())
            .collect::<HashSet<_>>();
        let installed_names = installed
            .iter()
            .map(|fact| fact.normalized_name.clone())
            .collect::<HashSet<_>>();
        let mut state = Self {
            cancellation,
            deadline: started + SCAN_TIME_BUDGET,
            installed,
            installed_identifiers,
            installed_names,
            removed: Vec::new(),
            candidates: Vec::new(),
            seen_keys: HashSet::new(),
            skipped: 0,
            access_limited: false,
            truncated: false,
        };

        for record in &observations.applications {
            if state.installed_identifiers.contains(&record.identifier) {
                continue;
            }
            state.push_removed(RemovedFact::new(
                &record.name,
                record.publisher.as_deref(),
                Vec::new(),
            ));
        }
        for candidate in history.records.iter().flat_map(|record| &record.candidates) {
            // History contributes names and publishers only. A recorded path's
            // parent is a shared root, so using it for containment would match
            // unrelated shortcuts and directories on later scans.
            state.push_removed(RemovedFact::new(
                &candidate.application_name,
                candidate.publisher.as_deref(),
                Vec::new(),
            ));
        }
        state
    }

    fn check_cancelled(&self) -> SystoolsResult<()> {
        if self.cancellation.is_cancelled() {
            Err(SystoolsError::cancelled())
        } else {
            Ok(())
        }
    }

    fn budget_exhausted(&mut self) -> bool {
        if Instant::now() >= self.deadline {
            self.truncated = true;
            true
        } else {
            false
        }
    }

    fn push_removed(&mut self, fact: Option<RemovedFact>) {
        let Some(fact) = fact else {
            return;
        };
        if self.installed_identifiers.contains(&fact.identifier)
            || self.installed_names.contains(&fact.normalized_name)
        {
            return;
        }
        if let Some(existing) = self
            .removed
            .iter_mut()
            .find(|existing| existing.identifier == fact.identifier)
        {
            for path in fact.related_paths {
                if !existing.related_paths.contains(&path) {
                    existing.related_paths.push(path);
                }
            }
            if existing.publisher.is_none() {
                existing.publisher = fact.publisher;
            }
            return;
        }
        self.removed.push(fact);
    }

    fn has_removed(&self) -> bool {
        !self.removed.is_empty()
    }

    fn push_candidate(&mut self, candidate: ApplicationLeftoverCandidate) {
        let key = candidate_key(&candidate.path);
        if !self.seen_keys.insert(key) {
            return;
        }
        if self.candidates.len() >= MAX_CANDIDATES {
            self.truncated = true;
            self.skipped = self.skipped.saturating_add(1);
            return;
        }
        self.candidates.push(candidate);
    }

    fn match_directory(&self, normalized_name: &str, packages: bool) -> Option<&RemovedFact> {
        self.removed.iter().find(|fact| {
            if packages {
                fact.normalized_name.chars().count() >= 6
                    && normalized_name.contains(&fact.normalized_name)
            } else if normalized_name == fact.normalized_name {
                true
            } else {
                fact.normalized_publisher.as_deref().is_some_and(|publisher| {
                    publisher.chars().count() >= 6 && normalized_name == publisher
                })
            }
        })
    }

    /// Matches a shortcut by any of its names (description, file stem) or by a
    /// target that lives inside a removed application's install location.
    fn match_shortcut(
        &self,
        names: &[Option<&str>],
        target: Option<&Path>,
    ) -> Option<&RemovedFact> {
        let normalized = names
            .iter()
            .filter_map(|value| value.map(normalize_token))
            .collect::<Vec<_>>();
        self.removed.iter().find(|fact| {
            normalized.iter().any(|name| name == &fact.normalized_name)
                || target.is_some_and(|path| {
                    fact.related_paths
                        .iter()
                        .any(|root| path_is_within(path, root))
                })
        })
    }
}

// ---------------------------------------------------------------------------
// Registry scanning
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct RegistryRecord {
    location: String,
    display_name: String,
    publisher: Option<String>,
    install_location: Option<PathBuf>,
    display_icon: Option<PathBuf>,
}

impl RegistryRecord {
    fn fingerprint(&self) -> String {
        let mut detail = String::new();
        detail.push_str(&self.display_name);
        detail.push('\u{1f}');
        if let Some(path) = &self.install_location {
            detail.push_str(&normalize_path_key(path));
        }
        detail.push('\u{1f}');
        if let Some(path) = &self.display_icon {
            detail.push_str(&normalize_path_key(path));
        }
        snapshot_fingerprint(
            "registry",
            &self.location.to_ascii_lowercase(),
            &detail,
            &REGISTRY_SNAPSHOT,
        )
    }
}

const REGISTRY_SNAPSHOT: PathSnapshot = PathSnapshot {
    bytes: 0,
    file_count: 0,
    modified_ms: None,
};

fn scan_uninstall_registry(state: &mut ScanState<'_>) -> SystoolsResult<()> {
    let roots = [
        (HKEY_CURRENT_USER, "HKCU", UNINSTALL_KEY_PATH, false),
        (HKEY_LOCAL_MACHINE, "HKLM", UNINSTALL_KEY_PATH, true),
        (
            HKEY_LOCAL_MACHINE,
            "HKLM",
            UNINSTALL_WOW64_KEY_PATH,
            false,
        ),
    ];
    for (hive, label, path, wow64) in roots {
        state.check_cancelled()?;
        if state.budget_exhausted() {
            return Ok(());
        }
        if state.candidates.len() >= MAX_CANDIDATES {
            state.truncated = true;
            return Ok(());
        }
        let parent = match deletion::open_registry_parent(hive, path, wow64) {
            Ok(parent) => parent,
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(
                        "systools_leftover_registry_unavailable location={label}\\{path} error={error}"
                    );
                    state.access_limited = true;
                }
                continue;
            }
        };
        let mut count = 0_usize;
        for key_name in parent.enum_keys().filter_map(Result::ok) {
            count += 1;
            if count > MAX_REGISTRY_KEYS || state.candidates.len() >= MAX_CANDIDATES {
                state.truncated = true;
                break;
            }
            if count % 64 == 0 {
                state.check_cancelled()?;
                if state.budget_exhausted() {
                    return Ok(());
                }
            }
            let key = match parent.open_subkey_with_flags(&key_name, KEY_READ) {
                Ok(key) => key,
                Err(error) => {
                    log::debug!(
                        "systools_leftover_registry_key_unreadable key={key_name} error={error}"
                    );
                    state.access_limited = true;
                    state.skipped = state.skipped.saturating_add(1);
                    continue;
                }
            };
            let Some(record) = read_registry_record(&key, label, path, &key_name) else {
                continue;
            };
            if state
                .installed
                .iter()
                .any(|fact| fact.normalized_name == normalize_token(&record.display_name))
            {
                continue;
            }
            if !registry_record_is_orphan(&record) {
                continue;
            }
            let candidate = ApplicationLeftoverCandidate {
                candidate_id: candidate_id("registry", &record.location.to_ascii_lowercase()),
                application_identifier: identifier_for(
                    &record.display_name,
                    record.publisher.as_deref(),
                ),
                application_name: record.display_name.clone(),
                source: ApplicationLeftoverSource::Preferences,
                path: record.location.clone(),
                bytes: 0,
                file_count: 0,
                modified_at_ms: None,
                confidence: ApplicationLeftoverConfidence::High,
                default_selected: false,
                evidence: vec![
                    ApplicationLeftoverEvidence::InstalledOwnerAbsent,
                    ApplicationLeftoverEvidence::ExactIdentifierAssociation,
                ],
                snapshot_fingerprint: record.fingerprint(),
            };
            state.push_removed(RemovedFact::new(
                &record.display_name,
                record.publisher.as_deref(),
                record.install_location.iter().cloned().collect(),
            ));
            state.push_candidate(candidate);
        }
    }
    Ok(())
}

fn read_registry_record(
    key: &RegKey,
    hive_label: &str,
    root_path: &str,
    key_name: &str,
) -> Option<RegistryRecord> {
    if read_string_value(key, "ParentKeyName").is_some() {
        return None;
    }
    if read_u32_value(key, "SystemComponent") == Some(1) {
        return None;
    }
    let display_name = read_string_value(key, "DisplayName")?;
    let publisher = read_string_value(key, "Publisher");
    let install_location = read_string_value(key, "InstallLocation")
        .and_then(|value| registry_path_value(&value));
    let display_icon =
        read_string_value(key, "DisplayIcon").and_then(|value| registry_path_value(&value));
    Some(RegistryRecord {
        location: format!("{hive_label}\\{root_path}\\{key_name}"),
        display_name,
        publisher,
        install_location,
        display_icon,
    })
}

fn registry_record_is_orphan(record: &RegistryRecord) -> bool {
    let install_missing = record
        .install_location
        .as_ref()
        .is_some_and(|path| !path.exists());
    let icon_missing = record
        .display_icon
        .as_ref()
        .is_some_and(|path| !path.exists());
    install_missing || (record.install_location.is_none() && icon_missing)
}

fn read_string_value(key: &RegKey, name: &str) -> Option<String> {
    let value = key.get_raw_value(name).ok()?;
    if value.vtype != REG_SZ && value.vtype != REG_EXPAND_SZ {
        return None;
    }
    let decoded = decode_utf16_le(&value.bytes);
    let trimmed = decoded.trim().trim_matches('\0').trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn read_u32_value(key: &RegKey, name: &str) -> Option<u32> {
    let value = key.get_raw_value(name).ok()?;
    if value.vtype != REG_DWORD || value.bytes.len() < 4 {
        return None;
    }
    Some(u32::from_le_bytes([
        value.bytes[0],
        value.bytes[1],
        value.bytes[2],
        value.bytes[3],
    ]))
}

fn decode_utf16_le(bytes: &[u8]) -> String {
    let units = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|value| *value != 0);
    char::decode_utf16(units)
        .map(|decoded| decoded.unwrap_or('\u{fffd}'))
        .collect()
}

/// Expands `%NAME%` tokens and leaves unknown variables untouched.
fn expand_environment(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        result.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                if name.is_empty() {
                    result.push('%');
                } else {
                    match std::env::var(name) {
                        Ok(replacement) => result.push_str(&replacement),
                        Err(_) => {
                            result.push('%');
                            result.push_str(name);
                            result.push('%');
                        }
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                result.push('%');
                result.push_str(after);
                rest = "";
            }
        }
    }
    result.push_str(rest);
    result
}

/// Turns a registry path value into a path, dropping `"` quotes and the icon
/// resource index (`C:\App\app.exe,0`).
fn registry_path_value(value: &str) -> Option<PathBuf> {
    let value = value.trim();
    let value = if let Some(rest) = value.strip_prefix('"') {
        rest.split('"').next().unwrap_or(rest)
    } else {
        match value.rsplit_once(',') {
            Some((path, suffix))
                if !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_digit()) =>
            {
                path
            }
            _ => value,
        }
    };
    let expanded = expand_environment(value.trim());
    let path = PathBuf::from(expanded.trim());
    (!path.as_os_str().is_empty()).then_some(path)
}

fn scan_orphan_registry_groups(state: &mut ScanState<'_>) -> SystoolsResult<()> {
    if !state.has_removed() {
        return Ok(());
    }
    state.check_cancelled()?;
    if state.budget_exhausted() || state.candidates.len() >= MAX_CANDIDATES {
        return Ok(());
    }
    let software = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Software", KEY_READ)
    {
        Ok(key) => key,
        Err(error) => {
            log::debug!("systools_leftover_software_key_unavailable error={error}");
            state.access_limited = true;
            return Ok(());
        }
    };
    for publisher_name in software.enum_keys().filter_map(Result::ok) {
        state.check_cancelled()?;
        if state.budget_exhausted() || state.candidates.len() >= MAX_CANDIDATES {
            return Ok(());
        }
        let publisher_token = normalize_token(&publisher_name);
        if SHARED_DIRECTORY_NAMES.contains(&publisher_token.as_str()) {
            continue;
        }
        let products = state
            .removed
            .iter()
            .filter(|fact| fact.normalized_publisher.as_deref() == Some(publisher_token.as_str()))
            .map(|fact| {
                (
                    fact.normalized_name.clone(),
                    fact.name.clone(),
                    fact.identifier.clone(),
                )
            })
            .collect::<Vec<_>>();
        if products.is_empty() {
            continue;
        }
        let publisher_key = match software.open_subkey_with_flags(&publisher_name, KEY_READ) {
            Ok(key) => key,
            Err(error) => {
                log::debug!(
                    "systools_leftover_publisher_unreadable publisher={publisher_name} error={error}"
                );
                state.access_limited = true;
                continue;
            }
        };
        for product_name in publisher_key.enum_keys().filter_map(Result::ok) {
            state.check_cancelled()?;
            if state.budget_exhausted() || state.candidates.len() >= MAX_CANDIDATES {
                return Ok(());
            }
            let product_token = normalize_token(&product_name);
            let Some((_, application_name, fact_identifier)) = products
                .iter()
                .find(|(token, _, _)| *token == product_token)
            else {
                continue;
            };
            // Read the key through the same path the executor will use, so the
            // fingerprint reviewed here matches the one measured before delete.
            let Ok(product_key) = publisher_key.open_subkey_with_flags(&product_name, KEY_READ)
            else {
                state.access_limited = true;
                state.skipped = state.skipped.saturating_add(1);
                continue;
            };
            let Some(record) = read_registry_record(
                &product_key,
                "HKCU",
                &format!("Software\\{publisher_name}"),
                &product_name,
            ) else {
                continue;
            };
            let candidate = ApplicationLeftoverCandidate {
                candidate_id: candidate_id("registry", &record.location.to_ascii_lowercase()),
                application_identifier: fact_identifier.clone(),
                application_name: application_name.clone(),
                source: ApplicationLeftoverSource::Preferences,
                path: record.location.clone(),
                bytes: 0,
                file_count: 0,
                modified_at_ms: None,
                confidence: ApplicationLeftoverConfidence::High,
                default_selected: false,
                evidence: vec![
                    ApplicationLeftoverEvidence::InstalledOwnerAbsent,
                    ApplicationLeftoverEvidence::ExactIdentifierAssociation,
                ],
                snapshot_fingerprint: record.fingerprint(),
            };
            state.push_candidate(candidate);
        }
    }
    Ok(())
}

/// Re-reads one registry key exactly as the scanner recorded it.
fn registry_record(location: &str) -> Option<RegistryRecord> {
    let (hive, path) = location.split_once('\\')?;
    let (hive, label) = match hive.to_ascii_uppercase().as_str() {
        "HKCU" => (HKEY_CURRENT_USER, "HKCU"),
        "HKLM" => (HKEY_LOCAL_MACHINE, "HKLM"),
        _ => return None,
    };
    let (root_path, key_name) = path.rsplit_once('\\')?;
    // Keys under WOW6432Node live in the 32-bit view; everything else is read
    // from the 64-bit view regardless of the process bitness.
    let wow64 = !path.to_ascii_uppercase().contains("WOW6432NODE");
    let parent = deletion::open_registry_parent(hive, root_path, wow64).ok()?;
    let key = parent.open_subkey_with_flags(key_name, KEY_READ).ok()?;
    read_registry_record(&key, label, root_path, key_name)
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RootKind {
    LocalData,
    RoamingData,
    LocalPrograms,
    ProgramData,
    Temp,
    Public,
    ProgramFiles,
    Packages,
}

impl RootKind {
    fn default_selected(self) -> bool {
        matches!(self, Self::LocalData | Self::RoamingData | Self::Packages)
    }
}

struct DirectoryRoot {
    path: PathBuf,
    kind: RootKind,
}

fn environment_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn directory_roots() -> Vec<DirectoryRoot> {
    let mut roots = Vec::new();
    let local = environment_path("LOCALAPPDATA");
    let roaming = environment_path("APPDATA");
    let program_data = environment_path("PROGRAMDATA");
    let program_files =
        environment_path("ProgramFiles").or_else(|| environment_path("ProgramW6432"));
    let temp = environment_path("TEMP").or_else(|| environment_path("TMP"));
    let public = environment_path("PUBLIC");

    if let Some(path) = &local {
        roots.push(DirectoryRoot {
            path: path.clone(),
            kind: RootKind::LocalData,
        });
        roots.push(DirectoryRoot {
            path: path.join("Programs"),
            kind: RootKind::LocalPrograms,
        });
        roots.push(DirectoryRoot {
            path: path.join("Packages"),
            kind: RootKind::Packages,
        });
    }
    if let Some(path) = &roaming {
        roots.push(DirectoryRoot {
            path: path.clone(),
            kind: RootKind::RoamingData,
        });
    }
    for (path, kind) in [
        (program_data, RootKind::ProgramData),
        (temp, RootKind::Temp),
        (public, RootKind::Public),
        (program_files, RootKind::ProgramFiles),
    ] {
        if let Some(path) = path {
            roots.push(DirectoryRoot { path, kind });
        }
    }
    roots
}

fn scan_data_directories(
    state: &mut ScanState<'_>,
    progress: &LeftoverScanProgressReporter<'_>,
) -> SystoolsResult<()> {
    if !state.has_removed() {
        return Ok(());
    }
    let protected_data = crate::paths::dir().ok().map(|path| path.clone());
    let roots = directory_roots();
    let total_roots = roots.len() as u64;
    for (index, root) in roots.into_iter().enumerate() {
        progress.report_items(
            ApplicationLeftoverScanStage::DataDirectories,
            35 + (index as u64 * 52 / total_roots.max(1)) as u8,
            index as u64,
            Some(total_roots),
            Some(root.path.display().to_string()),
        );
        state.check_cancelled()?;
        if state.budget_exhausted() || state.candidates.len() >= MAX_CANDIDATES {
            return Ok(());
        }
        if !root.path.is_dir() {
            continue;
        }
        let entries = match fs::read_dir(&root.path) {
            Ok(entries) => entries,
            Err(error) => {
                log::debug!(
                    "systools_leftover_directory_unreadable path={} error={error}",
                    root.path.display()
                );
                state.access_limited = true;
                state.skipped = state.skipped.saturating_add(1);
                continue;
            }
        };
        for entry in entries {
            state.check_cancelled()?;
            if state.budget_exhausted() || state.candidates.len() >= MAX_CANDIDATES {
                return Ok(());
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    log::debug!("systools_leftover_directory_entry_failed error={error}");
                    state.access_limited = true;
                    state.skipped = state.skipped.saturating_add(1);
                    continue;
                }
            };
            let metadata = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    log::debug!("systools_leftover_directory_type_failed error={error}");
                    state.access_limited = true;
                    state.skipped = state.skipped.saturating_add(1);
                    continue;
                }
            };
            if !metadata.is_dir() {
                continue;
            }
            let path = entry.path();
            if protected_data.as_ref().is_some_and(|protected| {
                path_is_within(&path, protected) || path_is_within(protected, &path)
            }) {
                continue;
            }
            let Some(name) = path.file_name().map(|value| value.to_string_lossy().to_string())
            else {
                continue;
            };
            let normalized = normalize_token(&name);
            if normalized.is_empty() || SHARED_DIRECTORY_NAMES.contains(&normalized.as_str()) {
                continue;
            }
            let packages = root.kind == RootKind::Packages;
            let Some(fact) = state.match_directory(&normalized, packages).cloned() else {
                continue;
            };
            let snapshot = match measure_path(&path, state.cancellation) {
                Ok(snapshot) => snapshot,
                Err(MeasureError::Cancelled) => return Err(SystoolsError::cancelled()),
                Err(error) => {
                    if error.is_access_limited() {
                        state.access_limited = true;
                    }
                    state.skipped = state.skipped.saturating_add(1);
                    log::debug!(
                        "systools_leftover_directory_skipped path={} reason={}",
                        path.display(),
                        error.as_str()
                    );
                    continue;
                }
            };
            let source = directory_source(root.kind, &name);
            let candidate = ApplicationLeftoverCandidate {
                candidate_id: candidate_id("directory", &normalize_path_key(&path)),
                application_identifier: fact.identifier.clone(),
                application_name: fact.name.clone(),
                source,
                path: path.to_string_lossy().to_string(),
                bytes: snapshot.bytes,
                file_count: snapshot.file_count,
                modified_at_ms: snapshot.modified_ms,
                confidence: ApplicationLeftoverConfidence::High,
                default_selected: root.kind.default_selected()
                    && matches!(
                        source,
                        ApplicationLeftoverSource::ApplicationSupport
                            | ApplicationLeftoverSource::SavedState
                            | ApplicationLeftoverSource::WebData
                            | ApplicationLeftoverSource::Logs
                            | ApplicationLeftoverSource::SandboxContainer
                    ),
                evidence: vec![
                    ApplicationLeftoverEvidence::InstalledOwnerAbsent,
                    ApplicationLeftoverEvidence::FormerBundleMissing,
                    ApplicationLeftoverEvidence::ExactIdentifierAssociation,
                    ApplicationLeftoverEvidence::FilesystemSnapshotComplete,
                ],
                snapshot_fingerprint: snapshot_fingerprint(
                    "directory",
                    &normalize_path_key(&path),
                    &fact.identifier,
                    &snapshot,
                ),
            };
            state.push_candidate(candidate);
        }
    }
    Ok(())
}

fn directory_source(kind: RootKind, name: &str) -> ApplicationLeftoverSource {
    if kind == RootKind::Packages {
        return ApplicationLeftoverSource::SandboxContainer;
    }
    let lower = name.to_ascii_lowercase();
    if lower.contains("logs") || lower.ends_with("log") {
        return ApplicationLeftoverSource::Logs;
    }
    if lower.contains("cache") || lower.contains("temp") {
        return ApplicationLeftoverSource::SavedState;
    }
    ApplicationLeftoverSource::ApplicationSupport
}

// ---------------------------------------------------------------------------
// Shortcut scanning
// ---------------------------------------------------------------------------

fn shortcut_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(appdata) = environment_path("APPDATA") {
        roots.push(
            appdata
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    if let Some(program_data) = environment_path("PROGRAMDATA") {
        roots.push(
            program_data
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    if let Some(profile) = environment_path("USERPROFILE") {
        roots.push(profile.join("Desktop"));
    }
    if let Some(public) = environment_path("PUBLIC") {
        roots.push(public.join("Desktop"));
    }
    roots
}

fn scan_shortcuts(state: &mut ScanState<'_>) -> SystoolsResult<()> {
    if !state.has_removed() {
        return Ok(());
    }
    for root in shortcut_roots() {
        state.check_cancelled()?;
        if state.budget_exhausted() || state.candidates.len() >= MAX_CANDIDATES {
            return Ok(());
        }
        if root.is_dir() {
            scan_shortcut_directory(state, &root, 0)?;
        }
    }
    Ok(())
}

fn scan_shortcut_directory(
    state: &mut ScanState<'_>,
    directory: &Path,
    depth: usize,
) -> SystoolsResult<()> {
    if depth > 2 {
        return Ok(());
    }
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            log::debug!(
                "systools_leftover_shortcut_directory_unreadable path={} error={error}",
                directory.display()
            );
            state.access_limited = true;
            state.skipped = state.skipped.saturating_add(1);
            return Ok(());
        }
    };
    for entry in entries {
        state.check_cancelled()?;
        if state.budget_exhausted() || state.candidates.len() >= MAX_CANDIDATES {
            return Ok(());
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                log::debug!("systools_leftover_shortcut_entry_failed error={error}");
                state.access_limited = true;
                state.skipped = state.skipped.saturating_add(1);
                continue;
            }
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                log::debug!("systools_leftover_shortcut_type_failed error={error}");
                state.access_limited = true;
                state.skipped = state.skipped.saturating_add(1);
                continue;
            }
        };
        if file_type.is_dir() {
            scan_shortcut_directory(state, &path, depth + 1)?;
            continue;
        }
        if !file_type.is_file()
            || !path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
        {
            continue;
        }

        let display_name = shortcut_name::shortcut_display_name(&path);
        let stem = path
            .file_stem()
            .map(|value| value.to_string_lossy().to_string());
        let target = shortcut_name::shortcut_target(&path).map(|(target, _)| target);
        let Some(fact) = state
            .match_shortcut(&[display_name.as_deref(), stem.as_deref()], target.as_deref())
            .cloned()
        else {
            continue;
        };
        let snapshot = match measure_path(&path, state.cancellation) {
            Ok(snapshot) => snapshot,
            Err(MeasureError::Cancelled) => return Err(SystoolsError::cancelled()),
            Err(error) => {
                if error.is_access_limited() {
                    state.access_limited = true;
                }
                state.skipped = state.skipped.saturating_add(1);
                log::debug!(
                    "systools_leftover_shortcut_skipped path={} reason={}",
                    path.display(),
                    error.as_str()
                );
                continue;
            }
        };
        let candidate = ApplicationLeftoverCandidate {
            candidate_id: candidate_id("shortcut", &normalize_path_key(&path)),
            application_identifier: fact.identifier.clone(),
            application_name: fact.name.clone(),
            source: ApplicationLeftoverSource::ApplicationScripts,
            path: path.to_string_lossy().to_string(),
            bytes: snapshot.bytes,
            file_count: snapshot.file_count,
            modified_at_ms: snapshot.modified_ms,
            confidence: ApplicationLeftoverConfidence::High,
            default_selected: false,
            evidence: vec![
                ApplicationLeftoverEvidence::InstalledOwnerAbsent,
                ApplicationLeftoverEvidence::ExactIdentifierAssociation,
            ],
            snapshot_fingerprint: snapshot_fingerprint(
                "shortcut",
                &normalize_path_key(&path),
                &fact.identifier,
                &snapshot,
            ),
        };
        state.push_candidate(candidate);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Filesystem snapshots and fingerprints
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PathSnapshot {
    bytes: u64,
    file_count: u64,
    modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MeasureError {
    Access,
    ReparsePoint,
    Unsupported,
    TooLarge,
    Cancelled,
}

impl MeasureError {
    fn as_str(self) -> &'static str {
        match self {
            Self::Access => "access_limited",
            Self::ReparsePoint => "reparse_point",
            Self::Unsupported => "unsupported_entry",
            Self::TooLarge => "too_large",
            Self::Cancelled => "cancelled",
        }
    }

    fn is_access_limited(self) -> bool {
        matches!(self, Self::Access)
    }
}

fn measure_path(path: &Path, cancellation: &Cancellation) -> Result<PathSnapshot, MeasureError> {
    let root_metadata = fs::symlink_metadata(path).map_err(|_| MeasureError::Access)?;
    if is_reparse_point(&root_metadata) {
        return Err(MeasureError::ReparsePoint);
    }
    if root_metadata.is_file() {
        return Ok(PathSnapshot {
            bytes: root_metadata.len(),
            file_count: 1,
            modified_ms: modified_ms(&root_metadata),
        });
    }
    if !root_metadata.is_dir() {
        return Err(MeasureError::Unsupported);
    }

    let mut bytes = 0_u64;
    let mut file_count = 0_u64;
    let mut latest = None;
    let mut entries_seen = 0_usize;
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        if cancellation.is_cancelled() {
            return Err(MeasureError::Cancelled);
        }
        let entries = fs::read_dir(&directory).map_err(|_| MeasureError::Access)?;
        for entry in entries {
            let entry = entry.map_err(|_| MeasureError::Access)?;
            let child = entry.path();
            let metadata = fs::symlink_metadata(&child).map_err(|_| MeasureError::Access)?;
            if is_reparse_point(&metadata) {
                return Err(MeasureError::ReparsePoint);
            }
            if metadata.is_dir() {
                pending.push(child);
            } else if metadata.is_file() {
                file_count = file_count.saturating_add(1);
                bytes = bytes.saturating_add(metadata.len());
                latest = max_modified(latest, modified_ms(&metadata));
            } else {
                return Err(MeasureError::Unsupported);
            }
            entries_seen += 1;
            if entries_seen > MAX_MEASURED_ENTRIES {
                return Err(MeasureError::TooLarge);
            }
        }
    }
    Ok(PathSnapshot {
        bytes,
        file_count,
        modified_ms: latest.or_else(|| modified_ms(&root_metadata)),
    })
}

fn modified_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
}

fn max_modified(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn snapshot_fingerprint(
    kind: &str,
    key: &str,
    detail: &str,
    snapshot: &PathSnapshot,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"systools-application-leftover-v1");
    for value in [kind, key, detail] {
        hasher.update(&(value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.update(&snapshot.bytes.to_le_bytes());
    hasher.update(&snapshot.file_count.to_le_bytes());
    match snapshot.modified_ms {
        Some(modified) => {
            hasher.update(&[1]);
            hasher.update(&modified.to_le_bytes());
        }
        None => {
            hasher.update(&[0]);
        }
    }
    hasher.finalize().to_hex().to_string()
}

fn candidate_id(kind: &str, key: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"systools-application-leftover-candidate-v1");
    hasher.update(kind.as_bytes());
    hasher.update(&(key.len() as u64).to_le_bytes());
    hasher.update(key.as_bytes());
    format!("leftover-{}", &hasher.finalize().to_hex()[..24])
}

fn candidate_key(path: &str) -> String {
    if is_registry_location(path) {
        path.to_ascii_lowercase()
    } else {
        normalize_path_key(Path::new(path))
    }
}

fn is_registry_location(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    upper.starts_with("HKCU\\") || upper.starts_with("HKLM\\") || upper.starts_with("HKEY_")
}

fn normalize_path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    text.trim_end_matches('\\').to_ascii_lowercase()
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    let root = normalize_path_key(root);
    let path = normalize_path_key(path);
    if root.is_empty() {
        return false;
    }
    let prefix = format!("{root}\\");
    path == root || path.starts_with(&prefix)
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Executes the reviewed items without ever aborting on a single failure.
pub(crate) fn execute(
    reviewed_items: Vec<ApplicationLeftoverPlanItem>,
    dry_run: bool,
    operation_id: &str,
) -> SystoolsResult<ApplicationLeftoverResult> {
    if reviewed_items.is_empty() {
        return Err(SystoolsError::invalid_input("systools_leftovers_execute"));
    }
    if operation_id.trim().is_empty() {
        return Err(SystoolsError::invalid_input("systools_leftovers_execute"));
    }
    let Some(catalog) = service_state::current() else {
        log::warn!("systools_leftover_execute_failed reason=application_catalog_unavailable");
        return Err(SystoolsError::invalid_input("systools_leftovers_execute"));
    };
    let mut candidates = last_scan_candidates();
    if reviewed_items
        .iter()
        .any(|item| !candidates.iter().any(|candidate| candidate.candidate_id == item.candidate_id))
    {
        log::info!("systools_leftover_execute_rescan reason=candidate_missing");
        // The caller is already waiting on this command, so the rescan reports
        // nothing: its progress would only replay a finished scan.
        let silent_progress = |_: ApplicationLeftoverScanProgress| {};
        scan(&Cancellation::new(), &silent_progress)?;
        candidates = last_scan_candidates();
    }
    let candidates = candidates
        .into_iter()
        .map(|candidate| (candidate.candidate_id.clone(), candidate))
        .collect::<HashMap<_, _>>();

    let installed = installed_facts(&catalog);
    let installed_identifiers = installed
        .iter()
        .map(|fact| fact.identifier.clone())
        .collect::<HashSet<_>>();
    let installed_names = installed
        .iter()
        .map(|fact| fact.normalized_name.clone())
        .collect::<HashSet<_>>();

    let mut process_snapshot: Option<Result<ProcessSnapshot, String>> = None;
    let mut actions = Vec::with_capacity(reviewed_items.len());
    let mut released_bytes = 0_u64;
    let mut affected_item_count = 0_u64;
    let mut failed_item_count = 0_u64;
    let mut completed_candidates = Vec::new();
    let mut cancelled = false;

    for item in &reviewed_items {
        let Some(candidate) = candidates.get(&item.candidate_id) else {
            failed_item_count += 1;
            actions.push(missing_action(item));
            continue;
        };
        if cancelled
            || take_cancellation(CoordinatedOperationKind::ApplicationLeftoverCleanup)
        {
            cancelled = true;
            actions.push(cancelled_action(candidate));
            continue;
        }

        if candidate.bytes != item.expected_bytes
            || candidate.file_count != item.expected_file_count
            || candidate.snapshot_fingerprint != item.expected_snapshot_fingerprint
        {
            failed_item_count += 1;
            actions.push(failed_action(
                candidate,
                ApplicationLeftoverActionReason::CandidateChanged,
            ));
            continue;
        }

        let normalized_name = normalize_token(&candidate.application_name);
        let owned = installed_identifiers.contains(&candidate.application_identifier)
            || installed_names.contains(&normalized_name);
        if owned {
            failed_item_count += 1;
            actions.push(failed_action(
                candidate,
                ApplicationLeftoverActionReason::OwnerReappeared,
            ));
            continue;
        }

        let unchanged = if is_registry_location(&candidate.path) {
            registry_record(&candidate.path)
                .map(|record| record.fingerprint())
                .is_some_and(|fingerprint| fingerprint == item.expected_snapshot_fingerprint)
        } else {
            let path = PathBuf::from(&candidate.path);
            measure_path(&path, &Cancellation::new())
                .map(|snapshot| {
                    snapshot_fingerprint(
                        candidate_kind(&candidate.path),
                        &normalize_path_key(&path),
                        &candidate.application_identifier,
                        &snapshot,
                    )
                })
                .is_ok_and(|fingerprint| fingerprint == item.expected_snapshot_fingerprint)
        };
        if !unchanged {
            failed_item_count += 1;
            actions.push(failed_action(
                candidate,
                ApplicationLeftoverActionReason::CandidateChanged,
            ));
            continue;
        }

        if is_registry_location(&candidate.path) {
            // Registry targets do not belong to a running process.
        } else {
            let snapshot = process_snapshot
                .get_or_insert_with(|| process_control::snapshot(&Cancellation::new()));
            match snapshot {
                Ok(snapshot) => {
                    let aliases = process_aliases_for(&candidate.application_name);
                    if !aliases.is_empty() && snapshot.contains_any(&aliases) {
                        failed_item_count += 1;
                        actions.push(failed_action(
                            candidate,
                            ApplicationLeftoverActionReason::ApplicationRunning,
                        ));
                        continue;
                    }
                }
                Err(error) => {
                    log::warn!(
                        "systools_leftover_process_snapshot_failed candidate_id={} error={error}",
                        candidate.candidate_id
                    );
                    failed_item_count += 1;
                    actions.push(failed_action(
                        candidate,
                        ApplicationLeftoverActionReason::ApplicationRunning,
                    ));
                    continue;
                }
            }
        }

        if dry_run {
            let validation_failed = if is_registry_location(&candidate.path) {
                false
            } else {
                deletion::delete_paths(&[PathBuf::from(&candidate.path)], true)
                    .first()
                    .is_some_and(|result| result.is_err())
            };
            if validation_failed {
                failed_item_count += 1;
                actions.push(failed_action(
                    candidate,
                    ApplicationLeftoverActionReason::PermanentDeleteFailed,
                ));
                continue;
            }
            actions.push(ApplicationLeftoverActionResult {
                candidate_id: candidate.candidate_id.clone(),
                application_identifier: candidate.application_identifier.clone(),
                application_name: candidate.application_name.clone(),
                status: ApplicationLeftoverActionStatus::Previewed,
                reason: None,
                expected_bytes: item.expected_bytes,
                released_bytes: 0,
            });
            continue;
        }

        let result = if is_registry_location(&candidate.path) {
            deletion::delete_registry_key(&candidate.path).map(|()| 0_u64)
        } else {
            deletion::delete_paths(&[PathBuf::from(&candidate.path)], false)
                .into_iter()
                .next()
                .unwrap_or_else(|| {
                    Err((
                        PathBuf::from(&candidate.path),
                        "deletion returned no result".to_string(),
                    ))
                })
                .map_err(|(path, reason)| {
                    log::warn!(
                        "systools_leftover_delete_failed candidate_id={} path={} reason={}",
                        candidate.candidate_id,
                        path.display(),
                        reason
                    );
                    reason
                })
        };

        match result {
            Ok(removed) => {
                released_bytes = released_bytes.saturating_add(removed);
                affected_item_count += 1;
                completed_candidates.push(HistoryCandidate {
                    application_identifier: candidate.application_identifier.clone(),
                    application_name: candidate.application_name.clone(),
                    publisher: None,
                    path: candidate.path.clone(),
                    source: candidate.source,
                });
                actions.push(ApplicationLeftoverActionResult {
                    candidate_id: candidate.candidate_id.clone(),
                    application_identifier: candidate.application_identifier.clone(),
                    application_name: candidate.application_name.clone(),
                    status: ApplicationLeftoverActionStatus::Completed,
                    reason: None,
                    expected_bytes: candidate.bytes,
                    released_bytes: removed,
                });
            }
            Err(_) => {
                failed_item_count += 1;
                actions.push(failed_action(
                    candidate,
                    ApplicationLeftoverActionReason::PermanentDeleteFailed,
                ));
            }
        }
    }

    let expected_bytes = reviewed_items
        .iter()
        .fold(0_u64, |total, item| total.saturating_add(item.expected_bytes));
    let plan_id = format!("leftovers-{operation_id}");
    let history_saved = if dry_run {
        false
    } else {
        append_history(&plan_id, expected_bytes, released_bytes, &completed_candidates)
    };

    log::info!(
        "systools_leftover_execution_finished plan_id={} items={} affected={} failed={} expected_bytes={} released_bytes={} dry_run={} history_saved={}",
        plan_id,
        reviewed_items.len(),
        affected_item_count,
        failed_item_count,
        expected_bytes,
        released_bytes,
        dry_run,
        history_saved
    );

    Ok(ApplicationLeftoverResult {
        plan_id,
        expected_bytes,
        released_bytes,
        affected_item_count,
        failed_item_count,
        dry_run,
        actions,
        history_saved,
    })
}

fn last_scan_candidates() -> Vec<ApplicationLeftoverCandidate> {
    lock(last_scan_slot()).clone()
}

fn candidate_kind(path: &str) -> &'static str {
    if is_registry_location(path) {
        "registry"
    } else if path.to_ascii_lowercase().ends_with(".lnk") {
        "shortcut"
    } else {
        "directory"
    }
}

fn process_aliases_for(name: &str) -> Vec<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    vec![trimmed.to_string()]
}

fn missing_action(item: &ApplicationLeftoverPlanItem) -> ApplicationLeftoverActionResult {
    ApplicationLeftoverActionResult {
        candidate_id: item.candidate_id.clone(),
        application_identifier: String::new(),
        application_name: String::new(),
        status: ApplicationLeftoverActionStatus::Failed,
        reason: Some(ApplicationLeftoverActionReason::CandidateChanged),
        expected_bytes: item.expected_bytes,
        released_bytes: 0,
    }
}

fn cancelled_action(candidate: &ApplicationLeftoverCandidate) -> ApplicationLeftoverActionResult {
    ApplicationLeftoverActionResult {
        candidate_id: candidate.candidate_id.clone(),
        application_identifier: candidate.application_identifier.clone(),
        application_name: candidate.application_name.clone(),
        status: ApplicationLeftoverActionStatus::Cancelled,
        reason: None,
        expected_bytes: candidate.bytes,
        released_bytes: 0,
    }
}

fn failed_action(
    candidate: &ApplicationLeftoverCandidate,
    reason: ApplicationLeftoverActionReason,
) -> ApplicationLeftoverActionResult {
    ApplicationLeftoverActionResult {
        candidate_id: candidate.candidate_id.clone(),
        application_identifier: candidate.application_identifier.clone(),
        application_name: candidate.application_name.clone(),
        status: ApplicationLeftoverActionStatus::Failed,
        reason: Some(reason),
        expected_bytes: candidate.bytes,
        released_bytes: 0,
    }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryFile {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    records: Vec<HistoryRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryRecord {
    plan_id: String,
    recorded_at_ms: u64,
    expected_bytes: u64,
    released_bytes: u64,
    candidates: Vec<HistoryCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryCandidate {
    application_identifier: String,
    application_name: String,
    #[serde(default)]
    publisher: Option<String>,
    path: String,
    source: ApplicationLeftoverSource,
}

fn data_file(name: &str) -> Option<PathBuf> {
    crate::paths::dir().ok().map(|directory| directory.join(name))
}

fn load_history() -> HistoryFile {
    let Some(path) = data_file(HISTORY_FILE_NAME) else {
        return HistoryFile::default();
    };
    let Ok(bytes) = fs::read(&path) else {
        return HistoryFile::default();
    };
    match serde_json::from_slice::<HistoryFile>(&bytes) {
        Ok(history) => history,
        Err(error) => {
            log::warn!(
                "systools_leftover_history_parse_failed path={} error={error}",
                path.display()
            );
            HistoryFile::default()
        }
    }
}

fn append_history(
    plan_id: &str,
    expected_bytes: u64,
    released_bytes: u64,
    candidates: &[HistoryCandidate],
) -> bool {
    if candidates.is_empty() {
        return false;
    }
    let Some(path) = data_file(HISTORY_FILE_NAME) else {
        return false;
    };
    let mut history = load_history();
    history.schema_version = HISTORY_SCHEMA_VERSION;
    history.records.push(HistoryRecord {
        plan_id: plan_id.to_string(),
        recorded_at_ms: unix_time_ms(),
        expected_bytes,
        released_bytes,
        candidates: candidates.to_vec(),
    });
    trim_history(&mut history.records, HISTORY_LIMIT);
    match write_json(&path, &history) {
        Ok(()) => true,
        Err(error) => {
            log::warn!(
                "systools_leftover_history_save_failed path={} error={error}",
                path.display()
            );
            false
        }
    }
}

fn trim_history(records: &mut Vec<HistoryRecord>, limit: usize) {
    if records.len() <= limit {
        return;
    }
    let keep_from = records.len() - limit;
    records.drain(..keep_from);
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservationFile {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    applications: Vec<ObservationRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservationRecord {
    identifier: String,
    name: String,
    #[serde(default)]
    publisher: Option<String>,
    last_seen_ms: u64,
}

fn load_observations() -> ObservationFile {
    let Some(path) = data_file(OBSERVATION_FILE_NAME) else {
        return ObservationFile::default();
    };
    let Ok(bytes) = fs::read(&path) else {
        return ObservationFile::default();
    };
    match serde_json::from_slice::<ObservationFile>(&bytes) {
        Ok(observations) => observations,
        Err(error) => {
            log::warn!(
                "systools_leftover_observations_parse_failed path={} error={error}",
                path.display()
            );
            ObservationFile::default()
        }
    }
}

fn update_observations(
    observations: &mut ObservationFile,
    installed: &[AppFact],
    now_ms: u64,
) {
    observations.schema_version = OBSERVATION_SCHEMA_VERSION;
    let mut merged = observations
        .applications
        .drain(..)
        .map(|record| (record.identifier.clone(), record))
        .collect::<HashMap<_, _>>();
    for fact in installed {
        let record = merged
            .entry(fact.identifier.clone())
            .or_insert_with(|| ObservationRecord {
                identifier: fact.identifier.clone(),
                name: fact.name.clone(),
                publisher: fact.publisher.clone(),
                last_seen_ms: now_ms,
            });
        record.name = fact.name.clone();
        record.publisher = fact.publisher.clone();
        record.last_seen_ms = now_ms;
    }
    let mut records = merged.into_values().collect::<Vec<_>>();
    records.sort_by(|left, right| {
        right
            .last_seen_ms
            .cmp(&left.last_seen_ms)
            .then_with(|| left.identifier.cmp(&right.identifier))
    });
    records.truncate(OBSERVATION_LIMIT);
    observations.applications = records;
}

fn save_observations(observations: &ObservationFile) {
    let Some(path) = data_file(OBSERVATION_FILE_NAME) else {
        return;
    };
    if let Err(error) = write_json(&path, observations) {
        log::debug!(
            "systools_leftover_observations_save_failed path={} error={error}",
            path.display()
        );
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(name: &str, publisher: Option<&str>) -> AppFact {
        AppFact::new(name, publisher).expect("fixture fact must be valid")
    }

    #[test]
    fn names_match_case_separator_and_punctuation_insensitively() {
        assert_eq!(normalize_token("Example App"), normalize_token("example-app"));
        assert_eq!(normalize_token("ExampleApp"), normalize_token("EXAMPLE APP"));
        assert_eq!(
            fact("Example App", Some("Acme Corp")).identifier,
            fact("example-app", Some("ACME  corp")).identifier
        );
    }

    #[test]
    fn identifiers_distinguish_publishers() {
        assert_ne!(
            fact("Example", Some("Acme")).identifier,
            fact("Example", Some("Other")).identifier
        );
        assert_eq!(fact("Example", None).identifier, "example|");
    }

    #[test]
    fn registry_and_installed_identifiers_filter_short_publishers_alike() {
        assert_eq!(
            identifier_for("Example", Some("AB")),
            fact("Example", Some("AB")).identifier
        );
        assert_eq!(
            identifier_for("Example", Some("Acme")),
            fact("Example", Some("Acme")).identifier
        );
    }

    #[test]
    fn shortcuts_match_by_any_name_or_by_target_inside_the_install_location() {
        let cancellation = Cancellation::new();
        let observations = ObservationFile {
            schema_version: OBSERVATION_SCHEMA_VERSION,
            applications: vec![ObservationRecord {
                identifier: fact("Example App", Some("Acme")).identifier,
                name: "Example App".to_string(),
                publisher: Some("Acme".to_string()),
                last_seen_ms: 1,
            }],
        };
        let mut state = ScanState::new(
            &cancellation,
            Instant::now(),
            Vec::new(),
            &observations,
            &HistoryFile::default(),
        );
        state.removed[0]
            .related_paths
            .push(PathBuf::from(r"C:\Program Files\ExampleApp"));

        assert!(state
            .match_shortcut(&[Some("Other Label"), Some("Example App")], None)
            .is_some());
        assert!(state
            .match_shortcut(
                &[None, None],
                Some(Path::new(r"C:\Program Files\ExampleApp\example.exe"))
            )
            .is_some());
        assert!(state
            .match_shortcut(&[Some("Unrelated"), Some("Other")], Some(Path::new(r"C:\Temp\app.exe")))
            .is_none());
    }

    #[test]
    fn candidate_ids_and_fingerprints_are_stable() {
        let snapshot = PathSnapshot {
            bytes: 10,
            file_count: 2,
            modified_ms: Some(5),
        };
        assert_eq!(
            candidate_id("directory", r"c:\example"),
            candidate_id("directory", r"c:\example")
        );
        assert_ne!(
            candidate_id("directory", r"c:\example"),
            candidate_id("shortcut", r"c:\example")
        );
        assert_eq!(
            snapshot_fingerprint("directory", r"c:\example", "example|acme", &snapshot),
            snapshot_fingerprint("directory", r"c:\example", "example|acme", &snapshot)
        );
    }

    #[test]
    fn fingerprints_change_with_every_snapshot_field() {
        let base = PathSnapshot {
            bytes: 10,
            file_count: 2,
            modified_ms: Some(5),
        };
        let fingerprint = snapshot_fingerprint("directory", r"c:\example", "example", &base);
        for changed in [
            PathSnapshot {
                bytes: 11,
                ..base
            },
            PathSnapshot {
                file_count: 3,
                ..base
            },
            PathSnapshot {
                modified_ms: Some(6),
                ..base
            },
            PathSnapshot {
                modified_ms: None,
                ..base
            },
        ] {
            assert_ne!(
                fingerprint,
                snapshot_fingerprint("directory", r"c:\example", "example", &changed)
            );
        }
        assert_ne!(
            fingerprint,
            snapshot_fingerprint("shortcut", r"c:\example", "example", &base)
        );
        assert_ne!(
            fingerprint,
            snapshot_fingerprint("directory", r"c:\other", "example", &base)
        );
    }

    #[test]
    fn directory_sources_follow_path_semantics() {
        assert_eq!(
            directory_source(RootKind::Packages, "Acme.App_hash"),
            ApplicationLeftoverSource::SandboxContainer
        );
        assert_eq!(
            directory_source(RootKind::LocalData, "Example Logs"),
            ApplicationLeftoverSource::Logs
        );
        assert_eq!(
            directory_source(RootKind::LocalData, "Example Cache"),
            ApplicationLeftoverSource::SavedState
        );
        assert_eq!(
            directory_source(RootKind::RoamingData, "Example"),
            ApplicationLeftoverSource::ApplicationSupport
        );
    }

    #[test]
    fn environment_expansion_is_conservative() {
        let expanded = expand_environment(r"%SystemRoot%\System32");
        assert!(expanded.ends_with(r"\System32"));
        assert_eq!(
            expand_environment(r"%systools_unknown_variable%\x"),
            r"%systools_unknown_variable%\x"
        );
        assert_eq!(expand_environment("literal"), "literal");
    }

    #[test]
    fn registry_strings_decode_utf16_and_stop_at_nul() {
        let mut bytes = Vec::new();
        for unit in "Example App\0".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_utf16_le(&bytes), "Example App");
        assert_eq!(decode_utf16_le(&[]), "");
    }

    #[test]
    fn registry_icon_paths_drop_quotes_and_resource_indexes() {
        assert_eq!(
            registry_path_value(r#""C:\Apps\Example\example.exe",0"#)
                .map(|path| path.to_string_lossy().to_string()),
            Some(r"C:\Apps\Example\example.exe".to_string())
        );
        assert_eq!(
            registry_path_value(r"C:\Apps\Example,1")
                .map(|path| path.to_string_lossy().to_string()),
            Some(r"C:\Apps\Example".to_string())
        );
        assert_eq!(
            registry_path_value(r"C:\Apps\Example,1,2")
                .map(|path| path.to_string_lossy().to_string()),
            Some(r"C:\Apps\Example,1".to_string())
        );
    }

    #[test]
    fn path_containment_is_component_wise() {
        assert!(path_is_within(
            Path::new(r"c:\users\example\appdata\Acme\data"),
            Path::new(r"C:\Users\Example\AppData\Acme")
        ));
        assert!(!path_is_within(
            Path::new(r"C:\Users\Example\AppData\AcmeExtra"),
            Path::new(r"C:\Users\Example\AppData\Acme")
        ));
    }

    #[test]
    fn history_is_trimmed_to_the_newest_records() {
        let mut records = (0..(HISTORY_LIMIT + 5))
            .map(|index| HistoryRecord {
                plan_id: format!("plan-{index}"),
                recorded_at_ms: index as u64,
                expected_bytes: 0,
                released_bytes: 0,
                candidates: Vec::new(),
            })
            .collect::<Vec<_>>();
        trim_history(&mut records, HISTORY_LIMIT);
        assert_eq!(records.len(), HISTORY_LIMIT);
        assert_eq!(
            records.first().map(|record| record.plan_id.clone()),
            Some("plan-5".to_string())
        );
        assert_eq!(
            records.last().map(|record| record.plan_id.clone()),
            Some(format!("plan-{}", HISTORY_LIMIT + 4))
        );
    }

    #[test]
    fn vanished_observations_exclude_currently_installed_applications() {
        let installed = vec![fact("Example", Some("Acme"))];
        let mut observations = ObservationFile {
            schema_version: OBSERVATION_SCHEMA_VERSION,
            applications: vec![
                ObservationRecord {
                    identifier: fact("Example", Some("Acme")).identifier,
                    name: "Example".to_string(),
                    publisher: Some("Acme".to_string()),
                    last_seen_ms: 1,
                },
                ObservationRecord {
                    identifier: fact("Removed", Some("Acme")).identifier,
                    name: "Removed".to_string(),
                    publisher: Some("Acme".to_string()),
                    last_seen_ms: 1,
                },
            ],
        };
        update_observations(&mut observations, &installed, 2);

        let cancellation = Cancellation::new();
        let state = ScanState::new(
            &cancellation,
            Instant::now(),
            installed,
            &observations,
            &HistoryFile::default(),
        );
        assert_eq!(state.removed.len(), 1);
        assert_eq!(state.removed[0].name, "Removed");
    }

    #[test]
    fn measuring_a_directory_counts_regular_files_only() {
        let root = std::env::temp_dir().join(format!(
            "systools-leftover-measure-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(root.join("nested")).expect("fixture root must be created");
        fs::write(root.join("nested/a.bin"), b"12345").expect("fixture file must be written");
        fs::write(root.join("b.bin"), b"abc").expect("fixture file must be written");

        let snapshot =
            measure_path(&root, &Cancellation::new()).expect("the fixture must be measured");
        assert_eq!(snapshot.bytes, 8);
        assert_eq!(snapshot.file_count, 2);
        assert!(snapshot.modified_ms.is_some());
        let _ = fs::remove_dir_all(root);
    }
}
