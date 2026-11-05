//! Tauri commands mirroring the `shaic` TUI, one per TUI action.
//!
//! The upstream TUI (`shaic/tui/src/app.rs`) has five screens — setup wizard,
//! dashboard, agent detail, item browser and diff preview — and a set of
//! confirmable writes (push / pull / delete / apply / import). Each `App`
//! method there maps to one command here; the React UI is the new front end.
//! All real logic stays in the vendored `shaic-core`.

use std::path::{Path, PathBuf};

use serde::Serialize;

use shaic_core::adapters;
use shaic_core::config::Config;
use shaic_core::materialize::{self, WriteAction};
use shaic_core::model::{AgentId, Item, ItemKind, Scope};
use shaic_core::operations::{self, OperationKind};
use shaic_core::store::{self, Store};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Project-scope writes land in the project root configured under
/// Settings → Project.
///
/// The TUI infers this from the nearest `.git` ancestor of the process cwd,
/// but a desktop app runs from its own install directory — inferring from cwd
/// there would point every project-scope agent file at the app rather than at
/// the project the user works in. Fall back to the cwd inference only when no
/// project root is configured.
fn project_root() -> PathBuf {
    if let Some(root) = crate::config::load().project_root() {
        return PathBuf::from(root);
    }
    shaic_core::config::infer_project_root().unwrap_or_else(|_| PathBuf::from("."))
}

fn open_store() -> Result<Store, String> {
    Store::default_path()
        .and_then(Store::open)
        .map_err(|e| e.to_string())
}

/// Register the project root before any project-scope work, exactly as the
/// TUI's `open_diff_preview` and the CLI's `resolve_targets` do. Registration
/// is additive — it only ever writes a new entry to the machine config.
fn register_project_if_needed(scope: Scope, root: &Path) -> Result<(), String> {
    if scope != Scope::Project {
        return Ok(());
    }
    let mut config = Config::load().map_err(|e| format!("could not load config: {e}"))?;
    config
        .ensure_project_registered(root)
        .map_err(|e| e.to_string())
}

fn parse_agent(s: &str) -> Result<AgentId, String> {
    AgentId::ALL
        .into_iter()
        .find(|a| a.as_str() == s)
        .ok_or_else(|| format!("unknown agent: {s}"))
}

fn parse_kind(s: &str) -> Result<ItemKind, String> {
    ItemKind::ALL
        .into_iter()
        .find(|k| kind_str(*k) == s)
        .ok_or_else(|| format!("unknown item kind: {s}"))
}

fn kind_str(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Skill => "skill",
        ItemKind::Rule => "rule",
        ItemKind::Command => "command",
        ItemKind::Subagent => "subagent",
    }
}

fn scope_str(scope: Scope) -> &'static str {
    match scope {
        Scope::Global => "global",
        Scope::Project => "project",
    }
}

fn parse_scope(s: &str) -> Result<Scope, String> {
    match s {
        "global" => Ok(Scope::Global),
        "project" => Ok(Scope::Project),
        other => Err(format!("unknown scope: {other}")),
    }
}

/// Mirrors `shaic_tui::theme::Status` — the per-axis sync glyph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncStatus {
    InSync,
    Drift,
    Unconfirmed,
    Error,
}

impl SyncStatus {
    fn worst(self, other: SyncStatus) -> SyncStatus {
        fn rank(s: SyncStatus) -> u8 {
            match s {
                SyncStatus::Error => 0,
                SyncStatus::Drift => 1,
                SyncStatus::Unconfirmed => 2,
                SyncStatus::InSync => 3,
            }
        }
        if rank(other) < rank(self) { other } else { self }
    }
}

/// Mirrors `shaic_tui::theme::MessageKind` — the severity of a result message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageKind {
    Success,
    Warning,
    Info,
    Error,
}

impl From<OperationKind> for MessageKind {
    fn from(kind: OperationKind) -> Self {
        match kind {
            OperationKind::Success => MessageKind::Success,
            OperationKind::Info => MessageKind::Info,
            OperationKind::Warning => MessageKind::Warning,
            OperationKind::Error => MessageKind::Error,
        }
    }
}

/// The result of a store operation, as the TUI message bar would show it.
/// `force_required` is true when a secret scan blocked the operation and the
/// UI should ask the user to confirm an override (the TUI's push/pull-force
/// confirm), then retry with `allowSecrets = true`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub text: String,
    pub kind: MessageKind,
    pub force_required: bool,
}

/// `plan_glyph` from the TUI: an in-sync store plans empty; drift or a plan
/// error otherwise.
fn plan_glyph(in_sync: Result<bool, shaic_core::Error>) -> SyncStatus {
    match in_sync {
        Ok(true) => SyncStatus::InSync,
        Ok(false) => SyncStatus::Drift,
        Err(_) => SyncStatus::Error,
    }
}

/// The agent switches from the app's `config.json`, resolved to known ids.
///
/// `None` (the key is absent) means every agent — both the fresh-config default
/// and the behaviour before the setting existed. An explicit list is the user's
/// literal choice, so an empty one really does mean "no agents". Unknown ids are
/// dropped rather than treated as an error: the list survives a shaic-core
/// upgrade that adds or removes an agent.
fn enabled_agent_ids() -> Vec<AgentId> {
    match crate::config::load().ai_config.enabled_agents {
        None => AgentId::ALL.to_vec(),
        Some(ids) => AgentId::ALL
            .into_iter()
            .filter(|a| ids.iter().any(|s| s.eq_ignore_ascii_case(a.as_str())))
            .collect(),
    }
}

/// True when `agent` is switched on. Writes are refused for the others.
fn agent_enabled(id: AgentId) -> bool {
    enabled_agent_ids().contains(&id)
}


// ---------------------------------------------------------------------------
// Store status / setup wizard
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStatus {
    pub exists: bool,
    pub remote: Option<String>,
    pub project_root: String,
    pub store_path: String,
    pub enabled_agents: Vec<String>,
}

/// Whether a store is set up, plus the paths the TUI would use.
#[tauri::command]
pub fn shaic_status() -> Result<StoreStatus, String> {
    let store_path = Store::default_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let config = Config::load().map_err(|e| e.to_string())?;
    Ok(StoreStatus {
        exists: Store::default_path().and_then(Store::open).is_ok(),
        remote: config.remote.clone(),
        project_root: project_root().to_string_lossy().into_owned(),
        store_path,
        enabled_agents: enabled_agent_ids()
            .iter()
            .map(|a| a.as_str().to_string())
            .collect(),
    })
}

/// The setup wizard: validate the remote is reachable, init/clone the store,
/// then record the remote in the machine config.
#[tauri::command]
pub fn shaic_init(remote: String, force: bool) -> Result<OpResult, String> {
    let url = remote.trim();
    if url.is_empty() {
        return Err("enter a remote url first".to_string());
    }
    shaic_core::store::git::ls_remote(url).map_err(|e| {
        format!(
            "could not reach {}: {e}",
            shaic_core::store::git::redact_userinfo(url)
        )
    })?;
    let store = Store::default_path()
        .and_then(|p| Store::init_with_force(p, Some(url), force))
        .map_err(|e| format!("init failed: {e}"))?;
    let _ = store;
    let mut config = Config::load().map_err(|e| e.to_string())?;
    config.set_remote(url).map_err(|e| e.to_string())?;
    config.save().map_err(|e| e.to_string())?;
    Ok(OpResult {
        text: format!("initialized store from {}", shaic_core::store::git::redact_userinfo(url)),
        kind: MessageKind::Success,
        force_required: false,
    })
}

// ---------------------------------------------------------------------------
// Push / pull
// ---------------------------------------------------------------------------

fn push_with(allow_secrets: bool) -> Result<OpResult, String> {
    let store = open_store()?;
    match operations::push_store(&store, allow_secrets) {
        Ok((text, kind)) => Ok(OpResult {
            text,
            kind: kind.into(),
            force_required: false,
        }),
        Err(shaic_core::Error::SecretDetected(msg)) if !allow_secrets => Ok(OpResult {
            text: msg,
            kind: MessageKind::Warning,
            force_required: true,
        }),
        Err(e) => Err(format!("push failed: {e}")),
    }
}

fn pull_with(allow_secrets: bool) -> Result<OpResult, String> {
    let store = open_store()?;
    match operations::pull_store(&store, allow_secrets) {
        Ok((text, kind)) => Ok(OpResult {
            text,
            kind: kind.into(),
            force_required: false,
        }),
        Err(shaic_core::Error::SecretDetected(msg)) if !allow_secrets => Ok(OpResult {
            text: msg,
            kind: MessageKind::Warning,
            force_required: true,
        }),
        Err(e) => Err(format!("pull failed: {e}")),
    }
}

/// Commit and push the store to its remote. See `OpResult::force_required`.
#[tauri::command]
pub fn shaic_push(allow_secrets: Option<bool>) -> Result<OpResult, String> {
    push_with(allow_secrets.unwrap_or(false))
}

/// Fetch and fast-forward the store from its remote.
#[tauri::command]
pub fn shaic_pull(allow_secrets: Option<bool>) -> Result<OpResult, String> {
    pull_with(allow_secrets.unwrap_or(false))
}

// ---------------------------------------------------------------------------
// Dashboard / agent rows
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSubRowView {
    pub scope: String,
    pub content_status: Option<SyncStatus>,
    pub mcp_status: Option<SyncStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRowView {
    pub id: String,
    pub name: String,
    pub status: SyncStatus,
    pub sub_rows: Vec<AgentSubRowView>,
}

/// One row per agent with its worst status across every supported scope/axis —
/// the TUI dashboard.
#[tauri::command]
pub fn shaic_dashboard() -> Result<Vec<AgentRowView>, String> {
    let store = open_store()?;
    let root = project_root();
    let allowed = enabled_agent_ids();
    let mut rows = Vec::new();
    for &agent in adapters::registry() {
        // A switched-off agent is not part of the page at all: no row, no
        // status, nothing to plan against.
        if !allowed.contains(&agent.id()) {
            continue;
        }
        let mut sub_rows = Vec::new();
        for &scope in &[Scope::Global, Scope::Project] {
            let content_status = agent.supported_scopes().contains(&scope).then(|| {
                if agent.experimental_read_only() {
                    SyncStatus::Unconfirmed
                } else {
                    plan_glyph(
                        materialize::plan_materialize(agent, &store, scope, &root)
                            .map(|p| p.is_empty()),
                    )
                }
            });
            let mcp_status = agent
                .mcp_target(scope, &root)
                .is_some()
                .then(|| {
                    plan_glyph(materialize::plan_mcp(agent, &store, scope, &root).map(|p| p.is_empty()))
                });
            if content_status.is_none() && mcp_status.is_none() {
                continue;
            }
            sub_rows.push(AgentSubRowView {
                scope: scope_str(scope).to_string(),
                content_status,
                mcp_status,
            });
        }
        let status = sub_rows
            .iter()
            .flat_map(|r| r.content_status.into_iter().chain(r.mcp_status))
            .fold(SyncStatus::InSync, |acc, s| acc.worst(s));
        rows.push(AgentRowView {
            id: agent.id().as_str().to_string(),
            name: agent.display_name().to_string(),
            status,
            sub_rows,
        });
    }
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Agent detail
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindCountView {
    /// "skill" | "rule" | "command" | "subagent"
    pub kind: String,
    /// How many of this kind already exist on disk for the agent+scope.
    pub on_disk: usize,
}

/// One axis of one agent+scope: the content files, or the MCP servers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AxisView {
    /// "content" | "mcp"
    pub axis: String,
    pub status: SyncStatus,
    /// The path this axis reads and writes, when the agent has a trusted one.
    pub location: Option<String>,
    /// Content only: this agent's on-disk convention isn't confirmed, so nothing
    /// is written here and `status` is always `unconfirmed`.
    pub read_only: bool,
    /// Content only: how many of each supported kind are already on disk. Empty
    /// for the MCP axis.
    pub kinds: Vec<KindCountView>,
    /// Files the pending plan would write (create + update).
    pub to_write: usize,
    /// Files the pending plan would delete or remove.
    pub to_delete: usize,
    /// Why the plan could not be computed; `None` when it could.
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeView {
    pub scope: String,
    /// "content" first, then "mcp".
    pub axes: Vec<AxisView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetailView {
    pub agent: String,
    pub display_name: String,
    pub scopes: Vec<ScopeView>,
}

/// Breaks one agent down by scope, showing content and MCP status per zoom.
///
/// Structured rather than the TUI's text lines: the page draws the path, the
/// per-kind on-disk counts and the pending write/delete numbers as separate
/// pieces, and re-parsing a sentence back into them would be a step backwards.
#[tauri::command]
pub fn shaic_agent_detail(agent: String) -> Result<AgentDetailView, String> {
    let id = parse_agent(&agent)?;
    let agent_impl = adapters::by_id(id);
    let root = project_root();
    let store = open_store().ok();

    let mut scopes = Vec::new();
    for &scope in &[Scope::Global, Scope::Project] {
        let has_content = agent_impl.supported_scopes().contains(&scope);
        let has_mcp = agent_impl.mcp_target(scope, &root).is_some();
        if !has_content && !has_mcp {
            continue;
        }
        let mut axes = Vec::new();
        if has_content {
            axes.push(content_axis(agent_impl, scope, &root, store.as_ref()));
        }
        if has_mcp {
            axes.push(mcp_axis(agent_impl, scope, &root, store.as_ref()));
        }
        scopes.push(ScopeView {
            scope: scope_str(scope).to_string(),
            axes,
        });
    }

    Ok(AgentDetailView {
        agent: id.as_str().to_string(),
        display_name: agent_impl.display_name().to_string(),
        scopes,
    })
}

fn content_axis(
    agent: &dyn adapters::Agent,
    scope: Scope,
    root: &Path,
    store: Option<&Store>,
) -> AxisView {
    let mut axis = AxisView {
        axis: "content".to_string(),
        // Overwritten below unless the agent is read-only, where this *is* the
        // status: the convention is unconfirmed and nothing gets written.
        status: SyncStatus::Unconfirmed,
        location: agent.root(scope, root).map(|p| p.display().to_string()),
        read_only: agent.experimental_read_only(),
        kinds: agent
            .supported_kinds()
            .iter()
            .map(|&kind| KindCountView {
                kind: kind_str(kind).to_string(),
                // Still counted when read-only: the user wants to see what is
                // there even though shaic will not touch it.
                on_disk: agent.discover_existing(kind, scope, root).len(),
            })
            .collect(),
        to_write: 0,
        to_delete: 0,
        error: None,
    };

    if axis.read_only {
        return axis;
    }

    match store {
        Some(store) => match materialize::plan_materialize(agent, store, scope, root) {
            Ok(plan) => {
                axis.status = plan_glyph(Ok(plan.is_empty()));
                axis.to_write = plan.changed_writes().count();
                axis.to_delete = plan.deletes.len();
            }
            Err(e) => {
                axis.status = SyncStatus::Error;
                axis.error = Some(e.to_string());
            }
        },
        None => {
            axis.status = SyncStatus::Error;
            axis.error = Some("store unavailable".to_string());
        }
    }

    axis
}

fn mcp_axis(
    agent: &dyn adapters::Agent,
    scope: Scope,
    root: &Path,
    store: Option<&Store>,
) -> AxisView {
    let mut axis = AxisView {
        axis: "mcp".to_string(),
        status: SyncStatus::Unconfirmed,
        location: agent
            .mcp_target(scope, root)
            .map(|target| target.path.display().to_string()),
        read_only: false,
        kinds: Vec::new(),
        to_write: 0,
        to_delete: 0,
        error: None,
    };

    match store {
        Some(store) => match materialize::plan_mcp(agent, store, scope, root) {
            Ok(plan) => {
                axis.status = plan_glyph(Ok(plan.is_empty()));
                axis.to_write = plan.changed_writes().count();
                axis.to_delete = plan.removals.len();
            }
            Err(e) => {
                axis.status = SyncStatus::Error;
                axis.error = Some(e.to_string());
            }
        },
        None => {
            axis.status = SyncStatus::Error;
            axis.error = Some("store unavailable".to_string());
        }
    }

    axis
}

// ---------------------------------------------------------------------------
// Diff preview / apply
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeLineView {
    /// "create" | "update" | "delete" | "remove"
    pub action: String,
    pub target: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub agent: String,
    pub scope: String,
    pub is_mcp: bool,
    pub changes: Vec<ChangeLineView>,
    pub skipped: Vec<String>,
    pub warnings: Vec<String>,
    pub is_empty: bool,
}

fn action_label(action: WriteAction) -> &'static str {
    match action {
        WriteAction::Create => "create",
        WriteAction::Update => "update",
        WriteAction::NoOp => "noop",
    }
}

/// Compute what `sync` would change for one agent+scope without writing —
/// the TUI diff-preview screen.
#[tauri::command]
pub fn shaic_plan(agent: String, scope: String, is_mcp: bool) -> Result<PlanView, String> {
    let id = parse_agent(&agent)?;
    let scope = parse_scope(&scope)?;
    let agent_impl = adapters::by_id(id);
    let store = open_store()?;
    let root = project_root();
    register_project_if_needed(scope, &root)?;

    let (changes, skipped, warnings, is_empty) = if is_mcp {
        let plan = materialize::plan_mcp(agent_impl, &store, scope, &root)
            .map_err(|e| format!("could not compute plan: {e}"))?;
        let changes = plan
            .changed_writes()
            .map(|w| ChangeLineView {
                action: action_label(w.action).to_string(),
                target: if w.summary.is_empty() {
                    w.name.clone()
                } else {
                    format!("{} ({})", w.name, w.summary)
                },
            })
            .chain(plan.removals.iter().map(|n| ChangeLineView {
                action: "remove".to_string(),
                target: n.clone(),
            }))
            .collect();
        (changes, plan.skipped.clone(), plan.warnings.clone(), plan.is_empty())
    } else {
        let plan = materialize::plan_materialize(agent_impl, &store, scope, &root)
            .map_err(|e| format!("could not compute plan: {e}"))?;
        let changes = plan
            .changed_writes()
            .map(|w| ChangeLineView {
                action: action_label(w.action).to_string(),
                target: w.relative_path.display().to_string(),
            })
            .chain(plan.deletes.iter().map(|d| ChangeLineView {
                action: "delete".to_string(),
                target: d.relative_path.display().to_string(),
            }))
            .collect();
        (changes, plan.skipped.clone(), plan.warnings.clone(), plan.is_empty())
    };

    Ok(PlanView {
        agent: id.as_str().to_string(),
        scope: scope_str(scope).to_string(),
        is_mcp,
        changes,
        skipped,
        warnings,
        is_empty,
    })
}

/// Apply the plan for one agent+scope, re-planned from the store as the TUI
/// does (the store is the source of truth; import is a separate action).
#[tauri::command]
pub fn shaic_apply(agent: String, scope: String, is_mcp: bool) -> Result<OpResult, String> {
    let id = parse_agent(&agent)?;
    // The only path that writes into an agent's files. A switched-off agent must
    // never be reached through it, even if a stale UI still offered the action.
    if !agent_enabled(id) {
        return Err(format!(
            "{agent} is switched off in Settings → AI config sync"
        ));
    }
    let scope = parse_scope(&scope)?;
    let agent_impl = adapters::by_id(id);
    let store = open_store()?;
    let root = project_root();
    register_project_if_needed(scope, &root)?;

    let result = if is_mcp {
        let plan = materialize::plan_mcp(agent_impl, &store, scope, &root)
            .map_err(|e| format!("apply failed: {e}"))?;
        materialize::apply_mcp(agent_impl, &store, &plan, scope, &root)
            .map(|r| (r.applied, r.warnings))
            .map_err(|e| format!("apply failed: {e}"))
    } else {
        let plan = materialize::plan_materialize(agent_impl, &store, scope, &root)
            .map_err(|e| format!("apply failed: {e}"))?;
        materialize::apply(agent_impl, &plan, scope, &root)
            .map(|r| {
                let changed = r
                    .writes
                    .iter()
                    .filter(|w| w.action != WriteAction::NoOp)
                    .count();
                (changed, r.warnings)
            })
            .map_err(|e| format!("apply failed: {e}"))
    };

    match result {
        Ok((changed, warnings)) => {
            let kind = if warnings.is_empty() {
                MessageKind::Success
            } else {
                MessageKind::Warning
            };
            let suffix = if warnings.is_empty() {
                String::new()
            } else {
                format!(" — {}", warnings.join("; "))
            };
            Ok(OpResult {
                text: format!("applied {changed} change(s){suffix}"),
                kind,
                force_required: false,
            })
        }
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Import (agent files → store)
// ---------------------------------------------------------------------------

/// Pull a single agent+scope's on-disk files into the store — the TUI agent
/// detail's `o`.
#[tauri::command]
pub fn shaic_import_scope(agent: String, scope: String) -> Result<OpResult, String> {
    let id = parse_agent(&agent)?;
    let scope = parse_scope(&scope)?;
    let agent_impl = adapters::by_id(id);
    let store = open_store()?;
    let root = project_root();

    let summary = operations::import_scope(agent_impl, &store, scope, &root, false);
    let (msg, op_kind) = summary.message();
    let mut full = msg;
    if !summary.warnings.is_empty() {
        full.push_str(&format!(" — warnings: {}", summary.warnings.join("; ")));
    }
    if !summary.errors.is_empty() {
        full.push_str(&format!(" — errors: {}", summary.errors.join("; ")));
    }
    Ok(OpResult {
        text: full,
        kind: op_kind.into(),
        force_required: false,
    })
}

// ---------------------------------------------------------------------------
// Item browser
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    pub kind: String,
    pub name: String,
    pub description: String,
    pub scope: Vec<String>,
    pub agents: Vec<String>,
    pub tags: Vec<String>,
    pub applies_to: Vec<String>,
}

fn item_view(item: &Item) -> ItemView {
    let fm = &item.frontmatter;
    ItemView {
        kind: kind_str(item.kind).to_string(),
        name: fm.name.clone(),
        description: fm.description.clone(),
        scope: fm.scope.iter().map(|s| scope_str(*s).to_string()).collect(),
        agents: fm.agents.iter().map(|a| a.as_str().to_string()).collect(),
        tags: fm.tags.clone(),
        applies_to: fm.applies_to.clone(),
    }
}

/// List items of one kind, or every kind when `kind` is omitted. Corrupt item
/// files come back as `warnings` rather than failing the whole listing —
/// same contract as the TUI browser.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemListView {
    pub items: Vec<ItemView>,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub fn shaic_list_items(kind: Option<String>) -> Result<ItemListView, String> {
    let store = open_store()?;
    let kinds: Vec<ItemKind> = match kind {
        Some(k) => vec![parse_kind(&k)?],
        None => ItemKind::ALL.to_vec(),
    };
    let mut items = Vec::new();
    let mut warnings = Vec::new();
    for k in kinds {
        let (listed, skipped) = store.list_items_with_skips(k).map_err(|e| e.to_string())?;
        items.extend(listed.iter().map(item_view));
        warnings.extend(skipped.into_iter().map(|(_, msg)| msg));
    }
    Ok(ItemListView { items, warnings })
}

/// The starter text for a new item, as `$EDITOR` would open it — the UI loads
/// this into its editor.
#[tauri::command]
pub fn shaic_item_template(kind: String, name: String) -> Result<String, String> {
    let kind = parse_kind(&kind)?;
    shaic_core::model::validate_name(&name).map_err(|e| e.to_string())?;
    Ok(store::item_template(kind, &name))
}

/// The edit-time text for an existing item (frontmatter + body round-trip).
#[tauri::command]
pub fn shaic_item_source(kind: String, name: String) -> Result<String, String> {
    let kind = parse_kind(&kind)?;
    let store = open_store()?;
    let item = store
        .load_item(kind, &name)
        .map_err(|e| format!("load failed: {e}"))?;
    Ok(store::render_for_edit(&item))
}

/// Parse editor output and save it into the store. When `expected_name` is
/// given, a rename via edit is refused — matching the TUI.
#[tauri::command]
pub fn shaic_save_item(
    kind: String,
    source: String,
    expected_name: Option<String>,
) -> Result<OpResult, String> {
    let kind = parse_kind(&kind)?;
    let store = open_store()?;
    let item = store::parse_item(kind, &source).map_err(|e| format!("save failed: {e}"))?;
    let is_update = expected_name.is_some();
    if let Some(expected) = expected_name {
        if item.name() != expected {
            return Err(format!(
                "renaming via edit is not supported — keep name {expected:?}"
            ));
        }
    }
    store
        .save_item(&item)
        .map_err(|e| format!("save failed: {e}"))?;
    Ok(OpResult {
        text: format!(
            "{} {kind:?} {:?}",
            if is_update { "updated" } else { "added" },
            item.name()
        ),
        kind: MessageKind::Success,
        force_required: false,
    })
}

/// Remove an item, then materialize every agent immediately — the TUI does
/// the same so a deleted item doesn't linger on disk.
#[tauri::command]
pub fn shaic_remove_item(kind: String, name: String) -> Result<OpResult, String> {
    let kind = parse_kind(&kind)?;
    let store = open_store()?;
    store
        .remove_item(kind, &name)
        .map_err(|e| format!("remove failed: {e}"))?;
    let (applied, notes) =
        materialize::push_all_now_filtered(&store, &project_root(), &enabled_agent_ids());
    if let Some(note) = notes.first() {
        Ok(OpResult {
            text: format!("removed {kind:?} {name:?}, but: {note}"),
            kind: MessageKind::Warning,
            force_required: false,
        })
    } else {
        Ok(OpResult {
            text: format!("removed {kind:?} {name:?}, pushed to {applied} agent/scope(s)"),
            kind: MessageKind::Success,
            force_required: false,
        })
    }
}
