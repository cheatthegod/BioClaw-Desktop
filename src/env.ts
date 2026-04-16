import fs from 'fs';
import path from 'path';

/**
 * Parse a .env file's content into a key-value record.
 * Handles comments, quoted values, and empty lines.
 */
export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Read and parse a .env file from disk. Returns empty record if file doesn't exist.
 */
export function readEnvFile(envPath?: string): Record<string, string> {
  const filePath = envPath || path.join(process.cwd(), '.env');
  if (!fs.existsSync(filePath)) return {};
  return parseEnvContent(fs.readFileSync(filePath, 'utf-8'));
}

let loaded = false;

export function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;

  const vars = readEnvFile();
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
