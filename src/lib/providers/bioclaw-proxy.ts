// BioClaw-proxy provider.
//
// The desktop app does NOT ship an OpenRouter key. Users authenticate with
// their BioClaw email (existing /api/auth/send-otp + /api/auth/verify-otp
// flow) and we route chat completions through our SaaS, which appends the
// server-side OpenRouter key and pipes the SSE response back unchanged.
//
// Wire shape (defined by SaaS /api/desktop/chat/completions):
//   * Endpoint:  https://chat.bioclaw.tech/api/desktop/chat/completions
//   * Auth:      Cookie: bioclaw_session=<token>
//   * Request:   OpenAI-compatible {messages, model, tools, ...}
//   * Response:  OpenAI-style SSE — same chunks OpenRouter emits
//
// The path component intentionally ends in `/chat/completions` so the
// existing openai-compatible provider — which appends that suffix —
// produces the right final URL when we hand it `<base>/api/desktop` as
// the endpoint. Same body shape; we only change auth (cookie instead of
// bearer) and the base URL.

import type { Provider, ProviderEvent, ProviderStreamRequest } from './index';
import { getProvider, registerProvider } from './index';
import type { ProviderId } from '../agent/types';

const DEFAULT_SAAS_BASE_URL = 'https://chat.bioclaw.tech';

class BioClawProxyProvider implements Provider {
  readonly id: ProviderId = 'bioclaw-proxy';

  async *streamMessages(req: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    const explicit = req.model.endpoint;
    const base = (explicit && explicit.length > 0 ? explicit : DEFAULT_SAAS_BASE_URL).replace(
      /\/+$/,
      '',
    );
    const patched: ProviderStreamRequest = {
      ...req,
      model: {
        ...req.model,
        // The openai-compatible provider appends `/chat/completions`, so
        // we hand it `<base>/api/desktop` and the call lands on the SaaS
        // route `<base>/api/desktop/chat/completions`.
        endpoint: `${base}/api/desktop`,
        auth: {
          kind: 'cookie',
          ...(req.model.auth?.apiKey ? { apiKey: req.model.auth.apiKey } : {}),
          cookieName: req.model.auth?.cookieName ?? 'bioclaw_session',
          ...(req.model.auth?.headers ? { headers: req.model.auth.headers } : {}),
        },
      },
    };
    const compat = getProvider('openai-compatible');
    yield* compat.streamMessages(patched);
  }
}

registerProvider(new BioClawProxyProvider());
