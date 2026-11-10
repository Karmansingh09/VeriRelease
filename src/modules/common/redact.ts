/**
 * VeriRelease Secret Redaction Utility
 *
 * Sanitizes tokens, credentials, private keys, authorization headers,
 * and sensitive connection strings from strings, error messages, and log objects.
 */

/**
 * Sanitizes sensitive credentials and secrets from text.
 */
export function redactSecrets(text: string): string {
  if (!text || typeof text !== "string") {
    return text;
  }

  let sanitized = text;

  // Redact Bearer tokens
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Bearer [REDACTED]");

  // Redact GitHub tokens
  sanitized = sanitized.replace(
    /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,255}/gi,
    "[REDACTED_GITHUB_TOKEN]"
  );

  // Redact Private keys
  sanitized = sanitized.replace(
    /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]"
  );

  // Redact key-value secrets
  sanitized = sanitized.replace(
    /((?:accessToken|access_token|client_secret|clientSecret|webhook_secret|webhookSecret|private_key|privateKey|password)\s*[:=]\s*["']?)([^&"'\s,;]+)(["']?)/gi,
    "$1[REDACTED]$3"
  );

  // Redact cookies (e.g. vr_session, vr_oauth_state)
  sanitized = sanitized.replace(
    /(?:vr_session|vr_oauth_state)=[^;,\s]+/gi,
    (match) => match.split("=")[0] + "=[REDACTED_COOKIE]"
  );

  // Redact OAuth authorization codes
  sanitized = sanitized.replace(
    /((?:code|authorization_code)\s*[:=]\s*["']?)([A-Za-z0-9_\-\.]{10,128})(["']?)/gi,
    "$1[REDACTED_CODE]$3"
  );

  return sanitized;
}

/**
 * Recursively redacts secrets in objects, arrays, or error messages.
 */
export function sanitizeLogData<T>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    return redactSecrets(data) as unknown as T;
  }

  if (data instanceof Error) {
    const cloned = new (data.constructor as new (msg: string) => Error)(redactSecrets(data.message));
    if (data.stack) {
      cloned.stack = redactSecrets(data.stack);
    }
    return cloned as unknown as T;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeLogData(item)) as unknown as T;
  }

  if (typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("secret") ||
        lowerKey.includes("password") ||
        lowerKey.includes("token") ||
        lowerKey.includes("privatekey") ||
        lowerKey.includes("authorization") ||
        lowerKey.includes("cookie") ||
        lowerKey === "code" ||
        lowerKey === "authorizationcode" ||
        lowerKey === "authorization_code"
      ) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = sanitizeLogData(value);
      }
    }
    return result as unknown as T;
  }

  return data;
}
