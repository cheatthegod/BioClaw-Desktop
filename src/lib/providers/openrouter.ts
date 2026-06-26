// Adapted from sst/opencode (Apache-2.0). See docs/VENDORED.md for the diff.
//
// Original source: packages/opencode/src/session/llm/native-request.ts
// (the `OpenRouter` provider branch). OpenRouter is *almost* OpenAI-compatible:
// same endpoint shape, but two custom request headers (`HTTP-Referer` and
// `X-Title`) drive their app attribution + free-tier eligibility, and the
// base URL is `https://openrouter.ai/api/v1`.

import type { Provider, ProviderEvent, ProviderStreamRequest } from './index';
import { getProvider, registerProvider } from './index';
import type { ProviderId } from '../agent/types';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_REFERER = 'https://chat.bioclaw.tech';
const OPENROUTER_TITLE = 'BioClaw Desktop';

class OpenRouterProvider implements Provider {
  readonly id: ProviderId = 'openrouter';

  async *streamMessages(req: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    // Reuse the openai-compatible provider's wire impl, with our headers + URL
    // patched into the model spec. We don't mutate the caller's spec.
    const headers = {
      ...(req.model.auth?.headers ?? {}),
      'HTTP-Referer': req.model.auth?.headers?.['HTTP-Referer'] ?? OPENROUTER_REFERER,
      'X-Title': req.model.auth?.headers?.['X-Title'] ?? OPENROUTER_TITLE,
    };
    const patched: ProviderStreamRequest = {
      ...req,
      model: {
        ...req.model,
        endpoint: req.model.endpoint ?? OPENROUTER_BASE_URL,
        auth: {
          kind: req.model.auth?.kind ?? 'bearer',
          ...(req.model.auth?.apiKey !== undefined ? { apiKey: req.model.auth.apiKey } : {}),
          headers,
        },
      },
    };
    const compat = getProvider('openai-compatible');
    yield* compat.streamMessages(patched);
  }
}

// Self-register at import time. Consumers just `import './openrouter'` once
// at app boot and then `getProvider('openrouter')` works everywhere.
registerProvider(new OpenRouterProvider());
