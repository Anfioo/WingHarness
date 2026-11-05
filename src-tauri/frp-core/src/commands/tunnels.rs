//! Tunnel commands: argument checks and workspace access only.
//!
//! The six-type validation and the profile revision bump live in
//! [`crate::tunnels`].

use crate::error::{FrpError, FrpResult};
use crate::models::{Tunnel, TunnelInput, TunnelView};
use crate::state::FrpState;
use crate::store;
use crate::tunnels;

fn require_id(id: &str) -> FrpResult<&str> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(FrpError::invalid_input("id", "A tunnel id is required."));
    }
    Ok(trimmed)
}

pub(crate) async fn list(
    state: &FrpState,
    profile_id: Option<&str>,
) -> FrpResult<Vec<TunnelView>> {
    let workspace = store::current(state)?;
    Ok(tunnels::list(&workspace, profile_id))
}

pub(crate) async fn create(state: &FrpState, input: TunnelInput) -> FrpResult<Tunnel> {
    store::update(state, |workspace| tunnels::create(workspace, &input))
}

pub(crate) async fn update(
    state: &FrpState,
    id: &str,
    input: TunnelInput,
) -> FrpResult<Tunnel> {
    let id = require_id(id)?;
    store::update(state, |workspace| tunnels::update(workspace, id, &input))
}

pub(crate) async fn delete(state: &FrpState, id: &str) -> FrpResult<()> {
    let id = require_id(id)?;
    store::update(state, |workspace| tunnels::delete(workspace, id))
}
