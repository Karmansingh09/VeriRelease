import { z } from "zod";

/**
 * Zod schema defining the environment configuration for VeriRelease.
 * Enforces production-safe secrets: in production, all secrets are strictly
 * required and placeholder values are rejected.
 */
export const createEnvSchema = (nodeEnv: string = process.env.NODE_ENV ?? "development") => {
  const isProduction = nodeEnv === "production";

  return z
    .object({
      NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
      NEXT_PUBLIC_APP_URL: isProduction
        ? z
            .string()
            .url("NEXT_PUBLIC_APP_URL must be a valid URL")
            .refine(
              (val) => val.startsWith("https://"),
              "NEXT_PUBLIC_APP_URL must use HTTPS in production"
            )
            .default("https://verirelease.example.com")
        : z
            .string()
            .url("NEXT_PUBLIC_APP_URL must be a valid URL")
            .default("http://localhost:3000"),

      // Database
      DATABASE_URL: z
        .string()
        .min(1, "DATABASE_URL is required")
        .refine(
          (val) => val.startsWith("postgresql://") || val.startsWith("postgres://"),
          "DATABASE_URL must be a valid PostgreSQL connection string (postgresql://...)"
        ),

      // Authentication
      AUTH_TOKEN_SIGNING_SECRET: isProduction
        ? z
            .string()
            .min(32, "AUTH_TOKEN_SIGNING_SECRET must be at least 32 characters in production")
            .refine(
              (val) => !val.includes("your_") && !val.includes("placeholder"),
              "AUTH_TOKEN_SIGNING_SECRET cannot use placeholder values in production"
            )
        : z
            .string()
            .min(16, "AUTH_TOKEN_SIGNING_SECRET must be at least 16 characters")
            .default("dev_auth_token_signing_secret_min16chars!"),

      // GitHub Integration
      GITHUB_WEBHOOK_SECRET: isProduction
        ? z
            .string()
            .min(16, "GITHUB_WEBHOOK_SECRET must be at least 16 characters in production")
            .refine(
              (val) => !val.includes("your_") && !val.includes("placeholder"),
              "GITHUB_WEBHOOK_SECRET cannot use placeholder values in production"
            )
        : z.string().min(1, "GITHUB_WEBHOOK_SECRET is required").default("dev_github_webhook_secret_placeholder"),

      GITHUB_ACCESS_TOKEN: z.string().optional(),
      GITHUB_API_BASE_URL: z
        .string()
        .url("GITHUB_API_BASE_URL must be a valid URL")
        .default("https://api.github.com"),
      GITHUB_APP_ID: z.string().optional(),
      GITHUB_INSTALLATION_ID: z.string().optional(),
      GITHUB_PRIVATE_KEY: z.string().optional(),

      // GitHub OAuth 2.0 Web Application Flow (Milestone 3.1)
      GITHUB_OAUTH_CLIENT_ID: isProduction
        ? z
            .string()
            .min(1, "GITHUB_OAUTH_CLIENT_ID is required in production")
            .refine(
              (val) => !val.includes("your_") && !val.includes("placeholder"),
              "GITHUB_OAUTH_CLIENT_ID cannot use placeholder values in production"
            )
        : z.string().min(1, "GITHUB_OAUTH_CLIENT_ID is required").default("dev_github_oauth_client_id_placeholder"),

      GITHUB_OAUTH_CLIENT_SECRET: isProduction
        ? z
            .string()
            .min(16, "GITHUB_OAUTH_CLIENT_SECRET must be at least 16 characters in production")
            .refine(
              (val) => !val.includes("your_") && !val.includes("placeholder"),
              "GITHUB_OAUTH_CLIENT_SECRET cannot use placeholder values in production"
            )
        : z.string().min(1, "GITHUB_OAUTH_CLIENT_SECRET is required").default("dev_github_oauth_client_secret_placeholder"),

      GITHUB_OAUTH_CALLBACK_URL: isProduction
        ? z
            .string()
            .url("GITHUB_OAUTH_CALLBACK_URL must be a valid URL")
            .refine(
              (val) => val.startsWith("https://"),
              "GITHUB_OAUTH_CALLBACK_URL must use HTTPS in production"
            )
        : z
            .string()
            .url("GITHUB_OAUTH_CALLBACK_URL must be a valid URL")
            .default("http://localhost:3000/api/auth/github/callback"),

      // OpenAI API
      OPENAI_API_KEY: isProduction
        ? z
            .string()
            .min(1, "OPENAI_API_KEY is required in production")
            .refine(
              (val) => val.startsWith("sk-") && !val.includes("your_") && !val.includes("placeholder"),
              "OPENAI_API_KEY must be a valid OpenAI key in production"
            )
        : z.string().min(1, "OPENAI_API_KEY is required").default("sk-mock-dev-key"),

      OPENAI_MODEL: z.string().default("gpt-4o-2024-08-06"),

      // PayPal Sandbox / Live
      PAYPAL_MODE: z.enum(["sandbox", "live"]).default("sandbox"),
      PAYPAL_BASE_URL: z.string().url().default("https://api-m.sandbox.paypal.com"),

      PAYPAL_CLIENT_ID: isProduction
        ? z
            .string()
            .min(1, "PAYPAL_CLIENT_ID is required in production")
            .refine(
              (val) => !val.includes("your_") && !val.includes("placeholder"),
              "PAYPAL_CLIENT_ID cannot use placeholder values in production"
            )
        : z.string().min(1, "PAYPAL_CLIENT_ID is required").default("dev_paypal_client_id_placeholder"),

      PAYPAL_CLIENT_SECRET: isProduction
        ? z
            .string()
            .min(1, "PAYPAL_CLIENT_SECRET is required in production")
            .refine(
              (val) => !val.includes("your_") && !val.includes("placeholder"),
              "PAYPAL_CLIENT_SECRET cannot use placeholder values in production"
            )
        : z.string().min(1, "PAYPAL_CLIENT_SECRET is required").default("dev_paypal_client_secret_placeholder"),

      PAYPAL_WEBHOOK_ID: isProduction
        ? z
            .string()
            .min(1, "PAYPAL_WEBHOOK_ID is required in production")
            .refine(
              (val) => !val.includes("your_") && !val.includes("placeholder"),
              "PAYPAL_WEBHOOK_ID cannot use placeholder values in production"
            )
        : z.string().min(1, "PAYPAL_WEBHOOK_ID is required").default("dev_paypal_webhook_id_placeholder"),
    })
    .superRefine((data, ctx) => {
      // AUTH_TOKEN_SIGNING_SECRET must never reuse GITHUB_WEBHOOK_SECRET
      if (
        data.AUTH_TOKEN_SIGNING_SECRET &&
        data.GITHUB_WEBHOOK_SECRET &&
        data.AUTH_TOKEN_SIGNING_SECRET === data.GITHUB_WEBHOOK_SECRET
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AUTH_TOKEN_SIGNING_SECRET must not reuse GITHUB_WEBHOOK_SECRET",
          path: ["AUTH_TOKEN_SIGNING_SECRET"],
        });
      }

      // AUTH_TOKEN_SIGNING_SECRET must never reuse GITHUB_OAUTH_CLIENT_SECRET
      if (
        data.AUTH_TOKEN_SIGNING_SECRET &&
        data.GITHUB_OAUTH_CLIENT_SECRET &&
        data.AUTH_TOKEN_SIGNING_SECRET === data.GITHUB_OAUTH_CLIENT_SECRET
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AUTH_TOKEN_SIGNING_SECRET must not reuse GITHUB_OAUTH_CLIENT_SECRET",
          path: ["AUTH_TOKEN_SIGNING_SECRET"],
        });
      }

      // GITHUB_OAUTH_CLIENT_SECRET must never reuse GITHUB_WEBHOOK_SECRET
      if (
        data.GITHUB_OAUTH_CLIENT_SECRET &&
        data.GITHUB_WEBHOOK_SECRET &&
        data.GITHUB_OAUTH_CLIENT_SECRET === data.GITHUB_WEBHOOK_SECRET
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "GITHUB_OAUTH_CLIENT_SECRET must not reuse GITHUB_WEBHOOK_SECRET",
          path: ["GITHUB_OAUTH_CLIENT_SECRET"],
        });
      }

      // Do not reuse numeric GITHUB_APP_ID as GITHUB_OAUTH_CLIENT_ID
      if (
        data.GITHUB_APP_ID &&
        data.GITHUB_OAUTH_CLIENT_ID &&
        data.GITHUB_APP_ID === data.GITHUB_OAUTH_CLIENT_ID
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "GITHUB_OAUTH_CLIENT_ID must not reuse numeric GITHUB_APP_ID",
          path: ["GITHUB_OAUTH_CLIENT_ID"],
        });
      }

      // In production mode, GitHub App credentials must be configured (no silent fallback to global PAT)
      if (data.NODE_ENV === "production") {
        if (!data.GITHUB_APP_ID || !data.GITHUB_PRIVATE_KEY) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Production environment requires GITHUB_APP_ID and GITHUB_PRIVATE_KEY for GitHub App installation token flow",
            path: ["GITHUB_APP_ID"],
          });
        }
      }

      // In live production mode, PAYPAL_MODE must be live or explicitly verified
      if (data.NODE_ENV === "production" && data.PAYPAL_MODE === "live") {
        if (!data.PAYPAL_CLIENT_ID || !data.PAYPAL_CLIENT_SECRET) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Production PayPal Live credentials must be explicitly configured",
            path: ["PAYPAL_CLIENT_ID"],
          });
        }
      }
    });
};

export type EnvConfig = z.infer<ReturnType<typeof createEnvSchema>>;

/**
 * Validates any arbitrary environment map against the schema.
 * Throws a formatted Error with distinct missing/invalid field breakdowns.
 */
export function validateEnv(raw: Record<string, string | undefined>): EnvConfig {
  const nodeEnv = raw.NODE_ENV ?? process.env.NODE_ENV ?? "development";
  const schema = createEnvSchema(nodeEnv);
  const result = schema.safeParse(raw);

  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => `  - [${issue.path.join(".") || "ROOT"}]: ${issue.message}`)
      .join("\n");
    throw new Error(
      `[VeriRelease Environment Validation Failed]\nEnvironment: ${nodeEnv}\nErrors:\n${errorDetails}`
    );
  }

  return result.data;
}

/**
 * Global validated environment configuration singleton.
 * Evaluates process.env safely at runtime.
 */
export const env: EnvConfig = (() => {
  // During tests or static build collection, fallback cleanly if not executing a full-app environment run
  const isBuildPhase =
    process.env.NEXT_PHASE === "phase-production-build" ||
    process.env.npm_lifecycle_event === "build";
  const defaultDevDb = "postgresql://postgres:postgres@localhost:5432/verirelease?schema=public";

  const rawEnv: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? defaultDevDb,
  };

  // If in build phase without production env vars, validate using development fallback
  if (isBuildPhase && (!process.env.DATABASE_URL || !process.env.GITHUB_WEBHOOK_SECRET)) {
    return validateEnv({ ...rawEnv, NODE_ENV: "development" });
  }

  return validateEnv(rawEnv);
})();
