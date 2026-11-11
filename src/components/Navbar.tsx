"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  apiFetch,
  type SystemStatus,
  type UserProfile,
} from "../lib/api-client";
import { StatusBadge } from "./StatusBadge";

interface NavbarProps {
  user: UserProfile | null;
  systemStatus: SystemStatus | null;
  onUserUpdated?: (user: UserProfile | null) => void;
}

export function Navbar({
  user,
  systemStatus,
  onUserUpdated,
}: NavbarProps): React.ReactElement {
  const [busy, setBusy] = useState(false);

  async function handleDemoSwitch(persona: "client" | "developer") {
    setBusy(true);
    try {
      const res = await apiFetch<{ user: UserProfile }>("/api/auth/demo-login", {
        method: "POST",
        body: JSON.stringify({ persona }),
      });
      onUserUpdated?.(res.user);
    } catch {
      // Errors handled silently or reload
    } finally {
      setBusy(false);
    }
  }

  async function handleRoleToggle() {
    if (!user) return;
    setBusy(true);
    try {
      const nextRole = user.role === "CLIENT" ? "DEVELOPER" : "CLIENT";
      const res = await apiFetch<{ user: UserProfile }>("/api/users", {
        method: "PATCH",
        body: JSON.stringify({ role: nextRole }),
      });
      onUserUpdated?.(res.user);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
      onUserUpdated?.(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="sticky top-0 z-40 border-b border-[rgba(241,240,232,0.10)] bg-[#090B0A]/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2.5 group">
            {/* Precision Fintech Interlocking Geometric Icon */}
            <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#C6F36A]/40 bg-[#C6F36A]/10 text-[#C6F36A] shadow-sm shadow-[#C6F36A]/20 group-hover:border-[#C6F36A] group-hover:scale-105 transition-all">
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none">
                <path
                  d="M4 7L10 3.5L16 7V13L10 16.5L4 13V7Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path
                  d="M7 10L9.5 12.5L13.5 8"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold tracking-tight text-[#F1F0E8] group-hover:text-[#C6F36A] transition-colors">
                  VeriRelease
                </span>
                <span className="hidden sm:inline-block rounded bg-[#171C19] px-2 py-0.5 text-[10px] font-mono text-[#C6F36A] border border-[#C6F36A]/30">
                  PayPal AI Hackathon 2026
                </span>
              </div>
              <p className="hidden md:block text-[11px] text-[#858F87]">
                AI evaluates &bull; Deterministic policy authorizes &bull; PayPal settles
              </p>
            </div>
          </Link>

          <nav className="hidden md:flex items-center gap-3 ml-2 text-xs">
            <Link
              href="/"
              className="text-[#858F87] hover:text-[#F1F0E8] transition-colors"
            >
              &larr; Home
            </Link>
            <span className="text-[#858F87]/40">&bull;</span>
            <Link
              href="/#sim"
              className="text-[#858F87] hover:text-[#F1F0E8] transition-colors"
            >
              Simulation
            </Link>
          </nav>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {systemStatus && (
            <div className="hidden lg:flex items-center gap-1.5 text-[11px] font-mono">
              <span className="rounded-lg border border-[rgba(241,240,232,0.10)] bg-[#111512] px-2.5 py-1 text-[#B9C5B5] flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#B9C5B5]" />
                <span className="text-[#858F87]">AI:</span>
                <span className={systemStatus.aiMode === "openai" ? "text-[#8FE0A5]" : "text-[#B9C5B5]"}>
                  {systemStatus.aiMode === "openai" ? "OpenAI GPT-4o" : "Demo Mode"}
                </span>
              </span>
              <span className="rounded-lg border border-[rgba(241,240,232,0.10)] bg-[#111512] px-2.5 py-1 text-[#B9C5B5] flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#C6F36A]" />
                <span className="text-[#858F87]">PayPal:</span>
                <span className="text-[#C6F36A]">
                  {systemStatus.paypalMode === "mock"
                    ? "Sandbox Mock"
                    : `Sandbox (${systemStatus.paypalMode})`}
                </span>
              </span>
            </div>
          )}

          {user ? (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 rounded-lg border border-[rgba(241,240,232,0.10)] bg-[#111512] px-3 py-1.5">
                <div className="text-right">
                  <div className="text-xs font-medium text-[#F1F0E8] leading-tight">{user.name}</div>
                  <div className="text-[10px] font-mono text-[#858F87]">
                    {user.githubUsername ? `@${user.githubUsername}` : user.email}
                  </div>
                </div>
                <StatusBadge status={user.role} />
              </div>

              {systemStatus?.demoAuthEnabled && (
                <div className="flex items-center rounded-lg border border-[rgba(241,240,232,0.10)] bg-[#111512] p-0.5">
                  <button
                    type="button"
                    disabled={busy || user.email === "alice.client@verirelease.demo"}
                    onClick={() => handleDemoSwitch("client")}
                    className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      user.email === "alice.client@verirelease.demo"
                        ? "bg-[#1D241F] text-[#F1F0E8] border border-[rgba(241,240,232,0.20)] shadow-sm"
                        : "text-[#858F87] hover:text-[#F1F0E8]"
                    }`}
                  >
                    Alice (Client)
                  </button>
                  <button
                    type="button"
                    disabled={busy || user.email === "bob.dev@verirelease.demo"}
                    onClick={() => handleDemoSwitch("developer")}
                    className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      user.email === "bob.dev@verirelease.demo"
                        ? "bg-[#C6F36A]/15 text-[#C6F36A] border border-[#C6F36A]/30 shadow-sm"
                        : "text-[#858F87] hover:text-[#F1F0E8]"
                    }`}
                  >
                    Bob (Dev)
                  </button>
                </div>
              )}

              <button
                type="button"
                disabled={busy}
                onClick={handleRoleToggle}
                className="rounded-lg border border-[rgba(241,240,232,0.10)] bg-[#111512] px-2.5 py-1.5 text-xs text-[#B9C5B5] hover:border-[rgba(241,240,232,0.25)] hover:text-[#F1F0E8] transition-colors"
                title="Switch active role between CLIENT and DEVELOPER"
              >
                Role ({user.role})
              </button>

              {!user.githubUsername && (
                <a
                  href="/api/auth/github/login?action=link&returnTo=/dashboard"
                  className="rounded-lg border border-[#C6F36A]/30 bg-[#C6F36A]/10 px-2.5 py-1.5 text-xs font-semibold text-[#C6F36A] hover:bg-[#C6F36A]/20 transition-colors"
                >
                  Link GitHub
                </a>
              )}

              <button
                type="button"
                disabled={busy}
                onClick={handleLogout}
                className="rounded-lg border border-[rgba(241,240,232,0.10)] bg-[#111512] px-2.5 py-1.5 text-xs text-[#858F87] hover:border-[rgba(241,240,232,0.25)] hover:text-[#F1F0E8] transition-colors disabled:opacity-50"
              >
                Sign out
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-mono text-[#C6F36A] bg-[#C6F36A]/10 border border-[#C6F36A]/30 px-2.5 py-1 rounded-lg">
                <span className="h-1.5 w-1.5 rounded-full bg-[#C6F36A] animate-pulse" />
                <span>Zero Escrow Active</span>
              </span>
              <Link
                href="/"
                className="rounded-lg border border-[rgba(241,240,232,0.12)] bg-[#111512] px-3 py-1.5 text-xs font-medium text-[#F1F0E8] hover:border-[#C6F36A]/40 transition-colors"
              >
                &larr; Overview
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
