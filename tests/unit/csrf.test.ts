import { describe, it, expect } from "vitest";
import { verifyCsrfProtection, getCanonicalAppOrigin } from "../../src/modules/common/csrf";
import { DomainForbiddenError } from "../../src/modules/common/errors";

describe("CSRF Protection Unit Test Suite", () => {
  it("allows safe GET/HEAD/OPTIONS methods without origin verification", () => {
    const getReq = new Request("http://localhost:3000/api/auth/me", {
      method: "GET",
      headers: { cookie: "vr_session=token" },
    });
    expect(() => verifyCsrfProtection(getReq)).not.toThrow();

    const headReq = new Request("http://localhost:3000/api/auth/me", {
      method: "HEAD",
      headers: { cookie: "vr_session=token" },
    });
    expect(() => verifyCsrfProtection(headReq)).not.toThrow();

    const optionsReq = new Request("http://localhost:3000/api/auth/me", {
      method: "OPTIONS",
      headers: { cookie: "vr_session=token" },
    });
    expect(() => verifyCsrfProtection(optionsReq)).not.toThrow();
  });

  it("allows state-changing requests using Authorization: Bearer tokens (non-cookie API clients)", () => {
    const postReq = new Request("http://localhost:3000/api/contracts/cnt_1/github-repo", {
      method: "POST",
      headers: {
        authorization: "Bearer valid_bearer_token",
        origin: "https://external-client.com",
      },
    });
    expect(() => verifyCsrfProtection(postReq)).not.toThrow();
  });

  it("allows state-changing requests when no cookies are present (no ambient credential risk)", () => {
    const nakedPostReq = new Request("http://localhost:3000/api/auth/logout", {
      method: "POST",
    });
    expect(() => verifyCsrfProtection(nakedPostReq)).not.toThrow();
  });

  it("blocks state-changing requests when Sec-Fetch-Site indicates cross-site", () => {
    const crossSiteReq = new Request("http://localhost:3000/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: "vr_session=token",
        "sec-fetch-site": "cross-site",
        origin: "http://localhost:3000",
      },
    });
    expect(() => verifyCsrfProtection(crossSiteReq)).toThrow(DomainForbiddenError);
    expect(() => verifyCsrfProtection(crossSiteReq)).toThrow(/cross-site request blocked/i);
  });

  it("blocks state-changing requests with mismatched Origin header", () => {
    const attackerReq = new Request("http://localhost:3000/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: "vr_session=token",
        origin: "https://evil-attacker.com",
      },
    });
    expect(() => verifyCsrfProtection(attackerReq)).toThrow(DomainForbiddenError);
    expect(() => verifyCsrfProtection(attackerReq)).toThrow(/is not a trusted application origin/i);
  });

  it("blocks state-changing requests with mismatched Referer header when Origin is absent", () => {
    const attackerRefererReq = new Request("http://localhost:3000/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: "vr_session=token",
        referer: "https://evil-attacker.com/malicious-page",
      },
    });
    expect(() => verifyCsrfProtection(attackerRefererReq)).toThrow(DomainForbiddenError);
    expect(() => verifyCsrfProtection(attackerRefererReq)).toThrow(/is not a trusted application origin/i);
  });

  it("permits state-changing requests when Origin matches canonical trusted application origin", () => {
    const validReq = new Request("http://localhost:3000/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: "vr_session=token",
        origin: "http://localhost:3000",
      },
    });
    expect(() => verifyCsrfProtection(validReq)).not.toThrow();
  });

  it("permits state-changing requests when Origin matches explicitly configured allowedOrigins", () => {
    const validReq = new Request("http://localhost:3000/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: "vr_session=token",
        origin: "https://trusted-partner.example.com",
      },
    });
    expect(() =>
      verifyCsrfProtection(validReq, {
        allowedOrigins: ["https://trusted-partner.example.com"],
      })
    ).not.toThrow();
  });

  it("rejects state-changing requests when both Origin and Referer are absent on cookie requests", () => {
    const nakedReq = new Request("http://localhost:3000/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: "vr_session=token",
      },
    });
    expect(() => verifyCsrfProtection(nakedReq)).toThrow(DomainForbiddenError);
    expect(() => verifyCsrfProtection(nakedReq)).toThrow(/missing both Origin and Referer/i);
  });

  describe("Adversarial Attacks & Host Header Injection Defenses", () => {
    it("BLOCKS attack when attacker controls both Host and Origin (Host Header Injection Attack)", () => {
      // Attacker sets Host: evil-attacker.com and Origin: https://evil-attacker.com
      // An insecure implementation checking req.headers.get("host") would be bypassed!
      // VeriRelease compares only against configured canonical origin and rejects!
      const spoofedReq = new Request("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: {
          cookie: "vr_session=stolen_session",
          host: "evil-attacker.com",
          origin: "https://evil-attacker.com",
        },
      });

      expect(() =>
        verifyCsrfProtection(spoofedReq, {
          canonicalOrigin: "http://localhost:3000",
        })
      ).toThrow(DomainForbiddenError);
      expect(() =>
        verifyCsrfProtection(spoofedReq, {
          canonicalOrigin: "http://localhost:3000",
        })
      ).toThrow(/is not a trusted application origin/i);
    });

    it("BLOCKS attack when attacker controls both Host and Referer headers", () => {
      const spoofedReq = new Request("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: {
          cookie: "vr_session=stolen_session",
          host: "attacker.com",
          referer: "https://attacker.com/exploit",
        },
      });

      expect(() =>
        verifyCsrfProtection(spoofedReq, {
          canonicalOrigin: "http://localhost:3000",
        })
      ).toThrow(DomainForbiddenError);
    });

    it("enforces HTTPS for canonical application origin in production", () => {
      expect(() =>
        getCanonicalAppOrigin({
          canonicalOrigin: "http://insecure-http.example.com",
          isProduction: true,
        })
      ).toThrow(/must use HTTPS in production/i);

      expect(() =>
        getCanonicalAppOrigin({
          canonicalOrigin: "https://secure.example.com",
          isProduction: true,
        })
      ).not.toThrow();
    });
  });
});
