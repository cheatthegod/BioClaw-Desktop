import { logger } from '../logger.js';

/**
 * Safely parse a JSON string, returning a fallback value on failure.
 * Logs a warning instead of crashing on malformed data.
 */
export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    logger.warn(`Failed to parse JSON: ${(err as Error).message}`);
    return fallback;
  }
}
