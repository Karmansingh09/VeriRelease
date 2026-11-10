/**
 * VeriRelease Secret Redaction Unit Test Suite
 */

import { describe, it, expect } from "vitest";
import { redactSecrets, sanitizeLogData } from "../../src/modules/common/redact";

describe("Secret Redaction Unit Test Suite", () => {
  it("redacts standard Bearer authorization headers and tokens", () => {
    const raw = "Authorization: Bearer my_secret_bearer_token_xyz123";
    const cleaned = redactSecrets(raw);
    expect(cleaned).toBe("Authorization: Bearer [REDACTED]");
    expect(cleaned).not.toContain("my_secret_bearer_token_xyz123");
  });

  it("redacts GitHub Personal Access Tokens and App Tokens", () => {
    const tokens = [
      "ghp_1234567890abcdef1234567890abcdef",
      "gho_1234567890abcdef1234567890abcdef",
      "ghu_1234567890abcdef1234567890abcdef",
      "ghs_1234567890abcdef1234567890abcdef",
      "ghr_1234567890abcdef1234567890abcdef",
      "github_pat_11AAAAAAA0000000000000_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    ];

    for (const token of tokens) {
      const msg = `Failed request with token ${token} on repository`;
      const cleaned = redactSecrets(msg);
      expect(cleaned).not.toContain(token);
      expect(cleaned).toContain("[REDACTED_GITHUB_TOKEN]");
    }
  });

  it("redacts PEM format private keys", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1+examplePrivateKeYDataabcdef1234567890==
-----END RSA PRIVATE KEY-----`;

    const logText = `Error occurred: key=${pem} failed validation`;
    const cleaned = redactSecrets(logText);
    expect(cleaned).not.toContain("examplePrivateKeYData");
    expect(cleaned).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("redacts key-value secret fields in connection strings and payloads", () => {
    const text = 'client_secret="super_secret_client_val" and password=my_db_password;';
    const cleaned = redactSecrets(text);
    expect(cleaned).not.toContain("super_secret_client_val");
    expect(cleaned).not.toContain("my_db_password");
  });

  it("sanitizes structured objects and nested error messages recursively", () => {
    const payload = {
      username: "alice",
      token: "ghp_sensitive_1234567890abcdef",
      nested: {
        password: "super_secret_password",
        status: "active",
      },
      error: new Error("Connection failed: Bearer secret_token_xyz"),
    };

    const sanitized = sanitizeLogData(payload);
    expect(sanitized.token).toBe("[REDACTED]");
    expect(sanitized.nested.password).toBe("[REDACTED]");
    expect(sanitized.username).toBe("alice");
    expect(sanitized.nested.status).toBe("active");
    expect(sanitized.error.message).toContain("Bearer [REDACTED]");
  });
});
