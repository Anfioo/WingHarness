pub mod cancel;
pub mod commands;
pub mod error;
pub mod models;
pub mod paths;
pub mod send;
pub mod store;
pub mod workspace;

pub use error::{AppError, AppResult};

/// Re-exports for the integration tests, mirroring `git-core`'s own `test_api`.
pub mod test_api {
    pub use crate::cancel::{cancel, register, CancelToken};
    pub use crate::models::{
        Auth, AuthKind, BodyKind, CollectionNode, Environment, HttpResponse, ImportApplied,
        ImportOptions, ImportResult, KeyValue, RequestBody, RequestDef, SendRequest, TextFile,
        WorkspaceMeta, WorkspaceTree,
    };
    pub use crate::send::send;
    pub use crate::store::CONFIG_DIR;
    pub use crate::workspace::{apply_import, create, delete, list, load, rename, save};
}
