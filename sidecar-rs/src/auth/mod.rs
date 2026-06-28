//! Sidecar-side auth surface.
//!
//! L.7 ships the RFC 8628 device-authorization-grant client +
//! sidecar proxy routes so the renderer never talks to the SaaS
//! directly. Flow from the renderer's POV:
//!
//! 1. POST /auth/device-code/start — sidecar proxies to
//!    `<saas>/api/auth/cli-device-code`, relays back
//!    `{ user_code, verification_uri_complete, expires_in,
//!    interval, device_code }`.
//! 2. Renderer opens `verification_uri_complete` via Tauri shell
//!    and starts polling `/auth/device-code/poll` with the
//!    device_code (~5s interval).
//! 3. POST /auth/device-code/poll — sidecar wraps
//!    `<saas>/api/auth/cli-poll`. While the user hasn't approved
//!    yet, returns `{ status: "pending" }` so the renderer keeps
//!    polling. On approval, returns the session token (the L.8
//!    process_token) once and the renderer hands it to the OS
//!    keychain.

pub mod device_code;
pub mod routes;
