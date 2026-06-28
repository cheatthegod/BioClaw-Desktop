//! Permission decisions for the script-runner tool.
//!
//! Two kinds of state coexist (mirroring the Node sidecar's
//! `scriptRunner.ts`, plus persistence):
//! 1. Pending requests — keyed by request-id, each maps to a
//!    `oneshot::Sender<PermissionDecision>` the chat loop is awaiting.
//!    Lives in an `Arc<DashMap>` shared via AppState. The chat handler
//!    emits a `permission-needed` SSE event when a tool call needs a
//!    decision; the frontend modal POSTs to `/permissions/decide`
//!    which resolves the oneshot.
//! 2. Allow-always cache — `<skill_id, script>` pairs the user has
//!    pre-approved. Stored in `<project_dir>/permissions.json`,
//!    loaded at sidecar startup so prior decisions survive restarts
//!    (the Node port was in-memory only and required a `preload`
//!    round-trip on every chat start). The frontend may still call
//!    `/permissions/preload` to overwrite the cache after editing
//!    decisions in Settings; preload writes through to disk.

pub mod routes;
pub mod store;
pub mod types;

pub use store::PermissionStore;
pub use types::{PermissionDecision, PermissionKey};
