//! Compiled-in catalog of supported Windows system settings.
//!
//! Only settings listed here can be scanned or changed. Every entry carries the
//! product metadata the catalog service needs plus the private native identity
//! the Windows adapter uses, so a setting identifier can never be turned into an
//! arbitrary registry path or command at runtime.
//!
//! macOS and Linux have no entries: the product model only exposes Windows, and
//! the reference catalog's macOS table is intentionally not ported.

use crate::system_settings::{
    models::{SystemSettingCategory, SystemSettingRiskLevel, SystemSettingSelectionKind},
    platform::PlatformSystemSettingValue,
};

/// A typed catalog value.
///
/// Static text is converted into an owned value only when a caller needs it for
/// comparison with a native reading.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DefinitionValue {
    Missing,
    Boolean(bool),
    Integer(i64),
    Text(&'static str),
}

impl DefinitionValue {
    pub(crate) fn owned(self) -> PlatformSystemSettingValue {
        match self {
            Self::Missing => PlatformSystemSettingValue::Missing,
            Self::Boolean(value) => PlatformSystemSettingValue::Boolean(value),
            Self::Integer(value) => PlatformSystemSettingValue::Integer(value),
            Self::Text(value) => PlatformSystemSettingValue::Text(value.to_owned()),
        }
    }
}

/// Registry hive that owns a setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RegistryRoot {
    CurrentUser,
    LocalMachine,
}

/// Native registry value type the adapter writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RegistryValueKind {
    Dword,
    Text,
}

/// Windows generation on which a native contract is meaningful.
///
/// Version-scoped contracts fail closed when the build cannot be read: writing a
/// policy for the wrong generation can report success without changing the UI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BuildApplicability {
    Any,
    Before(u32),
    AtLeast(u32),
    Range {
        inclusive_start: u32,
        exclusive_end: u32,
    },
}

/// How the native adapter reads and writes a setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeContract {
    /// One scalar registry value described by [`NativeIdentity`].
    Registry,
    /// Windows 11 tracks one promoted flag per notification icon instead of the
    /// single Windows 10 `EnableAutoTray` switch.
    Windows11TrayIcons,
    /// Explorer's shortcut naming template, which needs lossless REG_SZ recovery.
    ShortcutNameTemplate,
    /// The catalog entry is kept for completeness, but the port has no native
    /// implementation for it.
    Unavailable,
}

/// Private native identity for one setting.
///
/// The product layer never sees these fields; only the Windows adapter resolves
/// them from a compiled-in identifier.
#[derive(Clone, Copy, Debug)]
pub(crate) struct NativeIdentity {
    pub contract: NativeContract,
    pub root: RegistryRoot,
    pub subkey: &'static str,
    pub value_name: &'static str,
    pub kind: RegistryValueKind,
    /// Whether the write must run in the elevated helper.
    pub requires_elevation: bool,
    /// Optional Windows components must exist before the setting is offered, so
    /// a generic registry write can never fabricate a missing service key.
    pub requires_existing_key: bool,
    pub applicability: BuildApplicability,
    /// Restoring the default removes the whole tree instead of one value.
    pub delete_tree_subkey: Option<&'static str>,
    /// Semicolon-delimited value that owns only one field.
    pub composite_text_key: Option<&'static str>,
}

impl NativeIdentity {
    const fn user(
        subkey: &'static str,
        value_name: &'static str,
        kind: RegistryValueKind,
    ) -> Self {
        Self {
            contract: NativeContract::Registry,
            root: RegistryRoot::CurrentUser,
            subkey,
            value_name,
            kind,
            requires_elevation: false,
            requires_existing_key: false,
            applicability: BuildApplicability::Any,
            delete_tree_subkey: None,
            composite_text_key: None,
        }
    }

    /// Marks a user-scoped policy that Windows exposes below a read-only policy
    /// parent. The elevated helper still writes the current user's hive; the flag
    /// only separates privilege routing from registry scope.
    const fn elevated_user(
        subkey: &'static str,
        value_name: &'static str,
        kind: RegistryValueKind,
    ) -> Self {
        let mut identity = Self::user(subkey, value_name, kind);
        identity.requires_elevation = true;
        identity
    }

    const fn machine(
        subkey: &'static str,
        value_name: &'static str,
        kind: RegistryValueKind,
    ) -> Self {
        let mut identity = Self::user(subkey, value_name, kind);
        identity.root = RegistryRoot::LocalMachine;
        identity.requires_elevation = true;
        identity
    }

    const fn existing_machine(
        subkey: &'static str,
        value_name: &'static str,
        kind: RegistryValueKind,
    ) -> Self {
        let mut identity = Self::machine(subkey, value_name, kind);
        identity.requires_existing_key = true;
        identity
    }

    const fn at_least(mut self, inclusive_build: u32) -> Self {
        self.applicability = BuildApplicability::AtLeast(inclusive_build);
        self
    }

    const fn before(mut self, exclusive_build: u32) -> Self {
        self.applicability = BuildApplicability::Before(exclusive_build);
        self
    }

    const fn range(mut self, inclusive_start: u32, exclusive_end: u32) -> Self {
        self.applicability = BuildApplicability::Range {
            inclusive_start,
            exclusive_end,
        };
        self
    }

    const fn composite(mut self, key: &'static str) -> Self {
        self.composite_text_key = Some(key);
        self
    }

    const fn delete_tree(mut self, subkey: &'static str) -> Self {
        self.delete_tree_subkey = Some(subkey);
        self
    }

    const fn windows11_tray(mut self) -> Self {
        self.contract = NativeContract::Windows11TrayIcons;
        self
    }

    const fn shortcut_name_template(mut self) -> Self {
        self.contract = NativeContract::ShortcutNameTemplate;
        self
    }

    const fn unavailable(mut self) -> Self {
        self.contract = NativeContract::Unavailable;
        self
    }
}

/// One compiled-in setting with product metadata and its native identity.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SettingDefinition {
    pub setting_id: &'static str,
    pub category: SystemSettingCategory,
    pub selection_kind: SystemSettingSelectionKind,
    pub risk_level: SystemSettingRiskLevel,
    /// One-click settings are preselected when a scan reports them as recommended.
    pub selected_by_default: bool,
    pub requires_restart: bool,
    pub requires_elevation: bool,
    pub default_value: DefinitionValue,
    /// Optional explicit value used when an already optimized setting is switched
    /// off, which is needed when the operating-system default is itself the
    /// recommended value.
    pub disabled_value: Option<DefinitionValue>,
    pub recommended_value: DefinitionValue,
    pub native: NativeIdentity,
}

const fn one_click(
    setting_id: &'static str,
    category: SystemSettingCategory,
    default_value: DefinitionValue,
    recommended_value: DefinitionValue,
    requires_restart: bool,
    native: NativeIdentity,
) -> SettingDefinition {
    SettingDefinition {
        setting_id,
        category,
        selection_kind: SystemSettingSelectionKind::OneClick,
        risk_level: SystemSettingRiskLevel::Standard,
        selected_by_default: true,
        requires_restart,
        requires_elevation: native.requires_elevation,
        default_value,
        disabled_value: None,
        recommended_value,
        native,
    }
}

const fn custom(
    setting_id: &'static str,
    category: SystemSettingCategory,
    default_value: DefinitionValue,
    recommended_value: DefinitionValue,
    requires_restart: bool,
    native: NativeIdentity,
) -> SettingDefinition {
    SettingDefinition {
        setting_id,
        category,
        selection_kind: SystemSettingSelectionKind::Custom,
        risk_level: SystemSettingRiskLevel::Standard,
        selected_by_default: false,
        requires_restart,
        requires_elevation: native.requires_elevation,
        default_value,
        disabled_value: None,
        recommended_value,
        native,
    }
}

const fn with_disabled_value(
    mut definition: SettingDefinition,
    disabled_value: DefinitionValue,
) -> SettingDefinition {
    definition.disabled_value = Some(disabled_value);
    definition
}

const fn with_risk(
    mut definition: SettingDefinition,
    risk_level: SystemSettingRiskLevel,
) -> SettingDefinition {
    definition.risk_level = risk_level;
    definition
}

const WINDOWS_SETTINGS: &[SettingDefinition] = &[
    custom(
        "windows.explorer.remove-shortcut-suffix",
        SystemSettingCategory::Appearance,
        DefinitionValue::Missing,
        DefinitionValue::Text("%s.lnk"),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\NamingTemplates", "ShortcutNameTemplate", RegistryValueKind::Text).shortcut_name_template(),
    ),
    custom(
        "windows.explorer.hide-shortcut-arrows",
        SystemSettingCategory::Appearance,
        DefinitionValue::Boolean(false),
        DefinitionValue::Boolean(true),
        true,
        NativeIdentity::machine(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Shell Icons", "29", RegistryValueKind::Text).unavailable(),
    ),
    one_click(
        "windows.explorer.show-file-extensions",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "HideFileExt", RegistryValueKind::Dword),
    ),
    custom(
        "windows.explorer.show-hidden-files",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(2),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "Hidden", RegistryValueKind::Dword),
    ),
    custom(
        "windows.explorer.launch-this-pc",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(2),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "LaunchTo", RegistryValueKind::Dword),
    ),
    custom(
        "windows.explorer.compact-mode",
        SystemSettingCategory::Appearance,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "UseCompactMode", RegistryValueKind::Dword).at_least(22000),
    ),
    custom(
        "windows.explorer.show-full-path",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\CabinetState", "FullPath", RegistryValueKind::Dword),
    ),
    custom(
        "windows.explorer.show-item-checkboxes",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "AutoCheckSelect", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.explorer.hide-recent-files",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer", "ShowRecent", RegistryValueKind::Dword),
    ),
    custom(
        "windows.explorer.hide-frequent-folders",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer", "ShowFrequent", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.explorer.enable-auto-suggest",
        SystemSettingCategory::Productivity,
        DefinitionValue::Text("no"),
        DefinitionValue::Text("yes"),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\AutoComplete", "AutoSuggest", RegistryValueKind::Text),
    ),
    custom(
        "windows.explorer.disable-aero-shake",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "DisallowShaking", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.explorer.show-operation-details",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\OperationStatusManager", "EnthusiastMode", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.explorer.hide-sync-notifications",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "ShowSyncProviderNotifications", RegistryValueKind::Dword),
    ),
    with_disabled_value(
        custom(
            "windows.explorer.show-status-bar",
            SystemSettingCategory::Productivity,
            DefinitionValue::Integer(1),
            DefinitionValue::Integer(1),
            true,
            NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "ShowStatusBar", RegistryValueKind::Dword),
        ),
        DefinitionValue::Integer(0),
    ),
    custom(
        "windows.explorer.separate-process",
        SystemSettingCategory::Performance,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "SeparateProcess", RegistryValueKind::Dword),
    ),
    custom(
        "windows.explorer.restore-folders-at-login",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "PersistBrowsers", RegistryValueKind::Dword),
    ),
    custom(
        "windows.explorer.disable-sharing-wizard",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "SharingWizardOn", RegistryValueKind::Dword),
    ),
    custom(
        "windows.explorer.confirm-file-delete",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::elevated_user(r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer", "ConfirmFileDelete", RegistryValueKind::Dword),
    ),
    custom(
        "windows.explorer.use-manual-default-printer",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows NT\CurrentVersion\Windows", "LegacyDefaultPrinterMode", RegistryValueKind::Dword),
    ),
    custom(
        "windows.explorer.classic-context-menu",
        SystemSettingCategory::Productivity,
        DefinitionValue::Missing,
        DefinitionValue::Text(""),
        true,
        NativeIdentity::user(r"Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\InprocServer32", "", RegistryValueKind::Text).at_least(22000).delete_tree(r"Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}"),
    ),
    custom(
        "windows.explorer.remove-cast-to-device",
        SystemSettingCategory::Productivity,
        DefinitionValue::Missing,
        DefinitionValue::Text("Play to Menu"),
        true,
        NativeIdentity::machine(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Shell Extensions\Blocked", "{7AD84985-87B4-4a16-BE58-8B72A5B390F7}", RegistryValueKind::Text),
    ),
    custom(
        "windows.taskbar.show-seconds",
        SystemSettingCategory::Appearance,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "ShowSecondsInSystemClock", RegistryValueKind::Dword),
    ),
    custom(
        "windows.taskbar.hide-task-view",
        SystemSettingCategory::Appearance,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "ShowTaskViewButton", RegistryValueKind::Dword),
    ),
    custom(
        "windows.taskbar.hide-widgets",
        SystemSettingCategory::Privacy,
        DefinitionValue::Missing,
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Dsh", "AllowNewsAndInterests", RegistryValueKind::Dword).range(22000, 26100),
    ),
    custom(
        "windows.taskbar.disable-widgets-board",
        SystemSettingCategory::Privacy,
        DefinitionValue::Missing,
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Dsh", "DisableWidgetsBoard", RegistryValueKind::Dword).at_least(26100),
    ),
    custom(
        "windows.taskbar.enable-end-task",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced\TaskbarDeveloperSettings", "TaskbarEndTask", RegistryValueKind::Dword).at_least(22000),
    ),
    custom(
        "windows.taskbar.hide-search",
        SystemSettingCategory::Appearance,
        DefinitionValue::Integer(2),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Search", "SearchboxTaskbarMode", RegistryValueKind::Dword).before(26100),
    ),
    custom(
        "windows.taskbar.hide-search-policy",
        SystemSettingCategory::Appearance,
        DefinitionValue::Missing,
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\Windows Search", "ConfigureSearchOnTaskbarMode", RegistryValueKind::Dword).at_least(26100),
    ),
    custom(
        "windows.taskbar.align-left",
        SystemSettingCategory::Appearance,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "TaskbarAl", RegistryValueKind::Dword).at_least(22000),
    ),
    custom(
        "windows.taskbar.show-all-tray-icons",
        SystemSettingCategory::Appearance,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer", "EnableAutoTray", RegistryValueKind::Dword).windows11_tray(),
    ),
    custom(
        "windows.taskbar.hide-badges",
        SystemSettingCategory::Appearance,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "TaskbarBadges", RegistryValueKind::Dword),
    ),
    custom(
        "windows.taskbar.disable-flashing",
        SystemSettingCategory::Appearance,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "TaskbarFlashing", RegistryValueKind::Dword).at_least(22000),
    ),
    one_click(
        "windows.taskbar.hide-window-sharing",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "TaskbarSn", RegistryValueKind::Dword).at_least(22000),
    ),
    with_disabled_value(
        custom(
            "windows.taskbar.show-desktop-corner",
            SystemSettingCategory::Productivity,
            DefinitionValue::Integer(1),
            DefinitionValue::Integer(1),
            false,
            NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "TaskbarSd", RegistryValueKind::Dword).at_least(22000),
        ),
        DefinitionValue::Integer(0),
    ),
    custom(
        "windows.taskbar.hide-weather",
        SystemSettingCategory::Appearance,
        DefinitionValue::Missing,
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\Windows Feeds", "EnableFeeds", RegistryValueKind::Dword).before(22000),
    ),
    custom(
        "windows.taskbar.hide-chat",
        SystemSettingCategory::Appearance,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "TaskbarMn", RegistryValueKind::Dword).at_least(22000),
    ),
    custom(
        "windows.taskbar.hide-copilot",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "ShowCopilotButton", RegistryValueKind::Dword).range(22621, 26100),
    ),
    custom(
        "windows.taskbar.disable-animations",
        SystemSettingCategory::Performance,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "TaskbarAnimations", RegistryValueKind::Dword),
    ),
    with_disabled_value(
        custom(
            "windows.taskbar.show-on-all-displays",
            SystemSettingCategory::Productivity,
            DefinitionValue::Integer(1),
            DefinitionValue::Integer(1),
            true,
            NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "MMTaskbarEnabled", RegistryValueKind::Dword),
        ),
        DefinitionValue::Integer(0),
    ),
    custom(
        "windows.desktop.prefer-performance-effects",
        SystemSettingCategory::Performance,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(2),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects", "VisualFXSetting", RegistryValueKind::Dword),
    ),
    custom(
        "windows.windowing.disable-snap-assist",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "EnableSnapAssistFlyout", RegistryValueKind::Dword).at_least(22000),
    ),
    custom(
        "windows.personalization.dark-apps",
        SystemSettingCategory::Appearance,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", RegistryValueKind::Dword),
    ),
    custom(
        "windows.personalization.dark-system",
        SystemSettingCategory::Appearance,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "SystemUsesLightTheme", RegistryValueKind::Dword),
    ),
    custom(
        "windows.personalization.disable-transparency",
        SystemSettingCategory::Performance,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "EnableTransparency", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.gaming.enable-game-mode",
        SystemSettingCategory::Gaming,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        false,
        NativeIdentity::user(r"Software\Microsoft\GameBar", "AutoGameModeEnabled", RegistryValueKind::Dword),
    ),
    custom(
        "windows.gaming.disable-capture",
        SystemSettingCategory::Gaming,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\GameDVR", "AppCaptureEnabled", RegistryValueKind::Dword),
    ),
    custom(
        "windows.gaming.disable-game-dvr",
        SystemSettingCategory::Gaming,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"System\GameConfigStore", "GameDVR_Enabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.gaming.optimize-windowed-games",
        SystemSettingCategory::Gaming,
        DefinitionValue::Text(""),
        DefinitionValue::Text("SwapEffectUpgradeEnable=1;"),
        true,
        NativeIdentity::user(r"Software\Microsoft\DirectX\UserGpuPreferences", "DirectXUserGlobalSettings", RegistryValueKind::Text).at_least(22000).composite("SwapEffectUpgradeEnable"),
    ),
    custom(
        "windows.gaming.disable-game-bar-controller",
        SystemSettingCategory::Gaming,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\GameBar", "UseNexusForGameBarEnabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.gaming.disable-game-bar-tips",
        SystemSettingCategory::Gaming,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\GameBar", "ShowStartupPanel", RegistryValueKind::Dword),
    ),
    custom(
        "windows.gaming.disable-dynamic-lighting",
        SystemSettingCategory::Gaming,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Lighting", "AmbientLightingEnabled", RegistryValueKind::Dword).at_least(22000),
    ),
    custom(
        "windows.gaming.disable-app-lighting-control",
        SystemSettingCategory::Gaming,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Lighting", "ControlledByForegroundApp", RegistryValueKind::Dword).at_least(22000),
    ),
    one_click(
        "windows.performance.disable-background-store-apps",
        SystemSettingCategory::Performance,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\BackgroundAccessApplications", "GlobalUserDisabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.privacy.disable-advertising-id",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo", "Enabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.privacy.disable-tailored-experiences",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Privacy", "TailoredExperiencesWithDiagnosticDataEnabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.privacy.disable-activity-publishing",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Privacy", "PublishUserActivities", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.privacy.disable-activity-upload",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Privacy", "UploadUserActivities", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.privacy.disable-input-personalization",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        false,
        NativeIdentity::user(r"Software\Microsoft\InputPersonalization", "RestrictImplicitTextCollection", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.privacy.disable-ink-personalization",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        false,
        NativeIdentity::user(r"Software\Microsoft\InputPersonalization", "RestrictImplicitInkCollection", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.privacy.disable-feedback-requests",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Siuf\Rules", "NumberOfSIUFInPeriod", RegistryValueKind::Dword),
    ),
    custom(
        "windows.privacy.disable-nearby-sharing",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\CDP", "NearShareChannelUserAuthzPolicy", RegistryValueKind::Dword),
    ),
    custom(
        "windows.privacy.disable-cross-device-experiences",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\CDP", "RomeSdkChannelUserAuthzPolicy", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.privacy.disable-language-list-sharing",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        false,
        NativeIdentity::user(r"Control Panel\International\User Profile", "HttpAcceptLanguageOptOut", RegistryValueKind::Dword),
    ),
    with_disabled_value(
        custom(
            "windows.clipboard.disable-history",
            SystemSettingCategory::Privacy,
            DefinitionValue::Integer(0),
            DefinitionValue::Integer(0),
            false,
            NativeIdentity::user(r"Software\Microsoft\Clipboard", "EnableClipboardHistory", RegistryValueKind::Dword),
        ),
        DefinitionValue::Integer(1),
    ),
    one_click(
        "windows.content.disable-silent-app-installs",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "SilentInstalledAppsEnabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.content.disable-suggestions",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "SoftLandingEnabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.content.disable-lock-screen-tips",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "RotatingLockScreenOverlayEnabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.content.disable-welcome-experience",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "SubscribedContent-310093Enabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.content.disable-usage-tips",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "SubscribedContent-338389Enabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.content.disable-notification-suggestions",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "SystemPaneSuggestionsEnabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.content.disable-device-setup-suggestions",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement", "ScoobeSystemSettingEnabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.content.disable-spotlight",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "RotatingLockScreenEnabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.content.disable-phone-link-suggestions",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Mobility", "OptedIn", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.content.disable-service-suggestions",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\Windows.SystemToast.Suggested", "Enabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.content.disable-preinstalled-app-suggestions",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "PreInstalledAppsEverEnabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.search.disable-highlights",
        SystemSettingCategory::Privacy,
        DefinitionValue::Missing,
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\Windows Search", "EnableDynamicContentInWSB", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.start.disable-recommendations",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "Start_IrisRecommendations", RegistryValueKind::Dword).at_least(22000),
    ),
    one_click(
        "windows.start.disable-account-notifications",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "Start_AccountNotifications", RegistryValueKind::Dword).at_least(22000),
    ),
    one_click(
        "windows.start.hide-recently-added-apps",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Start", "ShowRecentList", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.start.hide-most-used-apps",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Start", "ShowFrequentList", RegistryValueKind::Dword).at_least(22000),
    ),
    one_click(
        "windows.start.hide-recent-items",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "Start_TrackDocs", RegistryValueKind::Dword),
    ),
    custom(
        "windows.edge.disable-sidebar",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Edge", "HubsSidebarEnabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.edge.disable-personalization",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Edge", "PersonalizationReportingEnabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.edge.disable-recommendations",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Edge", "SpotlightExperiencesAndRecommendationsEnabled", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.edge.limit-diagnostic-data",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(2),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Edge", "DiagnosticData", RegistryValueKind::Dword),
    ),
    custom(
        "windows.edge.disable-web-widget",
        SystemSettingCategory::Privacy,
        DefinitionValue::Missing,
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Edge", "WebWidgetAllowed", RegistryValueKind::Dword),
    ),
    custom(
        "windows.office.disable-optional-telemetry",
        SystemSettingCategory::Privacy,
        DefinitionValue::Missing,
        DefinitionValue::Integer(3),
        true,
        NativeIdentity::elevated_user(r"Software\Policies\Microsoft\Office\16.0\Common\Privacy", "SendTelemetry", RegistryValueKind::Dword),
    ),
    custom(
        "windows.firefox.disable-telemetry",
        SystemSettingCategory::Privacy,
        DefinitionValue::Missing,
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Mozilla\Firefox", "DisableTelemetry", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.ai.disable-recall-snapshots",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\WindowsAI", "DisableAIDataAnalysis", RegistryValueKind::Dword).at_least(26100),
    ),
    custom(
        "windows.ai.disable-copilot",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\WindowsCopilot", "TurnOffWindowsCopilot", RegistryValueKind::Dword).at_least(22000),
    ),
    custom(
        "windows.typing.disable-autocorrect",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\TabletTip\1.7", "EnableAutocorrection", RegistryValueKind::Dword),
    ),
    custom(
        "windows.typing.disable-spellcheck",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\TabletTip\1.7", "EnableSpellchecking", RegistryValueKind::Dword),
    ),
    custom(
        "windows.typing.disable-text-prediction",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\TabletTip\1.7", "EnableTextPrediction", RegistryValueKind::Dword),
    ),
    custom(
        "windows.typing.disable-double-space-period",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::user(r"Software\Microsoft\TabletTip\1.7", "EnableDoubleTapSpace", RegistryValueKind::Dword),
    ),
    custom(
        "windows.accessibility.disable-sticky-keys-shortcut",
        SystemSettingCategory::Productivity,
        DefinitionValue::Text("510"),
        DefinitionValue::Text("506"),
        false,
        NativeIdentity::user(r"Control Panel\Accessibility\StickyKeys", "Flags", RegistryValueKind::Text),
    ),
    custom(
        "windows.accessibility.disable-filter-keys-shortcut",
        SystemSettingCategory::Productivity,
        DefinitionValue::Text("126"),
        DefinitionValue::Text("122"),
        false,
        NativeIdentity::user(r"Control Panel\Accessibility\Keyboard Response", "Flags", RegistryValueKind::Text),
    ),
    custom(
        "windows.accessibility.disable-toggle-keys-shortcut",
        SystemSettingCategory::Productivity,
        DefinitionValue::Text("62"),
        DefinitionValue::Text("58"),
        false,
        NativeIdentity::user(r"Control Panel\Accessibility\ToggleKeys", "Flags", RegistryValueKind::Text),
    ),
    custom(
        "windows.search.disable-web-suggestions",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\Explorer", "DisableSearchBoxSuggestions", RegistryValueKind::Dword),
    ),
    custom(
        "windows.storage.enable-storage-sense",
        SystemSettingCategory::Storage,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        false,
        NativeIdentity::user(r"Software\Microsoft\Windows\CurrentVersion\StorageSense\Parameters\StoragePolicy", "01", RegistryValueKind::Dword),
    ),
    custom(
        "windows.desktop.reduce-menu-delay",
        SystemSettingCategory::Performance,
        DefinitionValue::Text("400"),
        DefinitionValue::Text("200"),
        false,
        NativeIdentity::user(r"Control Panel\Desktop", "MenuShowDelay", RegistryValueKind::Text),
    ),
    custom(
        "windows.desktop.reduce-hover-delay",
        SystemSettingCategory::Performance,
        DefinitionValue::Text("400"),
        DefinitionValue::Text("100"),
        false,
        NativeIdentity::user(r"Control Panel\Mouse", "MouseHoverTime", RegistryValueKind::Text),
    ),
    custom(
        "windows.performance.reduce-crash-dump",
        SystemSettingCategory::Storage,
        DefinitionValue::Integer(7),
        DefinitionValue::Integer(3),
        true,
        NativeIdentity::machine(r"SYSTEM\CurrentControlSet\Control\CrashControl", "CrashDumpEnabled", RegistryValueKind::Dword),
    ),
    custom(
        "windows.privacy.disable-remote-assistance",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::machine(r"SYSTEM\CurrentControlSet\Control\Remote Assistance", "fAllowToGetHelp", RegistryValueKind::Dword),
    ),
    custom(
        "windows.performance.reduce-service-shutdown-timeout",
        SystemSettingCategory::Performance,
        DefinitionValue::Text("5000"),
        DefinitionValue::Text("2000"),
        true,
        NativeIdentity::machine(r"SYSTEM\CurrentControlSet\Control", "WaitToKillServiceTimeout", RegistryValueKind::Text),
    ),
    custom(
        "windows.performance.disable-network-throttling",
        SystemSettingCategory::Gaming,
        DefinitionValue::Missing,
        DefinitionValue::Integer(4294967295),
        true,
        NativeIdentity::machine(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile", "NetworkThrottlingIndex", RegistryValueKind::Dword),
    ),
    custom(
        "windows.performance.remove-reserved-bandwidth",
        SystemSettingCategory::Gaming,
        DefinitionValue::Integer(80),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\Psched", "NonBestEffortLimit", RegistryValueKind::Dword),
    ),
    custom(
        "windows.performance.multimedia-responsiveness",
        SystemSettingCategory::Gaming,
        DefinitionValue::Integer(14),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile", "SystemResponsiveness", RegistryValueKind::Dword),
    ),
    custom(
        "windows.performance.multimedia-no-lazy-mode",
        SystemSettingCategory::Gaming,
        DefinitionValue::Missing,
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile", "NoLazyMode", RegistryValueKind::Dword),
    ),
    custom(
        "windows.performance.multimedia-always-on",
        SystemSettingCategory::Gaming,
        DefinitionValue::Missing,
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile", "AlwaysOn", RegistryValueKind::Dword),
    ),
    custom(
        "windows.gaming.enable-hardware-gpu-scheduling",
        SystemSettingCategory::Gaming,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(2),
        true,
        NativeIdentity::machine(r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers", "HwSchMode", RegistryValueKind::Dword),
    ),
    custom(
        "windows.compatibility.disable-camera-frame-server",
        SystemSettingCategory::Performance,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::machine(r"SOFTWARE\WOW6432Node\Microsoft\Windows Media Foundation", "EnableFrameServerMode", RegistryValueKind::Dword),
    ),
    custom(
        "windows.services.print-spooler-manual",
        SystemSettingCategory::Performance,
        DefinitionValue::Integer(2),
        DefinitionValue::Integer(3),
        true,
        NativeIdentity::existing_machine(r"SYSTEM\CurrentControlSet\Services\Spooler", "Start", RegistryValueKind::Dword),
    ),
    custom(
        "windows.services.disable-sysmain",
        SystemSettingCategory::Performance,
        DefinitionValue::Integer(2),
        DefinitionValue::Integer(4),
        true,
        NativeIdentity::existing_machine(r"SYSTEM\CurrentControlSet\Services\SysMain", "Start", RegistryValueKind::Dword),
    ),
    custom(
        "windows.services.disable-compatibility-assistant",
        SystemSettingCategory::Performance,
        DefinitionValue::Integer(2),
        DefinitionValue::Integer(4),
        true,
        NativeIdentity::existing_machine(r"SYSTEM\CurrentControlSet\Services\PcaSvc", "Start", RegistryValueKind::Dword),
    ),
    with_risk(
        custom(
            "windows.services.disable-search-indexing",
            SystemSettingCategory::Performance,
            DefinitionValue::Integer(2),
            DefinitionValue::Integer(4),
            true,
            NativeIdentity::existing_machine(r"SYSTEM\CurrentControlSet\Services\WSearch", "Start", RegistryValueKind::Dword),
        ),
        SystemSettingRiskLevel::Caution,
    ),
    custom(
        "windows.services.disable-diagnostic-tracking",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(2),
        DefinitionValue::Integer(4),
        true,
        NativeIdentity::existing_machine(r"SYSTEM\CurrentControlSet\Services\DiagTrack", "Start", RegistryValueKind::Dword),
    ),
    custom(
        "windows.services.disable-error-reporting",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(2),
        DefinitionValue::Integer(4),
        true,
        NativeIdentity::existing_machine(r"SYSTEM\CurrentControlSet\Services\WerSvc", "Start", RegistryValueKind::Dword),
    ),
    custom(
        "windows.services.disable-sensors",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(2),
        DefinitionValue::Integer(4),
        true,
        NativeIdentity::existing_machine(r"SYSTEM\CurrentControlSet\Services\SensrSvc", "Start", RegistryValueKind::Dword),
    ),
    custom(
        "windows.services.disable-insider",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(3),
        DefinitionValue::Integer(4),
        true,
        NativeIdentity::existing_machine(r"SYSTEM\CurrentControlSet\Services\wisvc", "Start", RegistryValueKind::Dword),
    ),
    custom(
        "windows.services.disable-xbox-auth",
        SystemSettingCategory::Gaming,
        DefinitionValue::Integer(2),
        DefinitionValue::Integer(4),
        true,
        NativeIdentity::existing_machine(r"SYSTEM\CurrentControlSet\Services\XblAuthManager", "Start", RegistryValueKind::Dword),
    ),
    custom(
        "windows.services.disable-fax",
        SystemSettingCategory::Performance,
        DefinitionValue::Integer(3),
        DefinitionValue::Integer(4),
        true,
        NativeIdentity::existing_machine(r"SYSTEM\CurrentControlSet\Services\Fax", "Start", RegistryValueKind::Dword),
    ),
    custom(
        "windows.services.disable-media-player-sharing",
        SystemSettingCategory::Performance,
        DefinitionValue::Integer(3),
        DefinitionValue::Integer(4),
        true,
        NativeIdentity::existing_machine(r"SYSTEM\CurrentControlSet\Services\WMPNetworkSvc", "Start", RegistryValueKind::Dword),
    ),
    with_risk(
        custom(
            "windows.security.disable-system-restore",
            SystemSettingCategory::Storage,
            DefinitionValue::Missing,
            DefinitionValue::Integer(1),
            true,
            NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows NT\SystemRestore", "DisableSR", RegistryValueKind::Dword),
        ),
        SystemSettingRiskLevel::High,
    ),
    with_risk(
        custom(
            "windows.security.disable-defender",
            SystemSettingCategory::Privacy,
            DefinitionValue::Missing,
            DefinitionValue::Integer(1),
            true,
            NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows Defender", "DisableAntiVirus", RegistryValueKind::Dword),
        ),
        SystemSettingRiskLevel::High,
    ),
    with_risk(
        custom(
            "windows.security.disable-smartscreen",
            SystemSettingCategory::Privacy,
            DefinitionValue::Missing,
            DefinitionValue::Integer(0),
            true,
            NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\System", "EnableSmartScreen", RegistryValueKind::Dword),
        ),
        SystemSettingRiskLevel::High,
    ),
    custom(
        "windows.security.disable-autorun",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(145),
        DefinitionValue::Integer(255),
        true,
        NativeIdentity::elevated_user(r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer", "NoDriveTypeAutoRun", RegistryValueKind::Dword),
    ),
    custom(
        "windows.network.disable-llmnr",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows NT\DNSClient", "EnableMulticast", RegistryValueKind::Dword),
    ),
    custom(
        "windows.network.disable-smb1",
        SystemSettingCategory::Privacy,
        DefinitionValue::Missing,
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::machine(r"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters", "SMB1", RegistryValueKind::Dword),
    ),
    with_risk(
        custom(
            "windows.network.disable-smb2",
            SystemSettingCategory::Privacy,
            DefinitionValue::Missing,
            DefinitionValue::Integer(0),
            true,
            NativeIdentity::machine(r"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters", "SMB2", RegistryValueKind::Dword),
        ),
        SystemSettingRiskLevel::High,
    ),
    with_risk(
        custom(
            "windows.security.disable-vbs",
            SystemSettingCategory::Gaming,
            DefinitionValue::Integer(1),
            DefinitionValue::Integer(0),
            true,
            NativeIdentity::machine(r"SYSTEM\CurrentControlSet\Control\DeviceGuard", "EnableVirtualizationBasedSecurity", RegistryValueKind::Dword),
        ),
        SystemSettingRiskLevel::High,
    ),
    custom(
        "windows.storage.disable-ntfs-last-access",
        SystemSettingCategory::Storage,
        DefinitionValue::Integer(2),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SYSTEM\CurrentControlSet\Control\FileSystem", "NtfsDisableLastAccessUpdate", RegistryValueKind::Dword),
    ),
    with_risk(
        custom(
            "windows.update.notify-before-download",
            SystemSettingCategory::Productivity,
            DefinitionValue::Missing,
            DefinitionValue::Integer(2),
            true,
            NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU", "AUOptions", RegistryValueKind::Dword),
        ),
        SystemSettingRiskLevel::Caution,
    ),
    custom(
        "windows.update.disable-peer-sharing",
        SystemSettingCategory::Privacy,
        DefinitionValue::Missing,
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization", "DODownloadMode", RegistryValueKind::Dword),
    ),
    one_click(
        "windows.update.disable-preview-builds",
        SystemSettingCategory::Productivity,
        DefinitionValue::Missing,
        DefinitionValue::Integer(0),
        false,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate", "ManagePreviewBuilds", RegistryValueKind::Dword),
    ),
    custom(
        "windows.update.prevent-restart-when-logged-on",
        SystemSettingCategory::Productivity,
        DefinitionValue::Missing,
        DefinitionValue::Integer(1),
        false,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU", "NoAutoRebootWithLoggedOnUsers", RegistryValueKind::Dword),
    ),
    custom(
        "windows.update.enable-microsoft-product-updates",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        false,
        NativeIdentity::machine(r"SOFTWARE\Microsoft\WindowsUpdate\UX\Settings", "AllowMUUpdateService", RegistryValueKind::Dword),
    ),
    custom(
        "windows.update.enable-restart-notifications",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        false,
        NativeIdentity::machine(r"SOFTWARE\Microsoft\WindowsUpdate\UX\Settings", "RestartNotificationsAllowed2", RegistryValueKind::Dword),
    ),
    with_risk(
        custom(
            "windows.update.disable-automatic-updates",
            SystemSettingCategory::Productivity,
            DefinitionValue::Missing,
            DefinitionValue::Integer(1),
            false,
            NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU", "NoAutoUpdate", RegistryValueKind::Dword),
        ),
        SystemSettingRiskLevel::High,
    ),
    one_click(
        "windows.privacy.limit-diagnostic-data",
        SystemSettingCategory::Privacy,
        DefinitionValue::Missing,
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\DataCollection", "AllowTelemetry", RegistryValueKind::Dword),
    ),
    with_risk(
        custom(
            "windows.update.exclude-driver-updates",
            SystemSettingCategory::Productivity,
            DefinitionValue::Integer(0),
            DefinitionValue::Integer(1),
            true,
            NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate", "ExcludeWUDriversInQualityUpdate", RegistryValueKind::Dword),
        ),
        SystemSettingRiskLevel::Caution,
    ),
    with_risk(
        custom(
            "windows.update.disable-store-auto-updates",
            SystemSettingCategory::Productivity,
            DefinitionValue::Missing,
            DefinitionValue::Integer(2),
            true,
            NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\WindowsStore", "AutoDownload", RegistryValueKind::Dword),
        ),
        SystemSettingRiskLevel::Caution,
    ),
    custom(
        "windows.cloud.disable-onedrive-sync",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\OneDrive", "DisableFileSyncNGSC", RegistryValueKind::Dword),
    ),
    custom(
        "windows.search.disable-cortana-policy",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\Windows Search", "AllowCortana", RegistryValueKind::Dword),
    ),
    custom(
        "windows.input.disable-windows-ink",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\WindowsInkWorkspace", "AllowWindowsInkWorkspace", RegistryValueKind::Dword),
    ),
    custom(
        "windows.clipboard.disable-cross-device-policy",
        SystemSettingCategory::Privacy,
        DefinitionValue::Integer(1),
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::machine(r"SOFTWARE\Policies\Microsoft\Windows\System", "AllowCrossDeviceClipboard", RegistryValueKind::Dword),
    ),
    custom(
        "windows.filesystem.enable-long-paths",
        SystemSettingCategory::Productivity,
        DefinitionValue::Integer(0),
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SYSTEM\CurrentControlSet\Control\FileSystem", "LongPathsEnabled", RegistryValueKind::Dword),
    ),
    with_risk(
        custom(
            "windows.setup.bypass-hardware-checks",
            SystemSettingCategory::Productivity,
            DefinitionValue::Integer(0),
            DefinitionValue::Integer(1),
            true,
            NativeIdentity::machine(r"SYSTEM\Setup\MoSetup", "AllowUpgradesWithUnsupportedTPMOrCPU", RegistryValueKind::Dword),
        ),
        SystemSettingRiskLevel::Caution,
    ),
    custom(
        "windows.time.use-utc-hardware-clock",
        SystemSettingCategory::Productivity,
        DefinitionValue::Missing,
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SYSTEM\CurrentControlSet\Control\TimeZoneInformation", "RealTimeIsUniversal", RegistryValueKind::Dword),
    ),
    custom(
        "windows.power.disable-modern-standby",
        SystemSettingCategory::Performance,
        DefinitionValue::Missing,
        DefinitionValue::Integer(0),
        true,
        NativeIdentity::machine(r"SYSTEM\CurrentControlSet\Control\Power", "PlatformAoAcOverride", RegistryValueKind::Dword),
    ),
    with_risk(
        custom(
            "windows.power.disable-hibernation",
            SystemSettingCategory::Storage,
            DefinitionValue::Integer(1),
            DefinitionValue::Integer(0),
            true,
            NativeIdentity::machine(r"SYSTEM\CurrentControlSet\Control\Power", "HibernateEnabled", RegistryValueKind::Dword),
        ),
        SystemSettingRiskLevel::Caution,
    ),
    custom(
        "windows.recovery.enable-registry-backups",
        SystemSettingCategory::Storage,
        DefinitionValue::Missing,
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SYSTEM\CurrentControlSet\Control\Session Manager\Configuration Manager", "EnablePeriodicBackup", RegistryValueKind::Dword),
    ),
    custom(
        "windows.login.enable-verbose-status",
        SystemSettingCategory::Productivity,
        DefinitionValue::Missing,
        DefinitionValue::Integer(1),
        true,
        NativeIdentity::machine(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "VerboseStatus", RegistryValueKind::Dword),
    ),
];

/// Returns every setting the Windows adapter may scan or change.
pub(crate) fn definitions() -> &'static [SettingDefinition] {
    WINDOWS_SETTINGS
}

/// Resolves one setting identifier from the compiled-in catalog.
pub(crate) fn definition(setting_id: &str) -> Option<&'static SettingDefinition> {
    definitions()
        .iter()
        .find(|definition| definition.setting_id == setting_id)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    const EXPECTED_SETTING_COUNT: usize = 153;

    #[test]
    fn catalog_contains_every_windows_setting_exactly_once() {
        let ids = definitions()
            .iter()
            .map(|definition| definition.setting_id)
            .collect::<Vec<_>>();
        assert_eq!(ids.len(), EXPECTED_SETTING_COUNT);
        let unique = ids.iter().copied().collect::<BTreeSet<_>>();
        assert_eq!(unique.len(), EXPECTED_SETTING_COUNT);
    }

    #[test]
    fn catalog_covers_every_product_category() {
        let categories = definitions()
            .iter()
            .map(|definition| definition.category)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            categories,
            BTreeSet::from([
                SystemSettingCategory::Appearance,
                SystemSettingCategory::Gaming,
                SystemSettingCategory::Performance,
                SystemSettingCategory::Privacy,
                SystemSettingCategory::Productivity,
                SystemSettingCategory::Storage,
            ])
        );
    }

    #[test]
    fn definition_lookup_returns_the_matching_entry_only() {
        let shortcut = definition("windows.explorer.remove-shortcut-suffix")
            .expect("the shortcut naming setting should be present");
        assert_eq!(
            shortcut.category,
            SystemSettingCategory::Appearance
        );
        assert_eq!(
            shortcut.recommended_value,
            DefinitionValue::Text("%s.lnk")
        );
        assert_eq!(shortcut.default_value, DefinitionValue::Missing);
        assert_eq!(
            shortcut.native.contract,
            NativeContract::ShortcutNameTemplate
        );
        assert!(!shortcut.native.requires_elevation);
        assert!(definition("windows.unknown.setting").is_none());
    }

    #[test]
    fn every_entry_has_native_identity_and_consistent_elevation() {
        for definition in definitions() {
            assert!(
                !definition.native.subkey.is_empty(),
                "{} has no native subkey",
                definition.setting_id
            );
            assert_eq!(
                definition.requires_elevation, definition.native.requires_elevation,
                "{} elevation metadata disagrees with its native identity",
                definition.setting_id
            );
            assert_eq!(
                definition.selected_by_default,
                definition.selection_kind == SystemSettingSelectionKind::OneClick,
                "{} preselection must follow its selection kind",
                definition.setting_id
            );
        }
    }

    #[test]
    fn only_the_shortcut_overlay_is_known_to_be_unavailable() {
        let unavailable = definitions()
            .iter()
            .filter(|definition| definition.native.contract == NativeContract::Unavailable)
            .map(|definition| definition.setting_id)
            .collect::<Vec<_>>();
        assert_eq!(unavailable, ["windows.explorer.hide-shortcut-arrows"]);
    }

    #[test]
    fn typed_values_convert_to_platform_values() {
        assert_eq!(
            DefinitionValue::Missing.owned(),
            PlatformSystemSettingValue::Missing
        );
        assert_eq!(
            DefinitionValue::Boolean(true).owned(),
            PlatformSystemSettingValue::Boolean(true)
        );
        assert_eq!(
            DefinitionValue::Integer(7).owned(),
            PlatformSystemSettingValue::Integer(7)
        );
        assert_eq!(
            DefinitionValue::Text("value").owned(),
            PlatformSystemSettingValue::Text("value".to_owned())
        );
    }
}
