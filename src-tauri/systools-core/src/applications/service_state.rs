//! Process-wide catalog state shared by the uninstall commands.
//!
//! The catalog is captured by a scan and reused by inspection, preparation,
//! and execution so every command can validate the revision the user reviewed.
//! Cancellation tokens are registered separately for scanning and execution;
//! cancel commands only flip the token and never block on the worker.
//!
//! Locks protect only the pointer swaps below. No filesystem, registry, or
//! process call runs while a lock is held, so a slow scan cannot stall cancel.

use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use crate::applications::catalog::Catalog;
use crate::applications::contracts::Cancellation;

static CATALOG: OnceLock<Mutex<Option<Arc<Catalog>>>> = OnceLock::new();
static SCAN_CANCELLATION: OnceLock<Mutex<Option<Cancellation>>> = OnceLock::new();
static EXECUTION_CANCELLATION: OnceLock<Mutex<Option<Cancellation>>> = OnceLock::new();

fn catalog_slot() -> &'static Mutex<Option<Arc<Catalog>>> {
    CATALOG.get_or_init(|| Mutex::new(None))
}

fn scan_slot() -> &'static Mutex<Option<Cancellation>> {
    SCAN_CANCELLATION.get_or_init(|| Mutex::new(None))
}

fn execution_slot() -> &'static Mutex<Option<Cancellation>> {
    EXECUTION_CANCELLATION.get_or_init(|| Mutex::new(None))
}

/// Recovers the guard when another thread panicked while holding the slot.
///
/// The guarded value is a single `Option`; a poisoned lock cannot leave it in a
/// partially updated state, so continuing is preferable to panicking a command.
fn lock<T>(slot: &'static Mutex<T>) -> MutexGuard<'static, T> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Replaces the cached catalog with a freshly captured snapshot.
pub(crate) fn store(catalog: Catalog) {
    *lock(catalog_slot()) = Some(Arc::new(catalog));
}

/// Returns the cached catalog for the current command without copying it.
pub(crate) fn current() -> Option<Arc<Catalog>> {
    lock(catalog_slot()).clone()
}

/// Drops the cached catalog. A later command must scan again.
pub(crate) fn clear() {
    *lock(catalog_slot()) = None;
}

/// Registers a new scan cancellation token and returns it to the worker.
pub(crate) fn begin_scan() -> Cancellation {
    let cancellation = Cancellation::new();
    *lock(scan_slot()) = Some(cancellation.clone());
    cancellation
}

/// Requests cancellation of the active scan, if any.
pub(crate) fn cancel_scan() {
    if let Some(cancellation) = lock(scan_slot()).as_ref() {
        cancellation.cancel();
    }
}

/// Clears the scan token after the worker returns.
pub(crate) fn finish_scan() {
    *lock(scan_slot()) = None;
}

/// Registers a new execution cancellation token and returns it to the worker.
pub(crate) fn begin_execution() -> Cancellation {
    let cancellation = Cancellation::new();
    *lock(execution_slot()) = Some(cancellation.clone());
    cancellation
}

/// Requests cancellation of the active batch between application boundaries.
pub(crate) fn cancel_execution() {
    if let Some(cancellation) = lock(execution_slot()).as_ref() {
        cancellation.cancel();
    }
}

/// Clears the execution token after the worker returns.
pub(crate) fn finish_execution() {
    *lock(execution_slot()) = None;
}
