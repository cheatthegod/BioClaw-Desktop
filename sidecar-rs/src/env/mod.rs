//! Bundled Python env management.
//!
//! Mirrors the Node sidecar's `src/env/` namespace:
//! - `paths` — cross-platform path resolution (project dir,
//!   venv interpreter, bundled zip locations).
//! - `state` — composite state machine (needs-setup / installing /
//!   ready / broken) + module-level install bookkeeping for the
//!   inline-banner progress.
//! - `setup` — orchestrates extract-zip + `uv sync` (offline fast
//!   path) or `uv python install` + `uv sync` (online fallback for
//!   the `--extras` workflow).
//!
//! The setup driver emits a typed event stream (`SetupEvent`) that
//! the `/env/setup` SSE handler relays to the frontend banner.

pub mod paths;
pub mod setup;
pub mod state;
