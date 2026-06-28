//! Route handlers — one module per logical group.
//!
//! At this scaffolding stage we only have `health`. Subsequent
//! sub-stages add:
//!   * `skills`        — GET /skills (catalog)
//!   * `env`           — GET /env/state, POST /env/setup (SSE)
//!   * `chat`          — POST /chat (SSE, bounded tool loop)
//!   * `permissions`   — POST /permissions/decide, /preload
//!   * `auth`          — POST /auth/device-code, /poll (device-code OAuth)

pub mod chat;
pub mod env;
pub mod health;
pub mod skills;
