//! Device-code client. Talks to the SaaS endpoints added in the
//! companion BioClaw-SaaS commit.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

const DEFAULT_SAAS_BASE_URL: &str = "https://chat.bioclaw.tech";
const CLIENT_NAME_FALLBACK: &str = "BioClaw Desktop";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum PollResponse {
    /// Token freshly minted. Returned exactly once per device-code.
    /// Inner fields are camelCase to match the renderer's TS shape;
    /// the outer kebab-case rename_all only governs the `status`
    /// discriminator + variant names.
    Ready {
        #[serde(rename = "sessionToken")]
        session_token: String,
        email: String,
        exp: u64,
        #[serde(rename = "clientName")]
        client_name: String,
    },
    /// Keep polling at the indicated interval (default 5s).
    Pending,
    /// Server-side rate limit — the client should back off.
    SlowDown,
    /// Code expired or never existed.
    Expired,
    /// User explicitly denied. Restart the flow to retry.
    Denied,
}

#[derive(Debug, Deserialize)]
struct SaasStartResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct SaasPollOk {
    session_token: String,
    email: String,
    exp: u64,
    client_name: String,
}

#[derive(Debug, Deserialize)]
struct SaasPollErr {
    error: String,
}

#[derive(Debug, Clone)]
pub struct Client {
    base_url: String,
    http: reqwest::Client,
}

impl Client {
    pub fn new(base_url: Option<&str>) -> Result<Self> {
        let base_url = base_url
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_SAAS_BASE_URL)
            .trim_end_matches('/')
            .to_string();
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .context("build reqwest client")?;
        Ok(Self { base_url, http })
    }

    /// Kick off a device-code flow. Returns the user_code to show
    /// the user and the device_code the caller polls with.
    pub async fn start(&self, client_name: Option<&str>) -> Result<StartResponse> {
        let url = format!("{}/api/auth/cli-device-code", self.base_url);
        let body = serde_json::json!({
            "client_name": client_name.unwrap_or(CLIENT_NAME_FALLBACK),
        });
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow!("upstream {status}: {text}"));
        }
        let parsed: SaasStartResponse = resp
            .json()
            .await
            .context("decode cli-device-code response")?;
        Ok(StartResponse {
            device_code: parsed.device_code,
            user_code: parsed.user_code,
            verification_uri: parsed.verification_uri,
            verification_uri_complete: parsed.verification_uri_complete,
            expires_in: parsed.expires_in,
            interval: parsed.interval,
        })
    }

    /// Single poll. Caller is responsible for the interval / retry
    /// loop (we don't sleep here — the route handler returns one poll
    /// per HTTP request so the renderer keeps control of the timing).
    pub async fn poll(&self, device_code: &str) -> Result<PollResponse> {
        let url = format!("{}/api/auth/cli-poll", self.base_url);
        let body = serde_json::json!({ "device_code": device_code });
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        let status = resp.status();
        if status.is_success() {
            let ok: SaasPollOk = resp.json().await.context("decode cli-poll ok")?;
            return Ok(PollResponse::Ready {
                session_token: ok.session_token,
                email: ok.email,
                exp: ok.exp,
                client_name: ok.client_name,
            });
        }
        // RFC 8628 errors come back as 400 with `{"error": "<code>"}`.
        if status == reqwest::StatusCode::BAD_REQUEST {
            let err: SaasPollErr = resp.json().await.context("decode cli-poll error")?;
            return Ok(map_poll_error(&err.error));
        }
        let text = resp.text().await.unwrap_or_default();
        Err(anyhow!("unexpected upstream {status}: {text}"))
    }
}

fn map_poll_error(code: &str) -> PollResponse {
    match code {
        "authorization_pending" => PollResponse::Pending,
        "slow_down" => PollResponse::SlowDown,
        "expired_token" => PollResponse::Expired,
        "access_denied" => PollResponse::Denied,
        // RFC 8628 also defines `invalid_grant`/`invalid_request`. We
        // surface those as Expired so the UI prompts the user to
        // restart the flow rather than retry endlessly.
        _ => PollResponse::Expired,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_rfc_error_codes() {
        assert!(matches!(
            map_poll_error("authorization_pending"),
            PollResponse::Pending
        ));
        assert!(matches!(
            map_poll_error("slow_down"),
            PollResponse::SlowDown
        ));
        assert!(matches!(
            map_poll_error("expired_token"),
            PollResponse::Expired
        ));
        assert!(matches!(
            map_poll_error("access_denied"),
            PollResponse::Denied
        ));
        assert!(matches!(
            map_poll_error("invalid_grant"),
            PollResponse::Expired
        ));
    }

    #[test]
    fn start_response_camel_case_for_renderer() {
        let r = StartResponse {
            device_code: "d".into(),
            user_code: "BCLW-AAAA".into(),
            verification_uri: "https://x/device".into(),
            verification_uri_complete: "https://x/device?u=1".into(),
            expires_in: 900,
            interval: 5,
        };
        let v = serde_json::to_value(&r).unwrap();
        // Renderer expects camelCase keys; verify a few.
        assert!(v.get("deviceCode").is_some());
        assert!(v.get("userCode").is_some());
        assert!(v.get("verificationUriComplete").is_some());
        assert!(v.get("expiresIn").is_some());
    }

    #[test]
    fn poll_response_kebab_case_status_field() {
        let r = PollResponse::Pending;
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v.get("status").and_then(|x| x.as_str()), Some("pending"));
        let r = PollResponse::SlowDown;
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v.get("status").and_then(|x| x.as_str()), Some("slow-down"));
    }
}
