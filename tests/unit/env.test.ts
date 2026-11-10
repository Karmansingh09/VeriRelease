import { describe, it, expect } from "vitest";
import { validateEnv } from "@/lib/env";

describe("Environment Configuration & Validation", () => {
  const validProductionEnv = {
    NODE_ENV: "production",
    NEXT_PUBLIC_APP_URL: "https://verirelease.example.com",
    DATABASE_URL: "postgresql://app_user:StrongSecret123!@db.example.com:5432/verirelease_prod?schema=public",
    GITHUB_WEBHOOK_SECRET: "c2e4f6a8b0d2e4f6a8b0d2e4f6a8b0d2", // >= 16 chars, no placeholder
    AUTH_TOKEN_SIGNING_SECRET: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4_independent_auth_secret", // >= 32 chars, independent
    GITHUB_APP_ID: "123456",
    GITHUB_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
    GITHUB_ACCESS_TOKEN: "ghp_validAccessTokenExample1234567890",
    GITHUB_OAUTH_CLIENT_ID: "github_oauth_client_id_prod_12345",
    GITHUB_OAUTH_CLIENT_SECRET: "b1c2d3e4f5a6b1c2d3e4f5a6b1c2d3e4_oauth_secret",
    GITHUB_OAUTH_CALLBACK_URL: "https://verirelease.example.com/api/auth/github/callback",
    OPENAI_API_KEY: "sk-proj-RealApiKeyFormatExample1234567890abcdef",
    OPENAI_MODEL: "gpt-4o-2024-08-06",
    PAYPAL_MODE: "sandbox",
    PAYPAL_CLIENT_ID: "AZ_PayPalClientIdProdFormat1234567890",
    PAYPAL_CLIENT_SECRET: "EL_PayPalClientSecretProdFormat1234567890",
    PAYPAL_WEBHOOK_ID: "WH-9876543210ABCDEF",
  };

  const validDevelopmentEnv = {
    NODE_ENV: "development",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/verirelease?schema=public",
  };

  describe("Happy Path Scenarios", () => {
    it("successfully validates a complete and compliant production environment", () => {
      const parsed = validateEnv(validProductionEnv);

      expect(parsed.NODE_ENV).toBe("production");
      expect(parsed.NEXT_PUBLIC_APP_URL).toBe("https://verirelease.example.com");
      expect(parsed.DATABASE_URL).toContain("postgresql://");
      expect(parsed.OPENAI_API_KEY).toBe("sk-proj-RealApiKeyFormatExample1234567890abcdef");
      expect(parsed.PAYPAL_MODE).toBe("sandbox");
      expect(parsed.GITHUB_WEBHOOK_SECRET).toBe("c2e4f6a8b0d2e4f6a8b0d2e4f6a8b0d2");
    });

    it("successfully validates development environment using safe defaults for non-configured secrets", () => {
      const parsed = validateEnv(validDevelopmentEnv);

      expect(parsed.NODE_ENV).toBe("development");
      expect(parsed.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
      expect(parsed.DATABASE_URL).toBe("postgresql://postgres:postgres@localhost:5432/verirelease?schema=public");
      expect(parsed.OPENAI_MODEL).toBe("gpt-4o-2024-08-06");
      expect(parsed.PAYPAL_MODE).toBe("sandbox");
    });
  });

  describe("Failure and Insecurity Rejection Scenarios", () => {
    it("rejects production configuration when DATABASE_URL is missing", () => {
      const invalid = { ...validProductionEnv, DATABASE_URL: "" };

      expect(() => validateEnv(invalid)).toThrowError(/DATABASE_URL is required/);
    });

    it("rejects non-PostgreSQL connection strings", () => {
      const invalid = {
        ...validProductionEnv,
        DATABASE_URL: "mysql://root:password@localhost:3306/wrongdb",
      };

      expect(() => validateEnv(invalid)).toThrowError(/DATABASE_URL must be a valid PostgreSQL connection string/);
    });

    it("rejects production configuration when OPENAI_API_KEY does not start with sk-", () => {
      const invalid = {
        ...validProductionEnv,
        OPENAI_API_KEY: "invalid-key-format",
      };

      expect(() => validateEnv(invalid)).toThrowError(/OPENAI_API_KEY must be a valid OpenAI key in production/);
    });

    it("rejects production configuration containing placeholder strings in OPENAI_API_KEY", () => {
      const invalid = {
        ...validProductionEnv,
        OPENAI_API_KEY: "sk-your_openai_api_key_here",
      };

      expect(() => validateEnv(invalid)).toThrowError(/OPENAI_API_KEY must be a valid OpenAI key in production/);
    });

    it("rejects production configuration containing 'placeholder' substring in OPENAI_API_KEY", () => {
      const invalid = {
        ...validProductionEnv,
        OPENAI_API_KEY: "sk-proj-placeholder-test",
      };

      expect(() => validateEnv(invalid)).toThrowError(/OPENAI_API_KEY must be a valid OpenAI key in production/);
    });

    it("rejects production configuration when GITHUB_WEBHOOK_SECRET is too short (<16 chars)", () => {
      const invalid = {
        ...validProductionEnv,
        GITHUB_WEBHOOK_SECRET: "tooshort",
      };

      expect(() => validateEnv(invalid)).toThrowError(
        /GITHUB_WEBHOOK_SECRET must be at least 16 characters in production/
      );
    });

    it("rejects production configuration containing placeholder strings in PAYPAL credentials", () => {
      const invalid = {
        ...validProductionEnv,
        PAYPAL_CLIENT_ID: "your_paypal_sandbox_client_id",
      };

      expect(() => validateEnv(invalid)).toThrowError(/PAYPAL_CLIENT_ID cannot use placeholder values in production/);
    });

    it("rejects production configuration when PAYPAL_CLIENT_SECRET is missing", () => {
      const invalid = {
        ...validProductionEnv,
        PAYPAL_CLIENT_SECRET: "",
      };

      expect(() => validateEnv(invalid)).toThrowError(/PAYPAL_CLIENT_SECRET is required in production/);
    });

    it("rejects production configuration when PAYPAL_WEBHOOK_ID is missing", () => {
      const invalid = {
        ...validProductionEnv,
        PAYPAL_WEBHOOK_ID: "",
      };

      expect(() => validateEnv(invalid)).toThrowError(/PAYPAL_WEBHOOK_ID is required in production/);
    });

    it("rejects invalid PAYPAL_MODE values such as 'mock' and 'test'", () => {
      const invalidMock = {
        ...validDevelopmentEnv,
        PAYPAL_MODE: "mock",
      };

      expect(() => validateEnv(invalidMock)).toThrowError(/PAYPAL_MODE/);

      const invalidTest = {
        ...validDevelopmentEnv,
        PAYPAL_MODE: "test",
      };

      expect(() => validateEnv(invalidTest)).toThrowError(/PAYPAL_MODE/);
    });

    it("rejects invalid NEXT_PUBLIC_APP_URL format", () => {
      const invalid = {
        ...validDevelopmentEnv,
        NEXT_PUBLIC_APP_URL: "not-a-valid-url",
      };

      expect(() => validateEnv(invalid)).toThrowError(/NEXT_PUBLIC_APP_URL must be a valid URL/);
    });

    it("rejects invalid NODE_ENV values outside the allowed enum", () => {
      const invalid = {
        ...validDevelopmentEnv,
        NODE_ENV: "staging",
      };

      expect(() => validateEnv(invalid)).toThrowError(/NODE_ENV/);
    });

    it("rejects production configuration when GITHUB_OAUTH_CLIENT_ID is missing or placeholder", () => {
      const missing = { ...validProductionEnv, GITHUB_OAUTH_CLIENT_ID: "" };
      expect(() => validateEnv(missing)).toThrowError(/GITHUB_OAUTH_CLIENT_ID is required/);

      const placeholder = { ...validProductionEnv, GITHUB_OAUTH_CLIENT_ID: "your_oauth_client_id" };
      expect(() => validateEnv(placeholder)).toThrowError(/placeholder/);
    });

    it("rejects production configuration when GITHUB_OAUTH_CLIENT_SECRET is missing or too short", () => {
      const missing = { ...validProductionEnv, GITHUB_OAUTH_CLIENT_SECRET: "" };
      expect(() => validateEnv(missing)).toThrowError(/GITHUB_OAUTH_CLIENT_SECRET must be at least 16 characters/);

      const short = { ...validProductionEnv, GITHUB_OAUTH_CLIENT_SECRET: "short_secret" };
      expect(() => validateEnv(short)).toThrowError(/at least 16 characters/);
    });

    it("rejects production configuration when GITHUB_OAUTH_CALLBACK_URL is not HTTPS", () => {
      const httpCallback = {
        ...validProductionEnv,
        GITHUB_OAUTH_CALLBACK_URL: "http://verirelease.example.com/api/auth/github/callback",
      };
      expect(() => validateEnv(httpCallback)).toThrowError(/HTTPS in production/);
    });

    it("rejects configuration when AUTH_TOKEN_SIGNING_SECRET reuses GITHUB_OAUTH_CLIENT_SECRET", () => {
      const reused = {
        ...validProductionEnv,
        GITHUB_OAUTH_CLIENT_SECRET: validProductionEnv.AUTH_TOKEN_SIGNING_SECRET,
      };
      expect(() => validateEnv(reused)).toThrowError(/AUTH_TOKEN_SIGNING_SECRET must not reuse GITHUB_OAUTH_CLIENT_SECRET/);
    });

    it("rejects configuration when GITHUB_OAUTH_CLIENT_SECRET reuses GITHUB_WEBHOOK_SECRET", () => {
      const reused = {
        ...validProductionEnv,
        GITHUB_OAUTH_CLIENT_SECRET: validProductionEnv.GITHUB_WEBHOOK_SECRET,
      };
      expect(() => validateEnv(reused)).toThrowError(/GITHUB_OAUTH_CLIENT_SECRET must not reuse GITHUB_WEBHOOK_SECRET/);
    });

    it("rejects configuration when GITHUB_OAUTH_CLIENT_ID reuses numeric GITHUB_APP_ID", () => {
      const reused = {
        ...validProductionEnv,
        GITHUB_OAUTH_CLIENT_ID: validProductionEnv.GITHUB_APP_ID,
      };
      expect(() => validateEnv(reused)).toThrowError(/GITHUB_OAUTH_CLIENT_ID must not reuse numeric GITHUB_APP_ID/);
    });
  });
});
