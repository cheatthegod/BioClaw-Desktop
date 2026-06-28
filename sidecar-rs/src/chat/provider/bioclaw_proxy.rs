//! BioClaw-proxy provider — what the desktop UI uses out of the box.
//!
//! The desktop app does NOT ship an OpenRouter / Anthropic key. Users
//! sign in with their BioClaw account, and chat completions are routed
//! through `chat.bioclaw.tech/api/desktop/chat/completions`, which
//! appends the server-side OpenRouter key and pipes the SSE response
//! back unchanged. Wire format is OpenAI-compatible by design — the
//! actual stream parsing is done by `openai_compat`; this module just
//! rewrites the endpoint + swaps bearer auth for the `bioclaw_session`
//! cookie.
//!
//! Mirrors `src/lib/providers/bioclaw-proxy.ts` (~50 lines TS,
//! similarly thin here).

use anyhow::Result;

use super::openai_compat::OpenAiCompat;
use super::{Provider, ProviderStream, ProviderStreamRequest};
use crate::chat::types::Auth;

const DEFAULT_SAAS_BASE_URL: &str = "https://chat.bioclaw.tech";

pub struct BioClawProxy;

impl Provider for BioClawProxy {
    fn id(&self) -> &'static str {
        "bioclaw-proxy"
    }

    async fn stream_messages(&self, mut req: ProviderStreamRequest) -> Result<ProviderStream> {
        // The openai-compatible client appends `/chat/completions` to
        // the endpoint we give it, so we hand it `<base>/api/desktop`
        // and the final URL is `<base>/api/desktop/chat/completions`.
        let base = req
            .model
            .endpoint
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_SAAS_BASE_URL)
            .trim_end_matches('/')
            .to_string();
        req.model.endpoint = Some(format!("{base}/api/desktop"));

        // Promote whatever auth we have to a cookie if it isn't already
        // — the SaaS endpoint authenticates session-style.
        req.model.auth = match req.model.auth {
            Auth::Cookie { cookie_name, token } => Auth::Cookie { cookie_name, token },
            Auth::Bearer { api_key } => Auth::Cookie {
                cookie_name: "bioclaw_session".into(),
                token: api_key,
            },
            Auth::None => Auth::None,
        };

        OpenAiCompat.stream_messages(req).await
    }
}
