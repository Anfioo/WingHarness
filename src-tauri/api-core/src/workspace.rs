//! Workspace / collection / request tree CRUD with optimistic-concurrency
//! revisions.
//!
//! Layout under [`crate::store::dir`]:
//! - `workspaces.json`  — the `Vec<WorkspaceMeta>` index (list view).
//! - `<id>.json`        — one [`WorkspaceTree`] per workspace.
//!
//! Every save is guarded by an optional `expected_revision`: a mismatch means
//! another window wrote first, and the caller must reload before retrying.

use chrono::Utc;

use crate::error::{AppError, AppResult};
use crate::models::{
    CollectionNode, Environment, ImportApplied, ImportOptions, ImportResult, KeyValue,
    WorkspaceMeta, WorkspaceTree,
};
use crate::paths::{sanitize_name, workspace_file};
use crate::store;

/// The index file name inside the data directory.
const INDEX: &str = "workspaces.json";

/// Name of the environment every workspace starts with.
const DEFAULT_ENVIRONMENT: &str = "Default";

/// Variable the request URLs are resolved against (see the frontend's `resolveUrl`).
const BASE_URL_VARIABLE: &str = "baseUrl";

/// A fresh `Default` environment holding an empty `baseUrl` row.
fn default_environment() -> Environment {
    Environment {
        id: uuid::Uuid::new_v4().to_string(),
        name: DEFAULT_ENVIRONMENT.to_string(),
        variables: vec![KeyValue {
            key: BASE_URL_VARIABLE.to_string(),
            value: String::new(),
            enabled: true,
        }],
    }
}

/// Ensure a `Default` environment exists and return its index.
fn ensure_default_environment(environments: &mut Vec<Environment>) -> usize {
    if let Some(index) = environments
        .iter()
        .position(|env| env.name == DEFAULT_ENVIRONMENT)
    {
        return index;
    }
    environments.push(default_environment());
    environments.len() - 1
}

/// Write `base_url` into the default environment, keeping every other variable
/// untouched. Used by imports so an imported collection is immediately sendable.
fn set_base_url(environments: &mut Vec<Environment>, base_url: &str) {
    let index = ensure_default_environment(environments);
    let environment = &mut environments[index];
    match environment
        .variables
        .iter_mut()
        .find(|row| row.key == BASE_URL_VARIABLE)
    {
        Some(row) => {
            row.value = base_url.to_string();
            row.enabled = true;
        }
        None => environment.variables.push(KeyValue {
            key: BASE_URL_VARIABLE.to_string(),
            value: base_url.to_string(),
            enabled: true,
        }),
    }
}

/// Read the workspace index, treating a missing file as an empty list.
fn read_index() -> AppResult<Vec<WorkspaceMeta>> {
    Ok(store::read_json::<Vec<WorkspaceMeta>>(INDEX)?.unwrap_or_default())
}

fn write_index(index: &[WorkspaceMeta]) -> AppResult<()> {
    store::write_json(INDEX, &index)
}

/// Recursively count `(collections, requests)` under a set of nodes.
fn counts(nodes: &[CollectionNode]) -> (u64, u64) {
    let mut collections = 0u64;
    let mut requests = 0u64;
    for node in nodes {
        collections += 1;
        requests += node.requests.len() as u64;
        let (child_collections, child_requests) = counts(&node.children);
        collections += child_collections;
        requests += child_requests;
    }
    (collections, requests)
}

/// Refresh a meta row (name + counts + timestamp) from a tree.
fn meta_from(tree: &WorkspaceTree) -> WorkspaceMeta {
    let (collection_count, request_count) = counts(&tree.collections);
    WorkspaceMeta {
        id: tree.id.clone(),
        name: tree.name.clone(),
        collection_count,
        request_count,
        updated_at: tree.updated_at,
    }
}

/// All workspaces, in insertion order.
pub fn list() -> AppResult<Vec<WorkspaceMeta>> {
    read_index()
}

/// Create a new, empty workspace (`revision` 0) and return its meta row.
pub fn create(name: &str) -> AppResult<WorkspaceMeta> {
    let name = sanitize_name(name)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now();
    let tree = WorkspaceTree {
        id: id.clone(),
        name: name.clone(),
        revision: 0,
        collections: Vec::new(),
        environments: vec![default_environment()],
        updated_at: now,
    };
    store::write_json(&workspace_file(&id)?, &tree)?;

    let mut index = read_index()?;
    let meta = WorkspaceMeta {
        id,
        name,
        collection_count: 0,
        request_count: 0,
        updated_at: now,
    };
    index.push(meta.clone());
    write_index(&index)?;
    Ok(meta)
}

/// Rename a workspace. Touches neither the tree's revision nor its counts.
pub fn rename(id: &str, name: &str) -> AppResult<WorkspaceMeta> {
    let name = sanitize_name(name)?;
    let file = workspace_file(id)?;
    let mut tree = store::read_json::<WorkspaceTree>(&file)?
        .ok_or_else(|| AppError::NotFound(format!("workspace {id}")))?;
    tree.name = name.clone();
    tree.updated_at = Utc::now();
    store::write_json(&file, &tree)?;

    let mut index = read_index()?;
    let meta = index
        .iter_mut()
        .find(|meta| meta.id == id)
        .ok_or_else(|| AppError::NotFound(format!("workspace {id}")))?;
    meta.name = name;
    meta.updated_at = tree.updated_at;
    let meta = meta.clone();
    write_index(&index)?;
    Ok(meta)
}

/// Delete a workspace and its tree. Missing workspaces are a `NotFound` error.
pub fn delete(id: &str) -> AppResult<()> {
    let mut index = read_index()?;
    let before = index.len();
    index.retain(|meta| meta.id != id);
    if index.len() == before {
        return Err(AppError::NotFound(format!("workspace {id}")));
    }
    write_index(&index)?;
    store::remove_file(&workspace_file(id)?)?;
    Ok(())
}

/// Load a workspace tree. Workspaces written before environments existed get a
/// `Default` environment backfilled in memory; the next save persists it.
pub fn load(id: &str) -> AppResult<WorkspaceTree> {
    let mut tree = store::read_json::<WorkspaceTree>(&workspace_file(id)?)?
        .ok_or_else(|| AppError::NotFound(format!("workspace {id}")))?;
    ensure_default_environment(&mut tree.environments);
    Ok(tree)
}

/// Persist a workspace tree and return the new revision.
///
/// When `expected_revision` is `Some(n)` and the stored revision is not `n`, the
/// save is rejected with [`AppError::Conflict`]. On success the revision is
/// bumped, `updatedAt` refreshed, and the index row re-synced.
pub fn save(id: &str, tree: &WorkspaceTree, expected_revision: Option<u64>) -> AppResult<u64> {
    let file = workspace_file(id)?;
    let current = store::read_json::<WorkspaceTree>(&file)?
        .ok_or_else(|| AppError::NotFound(format!("workspace {id}")))?;
    check_revision(&current, expected_revision)?;

    let revision = current.revision + 1;
    let updated_at = Utc::now();
    let next = WorkspaceTree {
        id: id.to_string(),
        name: if tree.name.is_empty() {
            current.name.clone()
        } else {
            tree.name.clone()
        },
        revision,
        collections: tree.collections.clone(),
        environments: tree.environments.clone(),
        updated_at,
    };
    store::write_json(&file, &next)?;

    let mut index = read_index()?;
    let row = index
        .iter_mut()
        .find(|meta| meta.id == id)
        .ok_or_else(|| AppError::NotFound(format!("workspace {id}")))?;
    *row = meta_from(&next);
    write_index(&index)?;
    Ok(revision)
}

/// Merge an import's collections into a workspace, honouring `namePrefix` on the
/// top-level collection names, and return the new revision plus how many requests
/// were added. Revisions follow the same optimistic-concurrency rule as [`save`].
pub fn apply_import(
    id: &str,
    result: ImportResult,
    options: ImportOptions,
    expected_revision: Option<u64>,
) -> AppResult<ImportApplied> {
    let file = workspace_file(id)?;
    let current = store::read_json::<WorkspaceTree>(&file)?
        .ok_or_else(|| AppError::NotFound(format!("workspace {id}")))?;
    check_revision(&current, expected_revision)?;

    let mut imported = result.collections;
    if !options.name_prefix.is_empty() {
        for collection in &mut imported {
            collection.name = format!("{}{}", options.name_prefix, collection.name);
        }
    }
    let added = counts(&imported).1;

    let revision = current.revision + 1;
    let updated_at = Utc::now();
    let mut collections = current.collections;
    collections.extend(imported);
    let mut environments = current.environments;
    let base_url = options.base_url.trim();
    if base_url.is_empty() {
        ensure_default_environment(&mut environments);
    } else {
        set_base_url(&mut environments, base_url);
    }
    let next = WorkspaceTree {
        id: id.to_string(),
        name: current.name,
        revision,
        collections,
        environments,
        updated_at,
    };
    store::write_json(&file, &next)?;

    let mut index = read_index()?;
    let row = index
        .iter_mut()
        .find(|meta| meta.id == id)
        .ok_or_else(|| AppError::NotFound(format!("workspace {id}")))?;
    *row = meta_from(&next);
    write_index(&index)?;
    Ok(ImportApplied { revision, added })
}

fn check_revision(current: &WorkspaceTree, expected: Option<u64>) -> AppResult<()> {
    match expected {
        Some(expected) if expected != current.revision => Err(AppError::Conflict),
        _ => Ok(()),
    }
}
