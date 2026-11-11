/**
 * System Runtime Status Endpoint (Non-Secret)
 *
 * Endpoint:
 *   GET /api/system/status
 *
 * Reports public feature flags and provider mode (demo vs live) without exposing secrets.
 */

import { NextResponse } from "next/server";
import { env } from "../../../../lib/env";

export async function GET() {
  const githubOAuthConfigured = Boolean(
    env.GITHUB_OAUTH_CLIENT_ID &&
      !env.GITHUB_OAUTH_CLIENT_ID.includes("placeholder") &&
      !env.GITHUB_OAUTH_CLIENT_ID.includes("your_")
  );

  const demoAuthEnabled =
    process.env.ENABLE_DEMO_AUTH === "true" ||
    (env.NODE_ENV !== "production" && process.env.ENABLE_DEMO_AUTH !== "false");

  const aiMode =
    env.OPENAI_API_KEY &&
    env.OPENAI_API_KEY.startsWith("sk-") &&
    !env.OPENAI_API_KEY.includes("mock") &&
    !env.OPENAI_API_KEY.includes("placeholder") &&
    !env.OPENAI_API_KEY.includes("your_")
      ? "openai"
      : "demo";

  const hasRealPayPalCreds = Boolean(
    env.PAYPAL_CLIENT_ID &&
      env.PAYPAL_CLIENT_SECRET &&
      !env.PAYPAL_CLIENT_ID.includes("placeholder") &&
      !env.PAYPAL_CLIENT_ID.includes("your_") &&
      !env.PAYPAL_CLIENT_SECRET.includes("placeholder") &&
      !env.PAYPAL_CLIENT_SECRET.includes("your_")
  );

  const paypalMode = hasRealPayPalCreds ? env.PAYPAL_MODE : "mock";

  return NextResponse.json(
    {
      appName: "VeriRelease",
      environment: env.NODE_ENV,
      githubOAuthConfigured,
      demoAuthEnabled,
      aiMode,
      paypalMode,
    },
    { status: 200 }
  );
}
