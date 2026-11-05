//! Windows startup sources: registry Run keys, startup folders, scheduled
//! tasks, services, packaged startup tasks, and advanced autorun locations.
//!
//! Every source revalidates an item from live system state before mutating it,
//! so a provider identifier is the only mutation authority Core can carry.

mod advanced;
mod metadata;
mod packaged;
mod registry;
mod service_control;
mod service_target;
mod services;
mod startup_folder;
mod tasks;

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use crate::platform::contracts::{PlatformError, PlatformErrorCode, PlatformResult};
use crate::platform::startup_helper::{
    self, StartupHelperChangeRequest,
};
use crate::startup::platform::{
    PlatformStartupChangeRequest, PlatformStartupChangeResult, PlatformStartupControlCapability,
    PlatformStartupCoverageReason, PlatformStartupDesiredState, PlatformStartupScope,
    PlatformStartupSourceResult, StartupCancellation, StartupPlatform, StartupScanProgress,
    StartupSourceScanProgress,
};

// Native sources revalidate and verify every item independently. A small worker limit shortens
// slow task and registry batches without flooding COM, registry, or endpoint security hooks.
const MAX_DIRECT_CHANGE_CONCURRENCY: usize = 3;

/// Every scan reports registry, packaged tasks, both startup folders, services, tasks, and
/// advanced autoruns, so progress can be measured before any source finishes.
const SCAN_SOURCE_TOTAL: u64 = 7;

struct WindowsStartup;

impl StartupPlatform for WindowsStartup {
    fn scan_startup_sources(
        &self,
        cancellation: &StartupCancellation,
        progress: &dyn StartupScanProgress,
    ) -> PlatformResult<Vec<PlatformStartupSourceResult>> {
        scan(cancellation, progress)
    }

    fn change_startup_item(
        &self,
        request: &PlatformStartupChangeRequest,
        authorization_prompt: Option<&str>,
    ) -> PlatformResult<PlatformStartupChangeResult> {
        change(request, authorization_prompt)
    }

    fn change_startup_items(
        &self,
        requests: &[PlatformStartupChangeRequest],
        authorization_prompt: Option<&str>,
    ) -> PlatformResult<Vec<PlatformResult<PlatformStartupChangeResult>>> {
        change_many(requests, authorization_prompt)
    }
}

static WINDOWS_STARTUP: WindowsStartup = WindowsStartup;

pub(crate) fn platform() -> &'static dyn StartupPlatform {
    &WINDOWS_STARTUP
}

fn scan(
    cancellation: &StartupCancellation,
    progress: &dyn StartupScanProgress,
) -> PlatformResult<Vec<PlatformStartupSourceResult>> {
    if cancellation.is_cancelled() {
        return Ok(vec![PlatformStartupSourceResult::unavailable(
            "windows.startup",
            true,
            PlatformStartupCoverageReason::Cancelled,
        )]);
    }

    let started = Instant::now();
    let completed = AtomicU64::new(0);
    let items_found = AtomicU64::new(0);
    let report = |result: &PlatformStartupSourceResult| {
        let completed_sources = completed.fetch_add(1, Ordering::Relaxed) + 1;
        let found = result.items.len() as u64;
        let items_found = items_found.fetch_add(found, Ordering::Relaxed) + found;
        progress.source_finished(StartupSourceScanProgress {
            source_id: result.source_id.clone(),
            status: result.status,
            items_found,
            completed_sources,
            total_sources: SCAN_SOURCE_TOTAL,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    };

    let registry_cancellation = cancellation.clone();
    let packaged_cancellation = cancellation.clone();
    let folder_cancellation = cancellation.clone();
    let service_cancellation = cancellation.clone();
    let task_cancellation = cancellation.clone();
    let advanced_cancellation = cancellation.clone();
    let results = std::thread::scope(|scope| {
        let registry = scope.spawn(|| {
            let results = vec![registry::scan(&registry_cancellation)];
            results.iter().for_each(&report);
            results
        });
        let packaged = scope.spawn(|| {
            let results = vec![packaged::scan(&packaged_cancellation)];
            results.iter().for_each(&report);
            results
        });
        let folders = scope.spawn(|| {
            let results = startup_folder::scan(&folder_cancellation);
            results.iter().for_each(&report);
            results
        });
        let services = scope.spawn(|| {
            let results = vec![services::scan(&service_cancellation)];
            results.iter().for_each(&report);
            results
        });
        let tasks = scope.spawn(|| {
            let results = vec![tasks::scan(&task_cancellation)];
            results.iter().for_each(&report);
            results
        });
        let advanced = scope.spawn(|| {
            let results = vec![advanced::scan(&advanced_cancellation)];
            results.iter().for_each(&report);
            results
        });
        let mut results = joined_sources(registry, "windows.registry.run", true, &report);
        results.extend(joined_sources(
            packaged,
            "windows.packaged_startup_tasks",
            true,
            &report,
        ));
        results.extend(joined_sources(
            folders,
            "windows.startup_folder.user",
            true,
            &report,
        ));
        results.extend(joined_sources(services, "windows.services", true, &report));
        results.extend(joined_sources(
            tasks,
            "windows.scheduled_tasks",
            true,
            &report,
        ));
        results.extend(joined_sources(
            advanced,
            "windows.advanced_autoruns",
            false,
            &report,
        ));
        results
    });
    Ok(results)
}

fn joined_sources(
    handle: std::thread::ScopedJoinHandle<'_, Vec<PlatformStartupSourceResult>>,
    source_id: &'static str,
    required: bool,
    report: &dyn Fn(&PlatformStartupSourceResult),
) -> Vec<PlatformStartupSourceResult> {
    handle.join().unwrap_or_else(|_| {
        let result = PlatformStartupSourceResult::unavailable(
            source_id,
            required,
            PlatformStartupCoverageReason::InvalidData,
        );
        report(&result);
        vec![result]
    })
}

fn change(
    request: &PlatformStartupChangeRequest,
    authorization_prompt: Option<&str>,
) -> PlatformResult<PlatformStartupChangeResult> {
    // Elevated helpers exit before desktop logging is initialized, so retain locations here.
    registry::log_change_request(request);
    if requires_privileges(request) {
        return startup_helper::change_with_privileges(request, authorization_prompt);
    }
    change_direct(request)
}

fn change_many(
    requests: &[PlatformStartupChangeRequest],
    authorization_prompt: Option<&str>,
) -> PlatformResult<Vec<PlatformResult<PlatformStartupChangeResult>>> {
    let started = Instant::now();
    for request in requests {
        registry::log_change_request(request);
    }
    let privileged = requests
        .iter()
        .enumerate()
        .filter(|(_, request)| requires_privileges(request))
        .collect::<Vec<_>>();
    let direct = requests
        .iter()
        .enumerate()
        .filter(|(_, request)| !requires_privileges(request))
        .collect::<Vec<_>>();
    let mut ordered_results = (0..requests.len()).map(|_| None).collect::<Vec<_>>();
    let mut privileged_result_count = 0;

    if !privileged.is_empty() {
        let privileged_requests = privileged
            .iter()
            .map(|(_, request)| *request)
            .collect::<Vec<_>>();
        let privileged_results = startup_helper::change_many_with_privileges(
            &privileged_requests,
            authorization_prompt,
        )?;
        privileged_result_count = privileged_results.len();
        if privileged_result_count == privileged.len() {
            for ((index, _), result) in privileged.iter().zip(privileged_results) {
                ordered_results[*index] = Some(result);
            }
        } else {
            for (index, _) in &privileged {
                ordered_results[*index] = Some(Err(PlatformError::new(
                    PlatformErrorCode::InvalidData,
                    "startup helper returned an invalid batch result count",
                )
                .with_possible_side_effects()));
            }
        }
    }

    let direct_requests = direct
        .iter()
        .map(|(_, request)| *request)
        .collect::<Vec<_>>();
    let direct_results =
        execute_bounded(&direct_requests, MAX_DIRECT_CHANGE_CONCURRENCY, |request| {
            change_direct(request)
        });
    let worker_panic_count = direct_results
        .iter()
        .filter(|result| result.is_none())
        .count();
    for ((index, _), result) in direct.iter().zip(direct_results) {
        ordered_results[*index] = Some(result.unwrap_or_else(|| {
            Err(PlatformError::new(
                PlatformErrorCode::OperationFailed,
                "startup change worker terminated unexpectedly",
            )
            .with_possible_side_effects())
        }));
    }

    let missing_result_count = ordered_results
        .iter()
        .filter(|result| result.is_none())
        .count();
    log::info!(
        "windows_startup_change_batch_finished target_count={} direct_count={} privileged_count={} privileged_result_count={} concurrency_limit={} worker_panic_count={} missing_result_count={} elapsed_ms={}",
        requests.len(),
        direct.len(),
        privileged.len(),
        privileged_result_count,
        MAX_DIRECT_CHANGE_CONCURRENCY,
        worker_panic_count,
        missing_result_count,
        started.elapsed().as_millis()
    );

    Ok(ordered_results
        .into_iter()
        .map(|result| {
            result.unwrap_or_else(|| {
                Err(PlatformError::new(
                    PlatformErrorCode::InvalidData,
                    "startup change produced no result",
                )
                .with_possible_side_effects())
            })
        })
        .collect())
}

fn execute_bounded<T, R, F>(items: &[T], limit: usize, action: F) -> Vec<Option<R>>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync,
{
    if items.is_empty() {
        return Vec::new();
    }
    let worker_count = limit.max(1).min(items.len());
    let cursor = AtomicUsize::new(0);
    let results = (0..items.len())
        .map(|_| Mutex::new(None))
        .collect::<Vec<_>>();
    std::thread::scope(|scope| {
        let mut workers = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            workers.push(scope.spawn(|| loop {
                let index = cursor.fetch_add(1, Ordering::Relaxed);
                if index >= items.len() {
                    break;
                }
                let output = action(&items[index]);
                if let Ok(mut result) = results[index].lock() {
                    *result = Some(output);
                }
            }));
        }
        for worker in workers {
            let _ = worker.join();
        }
    });
    results
        .into_iter()
        .map(|result| result.into_inner().ok().flatten())
        .collect()
}

fn requires_privileges(request: &PlatformStartupChangeRequest) -> bool {
    request.expected_artifact.control_capability
        == PlatformStartupControlCapability::ElevationRequired
        || (request.desired_state == PlatformStartupDesiredState::Removed
            && matches!(
                request.expected_artifact.scope,
                PlatformStartupScope::AllUsers
                    | PlatformStartupScope::Machine
                    | PlatformStartupScope::System
            ))
}

fn change_direct(
    request: &PlatformStartupChangeRequest,
) -> PlatformResult<PlatformStartupChangeResult> {
    match request.source_id.as_str() {
        "windows.registry.run" => registry::change(request),
        "windows.startup_folder.user" | "windows.startup_folder.common" => {
            startup_folder::change(request)
        }
        "windows.scheduled_tasks" => tasks::change(request),
        "windows.services" => service_control::change(request),
        "windows.advanced_autoruns" => advanced::change(request),
        _ => Err(PlatformError::new(
            PlatformErrorCode::Unsupported,
            "startup source does not support configured-state changes",
        )),
    }
}

/// Applies one elevated helper batch against live system state.
///
/// The helper process receives no paths or commands. Each request is resolved
/// by `provider_item_id` inside an allowlisted source, and the preflight digest
/// must still match the freshly read artifact before any mutation happens.
pub(crate) fn helper_change_many(
    requests: &[StartupHelperChangeRequest],
) -> Vec<PlatformResult<PlatformStartupChangeResult>> {
    let cancellation = StartupCancellation::scan();
    let mut results = Vec::new();
    if requests
        .iter()
        .any(|request| request.source_id == "windows.services")
    {
        results.push(services::scan(&cancellation));
    }
    if requests
        .iter()
        .any(|request| request.source_id == "windows.registry.run")
    {
        results.push(registry::scan(&cancellation));
    }
    if requests
        .iter()
        .any(|request| request.source_id.starts_with("windows.startup_folder."))
    {
        results.extend(startup_folder::scan(&cancellation));
    }
    if requests
        .iter()
        .any(|request| request.source_id == "windows.scheduled_tasks")
    {
        results.push(tasks::scan(&cancellation));
    }
    if requests
        .iter()
        .any(|request| request.source_id == "windows.advanced_autoruns")
    {
        results.push(advanced::scan(&cancellation));
    }
    requests
        .iter()
        .map(|request| {
            helper_change_from_snapshot(
                &request.source_id,
                &request.provider_item_id,
                &request.expected_artifact_digest,
                request.desired_state,
                &results,
            )
        })
        .collect()
}

fn helper_change_from_snapshot(
    source_id: &str,
    provider_item_id: &str,
    expected_artifact_digest: &str,
    desired_state: PlatformStartupDesiredState,
    results: &[PlatformStartupSourceResult],
) -> PlatformResult<PlatformStartupChangeResult> {
    if !helper_source_is_allowlisted(source_id) {
        return Err(PlatformError::new(
            PlatformErrorCode::Unsupported,
            "startup helper source is not allowlisted",
        ));
    }
    let artifact = results
        .iter()
        .find(|source| source.source_id == source_id)
        .and_then(|source| {
            source
                .items
                .iter()
                .find(|artifact| artifact.provider_item_id == provider_item_id)
        })
        .cloned()
        .ok_or_else(|| PlatformError::item_changed("startup helper target no longer exists"))?;
    let authorized = artifact.control_capability
        == PlatformStartupControlCapability::ElevationRequired
        || (desired_state == PlatformStartupDesiredState::Removed
            && matches!(
                artifact.control_capability,
                PlatformStartupControlCapability::Toggleable
                    | PlatformStartupControlCapability::RemoveOnly
            )
            && matches!(
                artifact.scope,
                PlatformStartupScope::AllUsers
                    | PlatformStartupScope::Machine
                    | PlatformStartupScope::System
            ));
    if !authorized || startup_helper::artifact_digest(&artifact) != expected_artifact_digest {
        return Err(PlatformError::item_changed(
            "startup helper target changed after preflight",
        ));
    }
    change_direct(&PlatformStartupChangeRequest {
        provider_item_id: provider_item_id.to_owned(),
        source_id: source_id.to_owned(),
        expected_artifact: artifact,
        desired_state,
    })
}

fn helper_source_is_allowlisted(source_id: &str) -> bool {
    matches!(
        source_id,
        "windows.registry.run"
            | "windows.startup_folder.user"
            | "windows.startup_folder.common"
            | "windows.scheduled_tasks"
            | "windows.services"
            | "windows.advanced_autoruns"
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn helper_allowlist_excludes_system_managed_sources() {
        assert!(helper_source_is_allowlisted("windows.scheduled_tasks"));
        assert!(helper_source_is_allowlisted("windows.advanced_autoruns"));
        assert!(helper_source_is_allowlisted("windows.services"));
        assert!(helper_source_is_allowlisted("windows.startup_folder.common"));
        assert!(!helper_source_is_allowlisted("windows.packaged_startup_tasks"));
        assert!(!helper_source_is_allowlisted("windows.anything_else"));
    }

    #[test]
    fn bounded_executor_preserves_order_and_limits_parallel_work() {
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let items = (0..9).collect::<Vec<_>>();

        let results = execute_bounded(&items, 3, |item| {
            let current = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(current, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(10));
            active.fetch_sub(1, Ordering::SeqCst);
            item * 2
        });

        assert_eq!(
            results,
            items.iter().map(|item| Some(item * 2)).collect::<Vec<_>>()
        );
        assert_eq!(peak.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn bounded_executor_treats_a_zero_limit_as_one_worker() {
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let results = execute_bounded(&[1, 2, 3], 0, |item| {
            let current = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(current, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(5));
            active.fetch_sub(1, Ordering::SeqCst);
            item * 2
        });

        assert_eq!(results, vec![Some(2), Some(4), Some(6)]);
        assert_eq!(peak.load(Ordering::SeqCst), 1);
    }
}
