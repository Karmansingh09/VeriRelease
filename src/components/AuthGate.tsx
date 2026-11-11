"use client";

import React, { useState } from "react";
import { apiFetch, type SystemStatus, type UserProfile } from "../lib/api-client";

interface AuthGateProps {
  systemStatus: SystemStatus | null;
  onAuthenticated: (user: UserProfile) => void;
  returnTo?: string;
}

export function AuthGate({
  systemStatus,
  onAuthenticated,
  returnTo = "/dashboard",
}: AuthGateProps): React.ReactElement {
  const [loadingPersona, setLoadingPersona] = useState<"client" | "developer" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDemoLogin(persona: "client" | "developer") {
    setError(null);
    setLoadingPersona(persona);
    try {
      const res = await apiFetch<{ user: UserProfile }>("/api/auth/demo-login", {
        method: "POST",
        body: JSON.stringify({ persona }),
      });
      onAuthenticated(res.user);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to start demo session");
    } finally {
      setLoadingPersona(null);
    }
  }

  return (
    <div className="mx-auto max-w-xl py-12 px-4">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl">
        <div className="mb-6">
          <span className="inline-flex items-center rounded-full border border-sky-800 bg-sky-950/70 px-3 py-1 text-xs font-mono text-sky-300">
            VeriRelease Identity &amp; Session Delivery
          </span>
          <h2 className="mt-3 text-2xl font-bold text-white">
            Sign in to VeriRelease Workspace
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Cryptographically signed HttpOnly sessions protect contract authorization,
            evidence verification, and PayPal Sandbox payout triggers.
          </p>
        </div>

        {error && (
          <div className="mb-5 rounded-lg border border-rose-800 bg-rose-950/50 px-4 py-3 text-xs text-rose-200">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <a
            href={`/api/auth/github/login?returnTo=${encodeURIComponent(returnTo)}`}
            className="flex w-full items-center justify-center gap-2.5 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-slate-200 transition-colors"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
              />
            </svg>
            Sign in with GitHub (OAuth 2.0 PKCE)
          </a>

          {systemStatus && !systemStatus.githubOAuthConfigured && (
            <p className="text-center text-[11px] text-amber-300/90">
              Note: Live GitHub OAuth credentials are not configured in this environment.
              Use Sandbox Demo Personas below to run the full workflow immediately.
            </p>
          )}

          {(systemStatus?.demoAuthEnabled ?? true) && (
            <div className="pt-4 border-t border-slate-800">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Hackathon Sandbox Personas
                </span>
                <span className="rounded bg-amber-950/70 border border-amber-800/80 px-2 py-0.5 text-[10px] font-mono text-amber-300">
                  DEMO SESSION MODE
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={loadingPersona !== null}
                  onClick={() => handleDemoLogin("client")}
                  className="flex flex-col items-start rounded-xl border border-sky-800/70 bg-sky-950/40 p-4 text-left hover:bg-sky-950/70 hover:border-sky-600 transition-colors disabled:opacity-50"
                >
                  <span className="text-xs font-mono text-sky-400">ROLE: CLIENT</span>
                  <span className="mt-1 text-sm font-semibold text-white">
                    {loadingPersona === "client" ? "Signing in..." : "Alice Chen"}
                  </span>
                  <span className="mt-1 text-[11px] text-slate-400">
                    Create contracts, fund milestones, release PayPal payouts.
                  </span>
                </button>

                <button
                  type="button"
                  disabled={loadingPersona !== null}
                  onClick={() => handleDemoLogin("developer")}
                  className="flex flex-col items-start rounded-xl border border-violet-800/70 bg-violet-950/40 p-4 text-left hover:bg-violet-950/70 hover:border-violet-600 transition-colors disabled:opacity-50"
                >
                  <span className="text-xs font-mono text-violet-400">ROLE: DEVELOPER</span>
                  <span className="mt-1 text-sm font-semibold text-white">
                    {loadingPersona === "developer" ? "Signing in..." : "Bob Rivera"}
                  </span>
                  <span className="mt-1 text-[11px] text-slate-400">
                    Submit GitHub PRs, verify AI evidence, track payout settlement.
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
