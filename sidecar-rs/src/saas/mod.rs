//! SaaS client + authenticated proxy.
//!
//! The desktop is a native client of the BioClaw SaaS. Rather than have the
//! renderer talk to `chat.bioclaw.tech` directly (CORS, and the session token
//! would live in the webview), the sidecar exposes:
//!
//!   * `POST /auth/session   { token }`  — hand the sidecar the device-code
//!     session token (the renderer pushes it after login + on boot from the
//!     OS keychain). Held in memory only.
//!   * `GET  /auth/session`              — `{ authenticated: bool }`.
//!   * `DELETE /auth/session`           — clear (logout).
//!   * `ANY  /saas/{*path}`             — forward to `<base>/api/{path}`,
//!     attaching `Cookie: bioclaw_session=<token>`, streaming the response
//!     through (so SSE endpoints like `/events` and `/gpu/jobs/<id>` work).
//!     Upstream 401 → `{ error: "auth", loginUrl }` so the UI can re-auth.
//!
//! This is the keystone: once it exists, every SaaS feature is a React panel
//! calling `http://127.0.0.1:<port>/saas/<path>`.

pub mod routes;

#[cfg(test)]
mod tests;

use std::sync::RwLock;

const COOKIE_NAME: &str = "bioclaw_session";
const DEFAULT_SAAS_BASE: &str = "https://chat.bioclaw.tech";

/// Shared SaaS client: the in-memory session token + the upstream base URL +
/// a reusable HTTP client. Held in `AppState` behind an `Arc`.
#[derive(Debug)]
pub struct SaasClient {
    token: RwLock<Option<String>>,
    base: String,
    http: reqwest::Client,
}

impl SaasClient {
    /// Resolve the SaaS base URL: `BIOCLAW_SAAS_BASE` override (used for
    /// staging / `http://127.0.0.1:3000` in tests) else the production host.
    pub fn new() -> Self {
        let base = std::env::var("BIOCLAW_SAAS_BASE")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_SAAS_BASE.to_string())
            .trim_end_matches('/')
            .to_string();
        let http = reqwest::Client::builder()
            // No global timeout — SSE endpoints stream indefinitely. Per-request
            // timeouts are applied where appropriate by callers.
            .pool_idle_timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_default();
        Self {
            token: RwLock::new(None),
            base,
            http,
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn set_token(&self, token: String) {
        *self.token.write().expect("session token poisoned") = Some(token);
    }

    pub fn clear_token(&self) {
        *self.token.write().expect("session token poisoned") = None;
    }

    pub fn token(&self) -> Option<String> {
        self.token.read().expect("session token poisoned").clone()
    }

    pub fn is_authenticated(&self) -> bool {
        self.token
            .read()
            .expect("session token poisoned")
            .as_deref()
            .map(|t| !t.is_empty())
            .unwrap_or(false)
    }

    /// The `Cookie` header value to attach to proxied requests, if a token
    /// is set.
    pub fn cookie_header(&self) -> Option<String> {
        self.token().map(|t| format!("{COOKIE_NAME}={t}"))
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }
}

impl Default for SaasClient {
    fn default() -> Self {
        Self::new()
    }
}
