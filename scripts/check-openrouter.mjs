#!/usr/bin/env node
import 'dotenv/config';

function fail(message, details) {
  console.error(message);
  if (details) console.error(details);
  process.exit(1);
}

const apiKey = process.env.OPENROUTER_API_KEY;
const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const model = process.env.OPENROUTER_MODEL || 'openai/gpt-5.4';

if (!apiKey) {
  fail('Missing OPENROUTER_API_KEY in environment or .env');
}

async function main() {
  console.log(`Checking OpenRouter model: ${model}`);
  console.log(`Base URL: ${baseUrl}`);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'user', content: 'Reply with exactly: OPENROUTER_OK' },
      ],
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    fail(`OpenRouter request failed: ${message}`, JSON.stringify(payload, null, 2));
  }

  const text = payload?.choices?.[0]?.message?.content;
  console.log('OpenRouter request succeeded.');
  if (typeof text === 'string') {
    console.log(`Reply: ${text}`);
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
}

main().catch((err) => {
  fail(
    `OpenRouter check crashed: ${err instanceof Error ? err.message : String(err)}`,
    err instanceof Error ? err.stack : undefined,
  );
});
