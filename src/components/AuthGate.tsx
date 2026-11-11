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

  const demoEnabled = systemStatus?.demoAuthEnabled ?? true;

  return (
    <div className="relative py-8 sm:py-14 px-4 sm:px-6 max-w-6xl mx-auto z-10">
      {/* Soft Electric Lime Ambient Glow */}
      <div className="pointer-events-none absolute -top-24 -left-24 w-96 h-96 rounded-full bg-[#C6F36A]/5 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-24 -right-24 w-96 h-96 rounded-full bg-[#8FE0A5]/5 blur-[120px]" />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start relative z-10">
        {/* Left Column: Platform Security Architecture & Context */}
        <div className="lg:col-span-5 space-y-6">
          <div>
            <div className="inline-flex items-center gap-2 rounded-md border border-[#C6F36A]/30 bg-[#C6F36A]/10 px-3 py-1 text-xs font-mono text-[#C6F36A] mb-3 shadow-sm">
              <span className="h-2 w-2 rounded-full bg-[#C6F36A] animate-pulse" />
              <span>VERIRELEASE ACCESS GATEWAY</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#F1F0E8] leading-tight">
              Verifiable Contracts &amp;{" "}
              <span className="text-[#C6F36A]">
                PayPal Settlement
              </span>
            </h1>
            <p className="mt-2 text-xs sm:text-sm text-[#B9C5B5] leading-relaxed">
              Sign in to manage contracts, ingest GitHub pull requests, evaluate evidence
              against immutable criteria hashes, and execute safe PayPal payouts.
            </p>
          </div>

          {/* 3 Architecture Pillar Cards */}
          <div className="space-y-3">
            <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-4 fintech-card-hover">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#171C19] border border-[rgba(241,240,232,0.15)] text-[#C6F36A]">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                  </svg>
                </div>
                <div>
                  <div className="text-xs font-semibold text-[#F1F0E8]">Cryptographic GitHub Evidence</div>
                  <div className="text-[11px] text-[#858F87]">
                    Pull request diffs, 40-char commit SHAs, and CI check runs frozen into RFC 8785 receipts.
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-4 fintech-card-hover">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#171C19] border border-[rgba(241,240,232,0.15)] text-[#E9B85D]">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                </div>
                <div>
                  <div className="text-xs font-semibold text-[#F1F0E8]">Strict AI vs. Policy Boundary</div>
                  <div className="text-[11px] text-[#858F87]">
                    AI models assess code advisories with zero payment authority. Deterministic policy rules alone govern payouts.
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-4 fintech-card-hover">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#171C19] border border-[rgba(241,240,232,0.15)] text-[#C6F36A]">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <div>
                  <div className="text-xs font-semibold text-[#F1F0E8]">Idempotent PayPal Settlement</div>
                  <div className="text-[11px] text-[#858F87]">
                    PostgreSQL <code className="text-[#F1F0E8]">FOR UPDATE</code> row locks and unique request IDs prevent double charges.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Telemetry pill */}
          <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-3.5 text-[11px] font-mono text-[#858F87] space-y-1.5 tabular-nums">
            <div className="flex items-center justify-between">
              <span>PostgreSQL 18:</span>
              <span className="text-[#8FE0A5] font-semibold">Row Locks &amp; Constraints Active</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Custody Model:</span>
              <span className="text-[#C6F36A]">Non-Custodial / Zero Escrow</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Receipt Standard:</span>
              <span className="text-[#F1F0E8]">RFC 8785 Canonical JSON SHA-256</span>
            </div>
          </div>
        </div>

        {/* Right Column: High-End Interactive Sign-In Command Card */}
        <div className="lg:col-span-7">
          <div className="rounded-2xl border border-[rgba(241,240,232,0.14)] bg-[#111512] p-6 sm:p-8 shadow-2xl relative overflow-hidden">
            {/* Top accent line */}
            <div className="h-0.5 w-full bg-gradient-to-r from-[#C6F36A] via-[#8FE0A5] to-[#C6F36A]/20 absolute top-0 left-0" />

            <div className="mb-6">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="inline-flex items-center gap-1.5 rounded-md border border-[#C6F36A]/30 bg-[#C6F36A]/10 px-2.5 py-0.5 text-[11px] font-mono text-[#C6F36A]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#C6F36A]" />
                  Enterprise Session Security
                </span>
                <span className="text-[10px] font-mono text-[#858F87]">
                  RFC 7519 HMAC-SHA256
                </span>
              </div>
              <h2 className="text-2xl font-bold text-[#F1F0E8] tracking-tight">
                Sign in to VeriRelease Workspace
              </h2>
              <p className="mt-1.5 text-xs text-[#B9C5B5] leading-relaxed">
                Cryptographically signed HttpOnly sessions protect contract authorization,
                evidence verification, and PayPal Sandbox payout triggers.
              </p>
            </div>

            {error && (
              <div className="mb-5 rounded-xl border border-[#E77D70]/40 bg-[#E77D70]/10 p-3.5 text-xs text-[#E77D70] flex items-start gap-2">
                <svg className="w-4 h-4 text-[#E77D70] shrink-0 mt-0.5" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
                  <path d="M7.002 11a1 1 0 1 1 2 0 1 1 0 0 1-2 0zM7.1 4.995a.905.905 0 1 1 1.8 0l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995z" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            <div className="space-y-5">
              {/* Primary Method: Verified GitHub OAuth PKCE */}
              <div>
                <a
                  href={`/api/auth/github/login?returnTo=${encodeURIComponent(returnTo)}`}
                  className="flex w-full items-center justify-center gap-3 rounded-xl bg-[#F1F0E8] px-5 py-3.5 text-sm font-semibold text-[#090B0A] hover:bg-white transition-all shadow-md hover:-translate-y-0.5 active:translate-y-0 group"
                >
                  <svg className="h-5 w-5 text-[#090B0A]" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path
                      fillRule="evenodd"
                      clipRule="evenodd"
                      d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                    />
                  </svg>
                  <span>Sign in with GitHub (OAuth 2.0 PKCE)</span>
                </a>
                <p className="mt-1.5 text-center text-[11px] text-[#858F87]">
                  Cryptographically verifies account ownership via GitHub OAuth Web Flow.
                </p>
              </div>

              {/* Section Divider */}
              <div className="relative flex items-center py-1">
                <div className="flex-grow border-t border-[rgba(241,240,232,0.10)]" />
                <span className="flex-shrink mx-3 text-[10px] font-mono uppercase tracking-wider text-[#858F87] bg-[#111512] px-2 py-0.5 rounded border border-[rgba(241,240,232,0.10)]">
                  Or Explore with 1-Click Sandbox Personas
                </span>
                <div className="flex-grow border-t border-[rgba(241,240,232,0.10)]" />
              </div>

              {/* 1-Click Interactive Hackathon Sandbox Personas */}
              {demoEnabled && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Persona 1: Alice Chen (Client) */}
                    <button
                      type="button"
                      disabled={loadingPersona !== null}
                      onClick={() => handleDemoLogin("client")}
                      className="group flex flex-col justify-between rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] p-4 text-left hover:border-[#F1F0E8]/50 hover:shadow-lg transition-all hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50"
                    >
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#242C26] border border-[rgba(241,240,232,0.20)] text-xs font-mono font-bold text-[#F1F0E8]">
                            AC
                          </span>
                          <span className="rounded bg-[#242C26] border border-[rgba(241,240,232,0.15)] px-2 py-0.5 text-[10px] font-mono text-[#F1F0E8]">
                            ROLE: CLIENT
                          </span>
                        </div>
                        <div className="text-sm font-bold text-[#F1F0E8] group-hover:text-white transition-colors">
                          Alice Chen
                        </div>
                        <p className="mt-1 text-[11px] text-[#B9C5B5] leading-relaxed">
                          Define milestones, lock acceptance criteria, fund contracts &amp; release PayPal Sandbox payouts.
                        </p>
                      </div>

                      <div className="mt-4 pt-3 border-t border-[rgba(241,240,232,0.10)] flex items-center justify-between text-xs font-semibold text-[#F1F0E8] group-hover:text-white">
                        {loadingPersona === "client" ? (
                          <span className="inline-flex items-center gap-1.5">
                            <svg className="animate-spin h-3.5 w-3.5 text-[#F1F0E8]" viewBox="0 0 24 24" fill="none">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                            </svg>
                            <span>Authenticating Alice...</span>
                          </span>
                        ) : (
                          <span>Enter as Alice →</span>
                        )}
                      </div>
                    </button>

                    {/* Persona 2: Bob Rivera (Developer) */}
                    <button
                      type="button"
                      disabled={loadingPersona !== null}
                      onClick={() => handleDemoLogin("developer")}
                      className="group flex flex-col justify-between rounded-xl border border-[#C6F36A]/25 bg-[#171C19] p-4 text-left hover:border-[#C6F36A]/60 hover:shadow-lg hover:shadow-[#C6F36A]/5 transition-all hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50"
                    >
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#C6F36A]/15 border border-[#C6F36A]/30 text-xs font-mono font-bold text-[#C6F36A]">
                            BR
                          </span>
                          <span className="rounded bg-[#C6F36A]/10 border border-[#C6F36A]/30 px-2 py-0.5 text-[10px] font-mono text-[#C6F36A]">
                            ROLE: DEVELOPER
                          </span>
                        </div>
                        <div className="text-sm font-bold text-[#F1F0E8] group-hover:text-[#C6F36A] transition-colors">
                          Bob Rivera
                        </div>
                        <p className="mt-1 text-[11px] text-[#B9C5B5] leading-relaxed">
                          Connect GitHub repositories, submit pull requests, inspect AI evaluations &amp; receive settlements.
                        </p>
                      </div>

                      <div className="mt-4 pt-3 border-t border-[rgba(241,240,232,0.10)] flex items-center justify-between text-xs font-semibold text-[#C6F36A] group-hover:text-[#B5E358]">
                        {loadingPersona === "developer" ? (
                          <span className="inline-flex items-center gap-1.5">
                            <svg className="animate-spin h-3.5 w-3.5 text-[#C6F36A]" viewBox="0 0 24 24" fill="none">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                            </svg>
                            <span>Authenticating Bob...</span>
                          </span>
                        ) : (
                          <span>Enter as Bob →</span>
                        )}
                      </div>
                    </button>
                  </div>
                </div>
              )}

              {/* Security Footnote */}
              <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#171C19] p-3 text-center text-[10px] font-mono text-[#858F87] flex items-center justify-center gap-2">
                <svg className="w-3.5 h-3.5 text-[#C6F36A]" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1a2 2 0 0 1 2 2v2h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1V3a2 2 0 0 1 2-2zm1 4V3a1 1 0 0 0-2 0v2h2z" />
                </svg>
                <span>HttpOnly Cookie &bull; SameSite=Lax &bull; 24-Hour Cryptographic TTL</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
