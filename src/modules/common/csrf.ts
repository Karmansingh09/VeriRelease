/**
 * VeriRelease Cross-Site Request Forgery (CSRF) Defense Module
 *
 * Enforces strict Origin and Referer validation against a trusted canonical application
 * origin on all cookie-authenticated, state-changing HTTP methods (POST, PUT, PATCH, DELETE).
 *
 * Security Requirements:
 * 1. Do NOT trust arbitrary or attacker-controlled Host headers.
 * 2. Origin/Referer is compared against the trusted configured application origin (NEXT_PUBLIC_APP_URL)
 *    and explicitly allowed origins.
 * 3. Enforce HTTPS canonical origin in production.
 * 4. Cross-origin state-changing requests are rejected.
 * 5. Modern browser 'Sec-Fetch-Site: cross-site' requests are blocked immediately.
 * 6. Missing or invalid Origin/Referer is handled safely fail-closed.
 * 7. Safe HTTP methods (GET, HEAD, OPTIONS) and Bearer-token API clients are exempt.
 */

import { DomainForbiddenError } from "./errors";

export interface CsrfValidationOptions {
  allowedOrigins?: string[];
  canonicalOrigin?: string;
  isProduction?: boolean;
}

/**
 * Resolves the canonical trusted application origin.
 * Enforces HTTPS in production environments.
 */
export function getCanonicalAppOrigin(options?: CsrfValidationOptions): URL {
  const rawUrl =
    options?.canonicalOrigin ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000";

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DomainForbiddenError(
      `CSRF verification failed: Invalid canonical application origin configuration '${rawUrl}'`
    );
  }

  const isProd = options?.isProduction ?? process.env.NODE_ENV === "production";
  if (isProd && parsed.protocol !== "https:") {
    throw new DomainForbiddenError(
      `CSRF verification failed: Canonical application origin '${rawUrl}' must use HTTPS in production`
    );
  }

  return parsed;
}

/**
 * Validates that an incoming state-changing request originates from a trusted origin.
 */
export function verifyCsrfProtection(req: Request, options?: CsrfValidationOptions): void {
  // 1. Safe HTTP methods (GET, HEAD, OPTIONS) do not modify server state
  const method = req.method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return;
  }

  // 2. Bearer token requests do not rely on browser ambient cookie credentials
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    return;
  }

  // 3. If there are no cookies on the request, ambient-credential CSRF is not possible
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader || cookieHeader.trim() === "") {
    return;
  }

  // 4. Block explicit cross-site requests via Fetch Metadata
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site") {
    throw new DomainForbiddenError("CSRF verification failed: cross-site request blocked by Sec-Fetch-Site");
  }

  // 5. Build set of trusted origins from canonical configuration (NEVER from Host header)
  const canonicalUrl = getCanonicalAppOrigin(options);
  const trustedOrigins = new Set<string>();
  trustedOrigins.add(canonicalUrl.origin.toLowerCase());

  if (options?.allowedOrigins) {
    for (const origin of options.allowedOrigins) {
      try {
        trustedOrigins.add(new URL(origin).origin.toLowerCase());
      } catch {
        // Ignore malformed allowed origin entries
      }
    }
  }

  // 6. Validate Origin header if present
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (!trustedOrigins.has(originUrl.origin.toLowerCase())) {
        throw new DomainForbiddenError(
          `CSRF verification failed: Origin '${originUrl.origin}' is not a trusted application origin`
        );
      }
      return; // Origin matched trusted application origin
    } catch (err: unknown) {
      if (err instanceof DomainForbiddenError) throw err;
      throw new DomainForbiddenError("CSRF verification failed: Malformed Origin header");
    }
  }

  // 7. Fallback to Referer header if Origin is omitted
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      if (!trustedOrigins.has(refererUrl.origin.toLowerCase())) {
        throw new DomainForbiddenError(
          `CSRF verification failed: Referer '${refererUrl.origin}' is not a trusted application origin`
        );
      }
      return; // Referer matched trusted application origin
    } catch (err: unknown) {
      if (err instanceof DomainForbiddenError) throw err;
      throw new DomainForbiddenError("CSRF verification failed: Malformed Referer header");
    }
  }

  // 8. Reject state-changing cookie requests missing both Origin and Referer
  throw new DomainForbiddenError(
    "CSRF verification failed: State-changing cookie request missing both Origin and Referer headers"
  );
}
