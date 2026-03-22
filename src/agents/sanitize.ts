/**
 * Security utilities for sanitizing error messages before sending to users.
 */

const MAX_ERROR_LENGTH = 200;

const SENSITIVE_PATTERNS = [
  /Bearer [a-zA-Z0-9\-_]+/g,
  /sk-[a-zA-Z0-9]+/g,
  /key-[a-zA-Z0-9]+/g,
  /https?:\/\/[^\s]*[?&](token|key|secret|auth|api_key|apikey|access_token)=[^\s&]*/gi,
];

/**
 * Sanitize an error message by stripping API keys, auth tokens, and
 * limiting length before it gets sent to the WeChat user.
 */
export function sanitizeErrorMessage(msg: string): string {
  let cleaned = msg;
  for (const pattern of SENSITIVE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "[REDACTED]");
  }
  if (cleaned.length > MAX_ERROR_LENGTH) {
    cleaned = cleaned.slice(0, MAX_ERROR_LENGTH) + "...";
  }
  return cleaned;
}
