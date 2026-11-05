//! Bridge projection from completed scan records to the frozen analysis result.
//!
//! The reference engine owns this projection inside the analysis service lane.
//! The shared kernel needs a working implementation before that lane lands, so
//! this module rebuilds the bounded projection directly from the retained scan
//! index. It preserves the reference budgets (visible rows, hierarchy depth,
//! siblings, nodes, shared-allocation grouping) and is replaced wholesale when
//! the analysis lane ports its own projection.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use crate::{
    filesystem::metadata::{
        diagnostic_path, display_fingerprint, display_path, is_link_like, modified_ms,
        scan_entry_metadata,
    },
    platform::contracts::{
        current_platform, FileSpaceUsage, NameExclusions, Platform, ScanOmissionCounts, ScanPurpose,
        SkipReason,
    },
    storage::analysis::models::{
        AnalysisCoverage, AnalysisDirectoryNode, AnalysisEntrySizeStatus, AnalysisIndexSnapshot,
        AnalysisResult, AnalysisScanMode, DirectoryEntryInfo, SharedAllocation,
        ANALYSIS_SCAN_POLICY_VERSION, ANALYSIS_VISIBLE_ENTRY_LIMIT,
    },
    storage::index::cache::{read_snapshot, DirectoryAggregate, IndexedFile},
};

/// Hierarchy budgets shared with the reference projection.
const HIERARCHY_MAX_DEPTH: usize = 6;
const HIERARCHY_MAX_CHILDREN: usize = 64;
const HIERARCHY_MAX_NODES: usize = 2048;

enum CachedList {
    Ready {
        entries: Vec<DirectoryEntryInfo>,
        total_entry_count: usize,
    },
    NeedsDirectoryRead(DirectoryReadReason),
}

#[derive(Clone, Copy)]
enum DirectoryReadReason {
    IncompleteDetail,
    LargestRowsUnavailable,
}

impl DirectoryReadReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::IncompleteDetail => "incomplete_detail",
            Self::LargestRowsUnavailable => "largest_rows_unavailable",
        }
    }
}

#[derive(Clone, Copy)]
enum AnalysisChildMetadata {
    ScanSnapshot,
    LiveView,
}

/// Rebuilds a cached analysis result without touching the filesystem unless the
/// retained rows cannot prove the visible list is complete.
pub(crate) fn analysis_result(root: &Path) -> Result<Option<AnalysisResult>, String> {
    // The first pass captures one cache revision, the second re-reads it after a
    // possible directory read so a concurrent publication can never mix states.
    let prepared = read_snapshot(|cache| -> Result<Option<Prepared>, String> {
        let Some(aggregate) = cache.directories.get(root).copied() else {
            return Ok(None);
        };
        let scan_root = cache
            .scan_roots
            .keys()
            .filter(|scan_root| current_platform().path_is_same_or_child(root, scan_root))
            .max_by_key(|scan_root| scan_root.components().count())
            .cloned();
        let scope = scan_root.clone().unwrap_or_else(|| root.to_path_buf());
        let (excluded_roots, excluded_names) = scan_root
            .as_ref()
            .and_then(|scan_root| cache.scan_exclusions.get(scan_root))
            .cloned()
            .unwrap_or_default();
        let cached = cached_list(root, aggregate, cache.directories, cache.files);
        Ok(Some(Prepared {
            aggregate,
            scope,
            excluded_roots,
            excluded_names,
            cached,
            revision: cache.mutation_revision,
        }))
    })??;
    let Some(Prepared {
        aggregate,
        scope,
        excluded_roots,
        excluded_names,
        cached,
        revision,
    }) = prepared
    else {
        return Ok(None);
    };

    let children = match &cached {
        CachedList::Ready { .. } => None,
        CachedList::NeedsDirectoryRead(reason) => {
            log::info!(
                "analysis_directory_read_required root={} reason={} stage=navigation",
                diagnostic_path(root),
                reason.as_str()
            );
            Some(read_analysis_children(
                root,
                &excluded_roots,
                &excluded_names,
            )?)
        }
    };
    read_snapshot(|cache| -> Option<AnalysisResult> {
        if cache.mutation_revision != revision {
            log::info!(
                "analysis_cache_projection_changed root={} outcome=cache_miss",
                diagnostic_path(root)
            );
            return None;
        }
        let (entries, total_entry_count) = match cached {
            CachedList::Ready {
                entries,
                total_entry_count,
            } => (entries, total_entry_count),
            CachedList::NeedsDirectoryRead(_) => {
                let Some(children) = children else {
                    return None;
                };
                let entries = build_analysis_entries(
                    children,
                    aggregate.byte_metric.into(),
                    cache.directories,
                    cache.files,
                    &HashMap::new(),
                );
                let count = entries.iter().filter(|entry| entry.bytes > 0).count();
                (entries, count)
            }
        };
        let shared = shared_allocations(root, &scope, cache.files);
        let mut result = build_result(root, aggregate, entries, total_entry_count, shared);
        result.directory_hierarchy =
            build_directory_hierarchy(root, cache.directories, cache.files);
        result.index_snapshot = Some(AnalysisIndexSnapshot {
            root: root.to_path_buf(),
            generation: cache.publish_generations.get(root).copied().unwrap_or(0),
            mutation_revision: cache.mutation_revision,
        });
        Some(result)
    })
}

struct Prepared {
    aggregate: DirectoryAggregate,
    scope: PathBuf,
    excluded_roots: Vec<PathBuf>,
    excluded_names: NameExclusions,
    cached: CachedList,
    revision: u64,
}

/// Builds the initial result from the index records completed by one scan.
pub(crate) fn analysis_result_from_snapshot(
    root: &Path,
    root_aggregate: DirectoryAggregate,
    directories: &HashMap<PathBuf, DirectoryAggregate>,
    files: &HashMap<PathBuf, IndexedFile>,
    excluded_roots: &[PathBuf],
    excluded_names: &NameExclusions,
    workers: usize,
) -> Result<AnalysisResult, String> {
    let scan_mode: AnalysisScanMode = root_aggregate.byte_metric.into();
    let (entries, total_entry_count) =
        match cached_list(root, root_aggregate, directories, files) {
            CachedList::Ready {
                entries,
                total_entry_count,
            } => (entries, total_entry_count),
            CachedList::NeedsDirectoryRead(reason) => {
                log::info!(
                    "analysis_directory_read_required root={} reason={} stage=initial_result",
                    diagnostic_path(root),
                    reason.as_str()
                );
                let children = read_analysis_children_with_metadata(
                    root,
                    excluded_roots,
                    excluded_names,
                    AnalysisChildMetadata::ScanSnapshot,
                )?;
                let measured = measure_snapshot_files(&children, files, workers, scan_mode);
                let entries = build_analysis_entries(children, scan_mode, directories, files, &measured);
                let count = entries.iter().filter(|entry| entry.bytes > 0).count();
                (entries, count)
            }
        };
    let mut result = build_result(
        root,
        root_aggregate,
        entries,
        total_entry_count,
        shared_allocations(root, root, files),
    );
    result.directory_hierarchy = build_directory_hierarchy(root, directories, files);
    Ok(result)
}

/// Proves the retained direct rows can serve the visible list for this directory.
fn cached_list(
    root: &Path,
    aggregate: DirectoryAggregate,
    directories: &HashMap<PathBuf, DirectoryAggregate>,
    files: &HashMap<PathBuf, IndexedFile>,
) -> CachedList {
    let mut children: Vec<(PathBuf, ChildMeasurement<'_>)> = Vec::new();
    for (path, value) in directories {
        if path.as_path() != root && path.parent() == Some(root) {
            children.push((path.clone(), ChildMeasurement::Directory(value)));
        }
    }
    for (path, value) in files {
        if path.parent() == Some(root) {
            children.push((path.clone(), ChildMeasurement::File(value)));
        }
    }
    let mut retained_count = 0_u64;
    let mut shared_owners = 0_u64;
    let mut retained_ordinary = 0_usize;
    for (_, measurement) in &children {
        let ChildMeasurement::File(file) = measurement else {
            continue;
        };
        retained_count += 1;
        if file.bytes > 0 {
            if file.shared_identity.is_some() {
                shared_owners += 1;
            } else {
                retained_ordinary += 1;
            }
        }
    }
    let total_entry_count = aggregate.direct_file_count as usize
        + children
            .iter()
            .filter(|(_, measurement)| {
                matches!(measurement, ChildMeasurement::Directory(value) if value.bytes > 0)
            })
            .count();
    if aggregate.file_count != retained_count
        && total_entry_count <= ANALYSIS_VISIBLE_ENTRY_LIMIT
    {
        return CachedList::NeedsDirectoryRead(DirectoryReadReason::IncompleteDetail);
    }
    let ordinary_count = aggregate.direct_file_count.saturating_sub(shared_owners);
    if retained_ordinary < ordinary_count.min(ANALYSIS_VISIBLE_ENTRY_LIMIT as u64) as usize
        || (retained_ordinary < ordinary_count as usize
            && aggregate.retained_file_limit < ANALYSIS_VISIBLE_ENTRY_LIMIT)
    {
        return CachedList::NeedsDirectoryRead(DirectoryReadReason::LargestRowsUnavailable);
    }
    CachedList::Ready {
        entries: children
            .iter()
            .map(|(path, measurement)| measurement.entry(path))
            .collect(),
        total_entry_count,
    }
}

fn measure_snapshot_files(
    children: &[(fs::DirEntry, PathBuf, fs::Metadata)],
    indexed: &HashMap<PathBuf, IndexedFile>,
    workers: usize,
    scan_mode: AnalysisScanMode,
) -> HashMap<PathBuf, IndexedFile> {
    let queries: Vec<_> = children
        .iter()
        .filter(|(_, path, metadata)| {
            !metadata.is_dir()
                && !indexed
                    .get(path)
                    .is_some_and(|file| file_snapshot_matches(file, metadata))
        })
        .collect();
    if workers <= 1 || queries.len() < 256 {
        return HashMap::new();
    }
    let root_path = children
        .first()
        .and_then(|(_, path, _)| path.parent())
        .unwrap_or(Path::new(""));
    let chunks: Vec<_> = queries
        .chunks(queries.len().div_ceil(workers.clamp(1, 16)))
        .collect();
    std::thread::scope(|scope| {
        let mut pending = Vec::new();
        for (index, chunk) in chunks.into_iter().enumerate() {
            match std::thread::Builder::new()
                .name(format!("systools-analysis-rows-{index}"))
                .spawn_scoped(scope, move || {
                    chunk
                        .iter()
                        .map(|(_, path, metadata)| {
                            let usage = scan_mode.file_usage(path, metadata);
                            (
                                path.clone(),
                                IndexedFile {
                                    shared_identity: None,
                                    bytes: usage.allocated_bytes,
                                    logical_bytes: usage.logical_bytes,
                                    modified_at_ms: modified_ms(metadata),
                                },
                            )
                        })
                        .collect::<Vec<_>>()
                }) {
                Ok(handle) => pending.push(handle),
                Err(error) => {
                    log::warn!("analysis_snapshot_worker_unavailable root={} stage=spawn error_code={:?} error={error} outcome=live_query_fallback", diagnostic_path(root_path), error.raw_os_error());
                }
            }
        }
        let mut measured = HashMap::with_capacity(queries.len());
        for handle in pending {
            match handle.join() {
                Ok(rows) => measured.extend(rows),
                Err(_) => log::warn!(
                    "analysis_snapshot_worker_unavailable root={} stage=join reason=worker_panic outcome=live_query_fallback", diagnostic_path(root_path)
                ),
            }
        }
        measured
    })
}

fn file_snapshot_matches(file: &IndexedFile, metadata: &fs::Metadata) -> bool {
    // Shared allocation is reconciled in the original scan metric. Remeasuring
    // one surviving name would mix live bytes with unchanged directory totals.
    file.shared_identity
        .is_some_and(|identity| current_platform().matches_file_identity(metadata, identity))
        || file.bytes == 0
        || (file.logical_bytes == metadata.len() && file.modified_at_ms == modified_ms(metadata))
}

fn read_analysis_children(
    root: &Path,
    excluded_roots: &[PathBuf],
    excluded_names: &NameExclusions,
) -> Result<Vec<(fs::DirEntry, PathBuf, fs::Metadata)>, String> {
    read_analysis_children_with_metadata(
        root,
        excluded_roots,
        excluded_names,
        AnalysisChildMetadata::LiveView,
    )
}

fn read_analysis_children_with_metadata(
    root: &Path,
    excluded_roots: &[PathBuf],
    excluded_names: &NameExclusions,
    metadata_mode: AnalysisChildMetadata,
) -> Result<Vec<(fs::DirEntry, PathBuf, fs::Metadata)>, String> {
    let mut failures = 0_usize;
    let mut rows = Vec::new();
    let children = fs::read_dir(root).map_err(|error| {
        log_read_failure(root, "open", &error);
        format!("failed to read the analysis root: {error}")
    })?;
    for entry in children {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                if failures < 4 {
                    log_read_failure(root, "enumerate", &error);
                }
                failures += 1;
                continue;
            }
        };
        let path = entry.path();
        if excluded_roots
            .iter()
            .any(|excluded| current_platform().path_is_same_or_child(&path, excluded))
        {
            continue;
        }
        let metadata = match metadata_mode {
            AnalysisChildMetadata::ScanSnapshot => scan_entry_metadata(&entry, &path),
            AnalysisChildMetadata::LiveView => fs::symlink_metadata(&path),
        };
        let metadata = match metadata {
            Ok(metadata) => metadata,
            Err(error) => {
                if failures < 4 {
                    log_read_failure(&path, "metadata", &error);
                }
                failures += 1;
                continue;
            }
        };
        if metadata.is_dir()
            && current_platform().should_skip(&path, root, ScanPurpose::Analysis)
                == Some(SkipReason::SystemCritical)
        {
            continue;
        }
        if !is_link_like(&metadata) && !excluded_names.matches_entry(&path, metadata.is_dir()) {
            rows.push((entry, path, metadata));
        }
    }
    Ok(rows)
}

fn log_read_failure(path: &Path, stage: &str, error: &std::io::Error) {
    log::warn!(
        "analysis_directory_read_failed path={} stage={} error_code={:?} error={} outcome=not_loaded",
        diagnostic_path(path),
        stage,
        error.raw_os_error(),
        crate::platform::contracts::diagnostics::text(error)
    );
}

fn build_analysis_entries(
    children: Vec<(fs::DirEntry, PathBuf, fs::Metadata)>,
    scan_mode: AnalysisScanMode,
    directories: &HashMap<PathBuf, DirectoryAggregate>,
    files: &HashMap<PathBuf, IndexedFile>,
    measured: &HashMap<PathBuf, IndexedFile>,
) -> Vec<DirectoryEntryInfo> {
    children
        .into_iter()
        .map(|(_, path, metadata)| {
            let mut entry = if metadata.is_dir() {
                directory_entry(
                    &path,
                    directories.get(&path).copied().unwrap_or(DirectoryAggregate {
                        skipped_count: 1,
                        omissions: ScanOmissionCounts {
                            other: 1,
                            ..Default::default()
                        },
                        ..Default::default()
                    }),
                )
            } else {
                let usage = measured
                    .get(&path)
                    .or_else(|| files.get(&path))
                    .filter(|file| file_snapshot_matches(file, &metadata))
                    .map(|file| FileSpaceUsage {
                        logical_bytes: file.logical_bytes,
                        allocated_bytes: file.bytes,
                    })
                    .unwrap_or_else(|| scan_mode.file_usage(&path, &metadata));
                let mut entry = file_entry(
                    &path,
                    IndexedFile {
                        shared_identity: None,
                        bytes: usage.allocated_bytes,
                        logical_bytes: usage.logical_bytes,
                        modified_at_ms: modified_ms(&metadata),
                    },
                );
                entry.file_count = u64::from(metadata.is_file());
                entry
            };
            entry.modified_at_ms = modified_ms(&metadata);
            entry
        })
        .collect()
}

fn directory_entry(path: &Path, value: DirectoryAggregate) -> DirectoryEntryInfo {
    DirectoryEntryInfo {
        size_status: entry_size_status(value),
        name: file_name(path),
        path: display_path(path),
        bytes: value.bytes,
        logical_bytes: value.logical_bytes,
        file_count: value.file_count,
        is_directory: true,
        modified_at_ms: None,
        content_fingerprint: value.fingerprint.map(display_fingerprint),
    }
}

fn file_entry(path: &Path, value: IndexedFile) -> DirectoryEntryInfo {
    DirectoryEntryInfo {
        size_status: Default::default(),
        name: file_name(path),
        path: display_path(path),
        bytes: value.bytes,
        logical_bytes: value.logical_bytes,
        file_count: 1,
        is_directory: false,
        modified_at_ms: value.modified_at_ms,
        content_fingerprint: None,
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn entry_size_status(aggregate: DirectoryAggregate) -> AnalysisEntrySizeStatus {
    let counts = aggregate.omissions.with_unclassified(aggregate.skipped_count);
    if counts.total() == 0 {
        AnalysisEntrySizeStatus::Complete
    } else if aggregate.bytes == 0
        && counts.permission_denied + counts.read_errors + counts.other > 0
    {
        AnalysisEntrySizeStatus::Unavailable
    } else {
        AnalysisEntrySizeStatus::Partial
    }
}

fn build_result(
    root: &Path,
    aggregate: DirectoryAggregate,
    mut entries: Vec<DirectoryEntryInfo>,
    total_entry_count: usize,
    shared_allocations: std::sync::Arc<Vec<SharedAllocation>>,
) -> AnalysisResult {
    let shared_paths: HashSet<_> = shared_allocations
        .iter()
        .flat_map(|group| &group.files)
        .filter_map(|file| {
            let path = Path::new(&file.path);
            if path.parent() == Some(root) {
                return Some(file.path.clone());
            }
            let relative = path.strip_prefix(root).ok()?;
            Some(display_path(
                &root.join(relative.components().next()?.as_os_str()),
            ))
        })
        .collect();
    let shared_entries = std::sync::Arc::new(
        entries
            .iter()
            .filter(|entry| shared_paths.contains(&entry.path))
            .cloned()
            .collect(),
    );
    let truncated = entries.len() > ANALYSIS_VISIBLE_ENTRY_LIMIT
        || total_entry_count > ANALYSIS_VISIBLE_ENTRY_LIMIT;
    rank_entries(&mut entries);

    AnalysisResult {
        index_snapshot: None,
        policy_version: ANALYSIS_SCAN_POLICY_VERSION,
        coverage: AnalysisCoverage::new(aggregate.omissions, aggregate.skipped_count),
        scan_mode: aggregate.byte_metric.into(),
        scan_id: 0,
        root: display_path(root),
        scanned_at_ms: aggregate.scanned_at_ms,
        total_bytes: aggregate.bytes,
        total_entry_count,
        skipped_count: aggregate.skipped_count,
        truncated,
        entries,
        directory_hierarchy: Vec::new(),
        shared_allocations,
        shared_entries,
        shared_directories: Default::default(),
    }
}

fn rank_entries(entries: &mut Vec<DirectoryEntryInfo>) {
    let compare = |left: &DirectoryEntryInfo, right: &DirectoryEntryInfo| {
        right
            .bytes
            .cmp(&left.bytes)
            .then_with(|| left.path.cmp(&right.path))
    };
    if entries.len() > ANALYSIS_VISIBLE_ENTRY_LIMIT {
        entries.select_nth_unstable_by(ANALYSIS_VISIBLE_ENTRY_LIMIT, compare);
        entries.truncate(ANALYSIS_VISIBLE_ENTRY_LIMIT);
    }
    entries.sort_unstable_by(compare);
}

/// Retains complete known groups, including owners outside a cached child view.
fn shared_allocations(
    root: &Path,
    scope: &Path,
    files: &HashMap<PathBuf, IndexedFile>,
) -> std::sync::Arc<Vec<SharedAllocation>> {
    let selected_identities: Option<HashSet<_>> = (root != scope).then(|| {
        files
            .iter()
            .filter_map(|(path, file)| {
                file.shared_identity
                    .filter(|_| path.starts_with(root))
                    .map(|identity| (identity.volume, identity.index))
            })
            .collect()
    });
    if selected_identities.as_ref().is_some_and(HashSet::is_empty) {
        return Default::default();
    }
    let mut groups: HashMap<(u64, u64), SharedAllocation> = HashMap::new();
    for (path, file) in files {
        let Some(identity) = file.shared_identity else {
            continue;
        };
        if selected_identities
            .as_ref()
            .is_some_and(|selected| !selected.contains(&(identity.volume, identity.index)))
        {
            continue;
        }
        if !path.starts_with(scope) {
            continue;
        }
        let group = groups
            .entry((identity.volume, identity.index))
            .or_insert_with(|| SharedAllocation {
                identity,
                owner: display_path(path),
                bytes: 0,
                files: Vec::new(),
            });
        if file.bytes > group.bytes {
            group.bytes = file.bytes;
            group.owner = display_path(path);
        }
        group.files.push(file_entry(path, *file));
    }
    let mut groups: Vec<_> = groups
        .into_values()
        .filter(|group| {
            group
                .files
                .iter()
                .any(|file| Path::new(&file.path).starts_with(root))
        })
        .collect();
    for group in &mut groups {
        group
            .files
            .sort_unstable_by(|left, right| left.path.cmp(&right.path));
    }
    groups.sort_unstable_by(|left, right| left.owner.cmp(&right.owner));
    std::sync::Arc::new(groups)
}

#[derive(Clone, Copy)]
enum ChildMeasurement<'a> {
    Directory(&'a DirectoryAggregate),
    File(&'a IndexedFile),
}

impl ChildMeasurement<'_> {
    fn bytes(&self) -> u64 {
        match self {
            Self::Directory(value) => value.bytes,
            Self::File(value) => value.bytes,
        }
    }

    fn entry(&self, path: &Path) -> DirectoryEntryInfo {
        match self {
            Self::Directory(value) => directory_entry(path, **value),
            Self::File(value) => file_entry(path, **value),
        }
    }
}

#[derive(Clone, Copy)]
struct KnownChild<'a> {
    path: &'a Path,
    measurement: ChildMeasurement<'a>,
}

pub(crate) fn build_directory_hierarchy(
    root: &Path,
    directories: &HashMap<PathBuf, DirectoryAggregate>,
    files: &HashMap<PathBuf, IndexedFile>,
) -> Vec<AnalysisDirectoryNode> {
    let minimum_bytes = directories
        .get(root)
        .map_or(1, |aggregate| (aggregate.bytes / 2000).max(1));
    let mut children: HashMap<&Path, Vec<KnownChild<'_>>> = HashMap::new();
    for (path, value) in directories {
        if value.bytes < minimum_bytes {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let depth = relative.components().take(HIERARCHY_MAX_DEPTH + 1).count();
        if depth == 0 || depth > HIERARCHY_MAX_DEPTH {
            continue;
        }
        if let Some(parent) = path.parent() {
            children.entry(parent).or_default().push(KnownChild {
                path,
                measurement: ChildMeasurement::Directory(value),
            });
        }
    }
    for (path, value) in files {
        if value.bytes < minimum_bytes {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let depth = relative.components().take(HIERARCHY_MAX_DEPTH + 1).count();
        if !(2..=HIERARCHY_MAX_DEPTH).contains(&depth) {
            continue;
        }
        if let Some(parent) = path.parent() {
            children.entry(parent).or_default().push(KnownChild {
                path,
                measurement: ChildMeasurement::File(value),
            });
        }
    }
    let mut positive_directories: HashMap<&Path, u64> = HashMap::new();
    for (path, aggregate) in directories {
        if aggregate.bytes > 0 {
            if let Some(parent) = path.parent() {
                *positive_directories.entry(parent).or_default() += 1;
            }
        }
    }
    let mut remaining = HIERARCHY_MAX_NODES;
    let (mut nodes, _) = project(root, 1, &mut remaining, &children, &|path, aggregate| {
        aggregate.direct_file_count + positive_directories.get(path).copied().unwrap_or(0)
    });
    nodes.shrink_to_fit();
    nodes
}

fn project<'a>(
    parent: &Path,
    depth: usize,
    remaining: &mut usize,
    children: &HashMap<&'a Path, Vec<KnownChild<'a>>>,
    count: &impl Fn(&Path, DirectoryAggregate) -> u64,
) -> (Vec<AnalysisDirectoryNode>, Vec<DirectoryEntryInfo>) {
    if depth > HIERARCHY_MAX_DEPTH || *remaining == 0 {
        return (Vec::new(), Vec::new());
    }
    let mut siblings = children.get(parent).cloned().unwrap_or_default();
    let compare = |left: &KnownChild<'_>, right: &KnownChild<'_>| {
        right
            .measurement
            .bytes()
            .cmp(&left.measurement.bytes())
            .then_with(|| left.path.cmp(right.path))
    };
    if siblings.len() > HIERARCHY_MAX_CHILDREN {
        siblings.select_nth_unstable_by(HIERARCHY_MAX_CHILDREN, compare);
        siblings.truncate(HIERARCHY_MAX_CHILDREN);
    }
    siblings.sort_unstable_by(compare);
    let mut directories = Vec::new();
    let mut files = Vec::new();
    for child in siblings {
        if *remaining == 0 {
            break;
        }
        *remaining -= 1;
        match child.measurement {
            ChildMeasurement::Directory(aggregate) => {
                let total_entry_count = count(child.path, *aggregate);
                let (children_nodes, child_files) =
                    project(child.path, depth + 1, remaining, children, count);
                directories.push(AnalysisDirectoryNode {
                    name: file_name(child.path),
                    path: display_path(child.path),
                    bytes: aggregate.bytes,
                    file_count: aggregate.file_count,
                    total_entry_count,
                    children: children_nodes,
                    files: child_files,
                });
            }
            ChildMeasurement::File(_) => files.push(child.measurement.entry(child.path)),
        }
    }
    (directories, files)
}

/// Projects the same hierarchy through the published navigation index.
///
/// Used by navigation tests to prove both child sources produce identical
/// bounds and totals. Inconsistent navigation entries are rejected instead of
/// silently dropping a child.
#[cfg(test)]
pub(crate) fn hierarchy_from_navigation(
    index: &crate::storage::index::navigation::NavigationIndex,
    root: &Path,
    directories: &HashMap<PathBuf, DirectoryAggregate>,
    files: &HashMap<PathBuf, IndexedFile>,
) -> crate::shared::CoreResult<Vec<AnalysisDirectoryNode>> {
    let Some(aggregate) = directories.get(root) else {
        return Ok(Vec::new());
    };
    let minimum_bytes = (aggregate.bytes / 2000).max(1);
    let mut remaining = HIERARCHY_MAX_NODES;
    let (nodes, _) = project_navigation(
        root,
        1,
        &mut remaining,
        minimum_bytes,
        index,
        directories,
        files,
    )?;
    Ok(nodes)
}

#[cfg(test)]
#[derive(Clone, Copy)]
enum OwnedMeasurement {
    Directory(DirectoryAggregate),
    File(IndexedFile),
}

#[cfg(test)]
impl OwnedMeasurement {
    fn bytes(self) -> u64 {
        match self {
            Self::Directory(value) => value.bytes,
            Self::File(value) => value.bytes,
        }
    }

    fn entry(self, path: &Path) -> DirectoryEntryInfo {
        match self {
            Self::Directory(value) => directory_entry(path, value),
            Self::File(value) => file_entry(path, value),
        }
    }
}

#[cfg(test)]
fn project_navigation(
    parent: &Path,
    depth: usize,
    remaining: &mut usize,
    minimum_bytes: u64,
    index: &crate::storage::index::navigation::NavigationIndex,
    directories: &HashMap<PathBuf, DirectoryAggregate>,
    files: &HashMap<PathBuf, IndexedFile>,
) -> crate::shared::CoreResult<(Vec<AnalysisDirectoryNode>, Vec<DirectoryEntryInfo>)> {
    use crate::shared::CoreError;

    if depth > HIERARCHY_MAX_DEPTH || *remaining == 0 {
        return Ok((Vec::new(), Vec::new()));
    }
    let mut siblings: Vec<(PathBuf, OwnedMeasurement)> = Vec::new();
    for name in index.directory_names(parent).unwrap_or_default() {
        let path = parent.join(name);
        let aggregate = directories.get(&path).copied().ok_or_else(|| {
            CoreError::operation_failed("the analysis directory index does not match its navigation")
        })?;
        if aggregate.bytes >= minimum_bytes {
            siblings.push((path, OwnedMeasurement::Directory(aggregate)));
        }
    }
    for name in index.file_names(parent).unwrap_or_default() {
        let path = parent.join(name);
        let file = files.get(&path).copied().ok_or_else(|| {
            CoreError::operation_failed("the analysis file index does not match its navigation")
        })?;
        if depth >= 2 && file.bytes >= minimum_bytes {
            siblings.push((path, OwnedMeasurement::File(file)));
        }
    }
    let compare = |left: &(PathBuf, OwnedMeasurement), right: &(PathBuf, OwnedMeasurement)| {
        right
            .1
            .bytes()
            .cmp(&left.1.bytes())
            .then_with(|| left.0.cmp(&right.0))
    };
    if siblings.len() > HIERARCHY_MAX_CHILDREN {
        siblings.select_nth_unstable_by(HIERARCHY_MAX_CHILDREN, compare);
        siblings.truncate(HIERARCHY_MAX_CHILDREN);
    }
    siblings.sort_unstable_by(compare);
    let mut directories_out = Vec::new();
    let mut files_out = Vec::new();
    for (path, measurement) in siblings {
        if *remaining == 0 {
            break;
        }
        *remaining -= 1;
        match measurement {
            OwnedMeasurement::Directory(aggregate) => {
                let total_entry_count =
                    aggregate.direct_file_count + index.directory_count(&path, directories);
                let (children, child_files) = project_navigation(
                    &path,
                    depth + 1,
                    remaining,
                    minimum_bytes,
                    index,
                    directories,
                    files,
                )?;
                directories_out.push(AnalysisDirectoryNode {
                    name: file_name(&path),
                    path: display_path(&path),
                    bytes: aggregate.bytes,
                    file_count: aggregate.file_count,
                    total_entry_count,
                    children,
                    files: child_files,
                });
            }
            OwnedMeasurement::File(_) => files_out.push(measurement.entry(&path)),
        }
    }
    Ok((directories_out, files_out))
}
