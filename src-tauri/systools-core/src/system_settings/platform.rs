//! Platform-side system-settings contracts shared by the Windows adapter and
//! the product-level catalog service.

use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use serde::{Deserialize, Serialize};

use crate::{
    platform::contracts::PlatformResult,
    shared::operation::{take_cancellation, CoordinatedOperationKind},
};

/// A typed value crossing the Core/platform boundary for one known setting.
/// Native storage details remain private to the operating-system adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub(crate) enum PlatformSystemSettingValue {
    Missing,
    Boolean(bool),
    Integer(i64),
    Text(String),
    /// An exact native snapshot used only for optimistic concurrency and durable recovery.
    /// Product status is derived from `PlatformSystemSettingState::effective_value` instead.
    Snapshot(PlatformSystemSettingSnapshot),
}

/// Exact representations for settings that cannot be safely modeled as one scalar value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub(crate) enum PlatformSystemSettingSnapshot {
    Text(String),
    IntegerMap(BTreeMap<String, Option<i64>>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlatformSystemSettingState {
    pub setting_id: String,
    /// Exact value retained for concurrency checks and recovery.
    pub value: PlatformSystemSettingValue,
    /// Logical scalar compared with the product catalog's recommended value.
    pub effective_value: PlatformSystemSettingValue,
    /// Reports the native capability boundary instead of asking Core to infer it from an ID.
    pub requires_elevation: bool,
    pub diagnostic: Option<crate::platform::contracts::PlatformSystemSettingDiagnosticCode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlatformSystemSettingChangeRequest {
    pub setting_id: String,
    pub expected_value: PlatformSystemSettingValue,
    pub desired_value: PlatformSystemSettingValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlatformSystemSettingChangeResult {
    pub value: PlatformSystemSettingValue,
    pub changed: bool,
    pub verified: bool,
}

/// Evaluates the optimistic-concurrency boundary shared by native adapters.
///
/// A value already equal to the desired state is a verified idempotent success,
/// which also lets crash recovery discard entries that were already restored.
/// Every other value must still match the scan snapshot before it can be changed.
pub(crate) fn preflight_system_setting_change(
    current_value: &PlatformSystemSettingValue,
    request: &PlatformSystemSettingChangeRequest,
) -> PlatformResult<Option<PlatformSystemSettingChangeResult>> {
    if current_value == &request.desired_value {
        return Ok(Some(PlatformSystemSettingChangeResult {
            value: current_value.clone(),
            changed: false,
            verified: true,
        }));
    }
    if current_value != &request.expected_value {
        return Err(crate::platform::contracts::PlatformError::item_changed(
            "system setting changed after plan creation",
        ));
    }
    Ok(None)
}

/// Exposes only the finite setting catalog compiled into Systools. Adapters
/// must reject unknown identifiers so input can never select an arbitrary
/// registry path or command.
pub(crate) trait SystemSettingsPlatform: Send + Sync {
    fn scan_system_settings(
        &self,
        setting_ids: &[&str],
        cancellation: &SystemSettingsCancellation,
    ) -> PlatformResult<Vec<PlatformSystemSettingState>>;

    fn change_system_setting(
        &self,
        request: &PlatformSystemSettingChangeRequest,
    ) -> PlatformResult<PlatformSystemSettingChangeResult>;

    /// Applies a prepared batch while preserving the result order.
    fn change_system_settings(
        &self,
        requests: &[PlatformSystemSettingChangeRequest],
    ) -> PlatformResult<Vec<PlatformResult<PlatformSystemSettingChangeResult>>> {
        Ok(requests
            .iter()
            .map(|request| self.change_system_setting(request))
            .collect())
    }
}

/// Process-wide cancellation handle for one system-settings operation.
#[derive(Clone)]
pub(crate) struct SystemSettingsCancellation {
    kind: CoordinatedOperationKind,
    cancelled: Arc<AtomicBool>,
}

impl SystemSettingsCancellation {
    pub(crate) fn scan() -> Self {
        Self::new(CoordinatedOperationKind::SystemSettingsScan)
    }

    /// Observes the cancellation flag owned by the active operation guard.
    ///
    /// The shared registry only receives a request when no operation is running;
    /// while a scan is active the token sets the guard's flag directly, so the
    /// adapter must read that same flag to observe a mid-scan cancellation.
    pub(crate) fn scan_with_flag(cancelled: Arc<AtomicBool>) -> Self {
        Self {
            kind: CoordinatedOperationKind::SystemSettingsScan,
            cancelled,
        }
    }

    pub(crate) fn change() -> Self {
        Self::new(CoordinatedOperationKind::SystemSettingsChange)
    }

    fn new(kind: CoordinatedOperationKind) -> Self {
        Self {
            kind,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        if self.cancelled.load(Ordering::Relaxed) {
            return true;
        }
        if take_cancellation(self.kind) {
            self.cancelled.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }

    /// Clears a latched cancellation so a later operation is not stopped by a
    /// request that was consumed by an operation which already finished.
    pub(crate) fn reset(&self) {
        self.cancelled.store(false, Ordering::Relaxed);
    }
}

#[cfg(windows)]
pub(crate) fn current_platform() -> &'static dyn SystemSettingsPlatform {
    crate::platform::windows::system_settings::platform()
}

#[cfg(not(windows))]
pub(crate) fn current_platform() -> &'static dyn SystemSettingsPlatform {
    struct Unsupported;

    impl SystemSettingsPlatform for Unsupported {
        fn scan_system_settings(
            &self,
            setting_ids: &[&str],
            _cancellation: &SystemSettingsCancellation,
        ) -> PlatformResult<Vec<PlatformSystemSettingState>> {
            Ok(setting_ids
                .iter()
                .map(|setting_id| PlatformSystemSettingState {
                    setting_id: (*setting_id).to_owned(),
                    value: PlatformSystemSettingValue::Missing,
                    effective_value: PlatformSystemSettingValue::Missing,
                    requires_elevation: false,
                    diagnostic: Some(
                        crate::platform::contracts::PlatformSystemSettingDiagnosticCode::Unsupported,
                    ),
                })
                .collect())
        }

        fn change_system_setting(
            &self,
            _request: &PlatformSystemSettingChangeRequest,
        ) -> PlatformResult<PlatformSystemSettingChangeResult> {
            Err(crate::platform::contracts::PlatformError::new(
                crate::platform::contracts::PlatformErrorCode::Unsupported,
                "system settings are unavailable on this platform",
            ))
        }
    }

    static UNSUPPORTED: Unsupported = Unsupported;
    &UNSUPPORTED
}
