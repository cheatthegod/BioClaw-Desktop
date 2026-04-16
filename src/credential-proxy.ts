/**
 * Credential Proxy — reads allowed secrets from .env and provides them
 * to containers via stdin, ensuring secrets never touch disk or volume mounts.
 *
 * Future enhancement: run an HTTP proxy that intercepts API calls from containers
 * and injects credentials on the fly, so containers never see raw API keys at all.
 */
import { readEnvFile } from './env.js';

const ALLOWED_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'MODEL_PROVIDER',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_MODEL',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_MODEL',
] as const;

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
export function readSecrets(): Record<string, string> {
  const allVars = readEnvFile();
  const secrets: Record<string, string> = {};
  for (const key of ALLOWED_VARS) {
    const value = allVars[key];
    if (value) secrets[key] = value;
  }
  return secrets;
}
