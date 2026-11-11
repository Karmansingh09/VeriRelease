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
    <header className="sticky top-0 z-40 border-b border-slate-800/90 bg-slate-950/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2.5 group">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-blue-700 font-mono text-sm font-bold text-white shadow-sm shadow-sky-900/50">
              VR
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold tracking-tight text-white group-hover:text-sky-300 transition-colors">
                  VeriRelease
                </span>
                <span className="hidden sm:inline-block rounded bg-sky-950/90 px-2 py-0.5 text-[10px] font-mono text-sky-300 border border-sky-800/80">
                  PayPal AI Hackathon
                </span>
              </div>
              <p className="hidden md:block text-[11px] text-slate-400">
                AI evaluates &bull; Deterministic policy authorizes &bull; PayPal settles
              </p>
            </div>
          </Link>

          <nav className="hidden md:flex items-center gap-1 ml-2">
            <Link
              href="/dashboard"
              className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800/70 hover:text-white transition-colors"
            >
              Workspace
            </Link>
          </nav>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {systemStatus && (
            <div className="hidden lg:flex items-center gap-1.5 text-[11px] font-mono">
              <span className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-slate-300">
                AI:{" "}
                <span className={systemStatus.aiMode === "openai" ? "text-emerald-400" : "text-amber-300"}>
                  {systemStatus.aiMode === "openai" ? "OpenAI GPT-4o" : "Demo Provider"}
                </span>
              </span>
              <span className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-slate-300">
                PayPal:{" "}
                <span className={systemStatus.paypalMode === "mock" ? "text-amber-300" : "text-emerald-400"}>
                  {systemStatus.paypalMode === "mock"
                    ? "Sandbox Mock"
                    : `Sandbox (${systemStatus.paypalMode})`}
                </span>
              </span>
            </div>
          )}

          {user ? (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/90 px-3 py-1.5">
                <div className="text-right">
                  <div className="text-xs font-medium text-white leading-tight">{user.name}</div>
                  <div className="text-[10px] font-mono text-slate-400">
                    {user.githubUsername ? `@${user.githubUsername}` : user.email}
                  </div>
                </div>
                <StatusBadge status={user.role} />
              </div>

              {systemStatus?.demoAuthEnabled && (
                <div className="flex items-center rounded-lg border border-slate-800 bg-slate-900/70 p-0.5">
                  <button
                    type="button"
                    disabled={busy || user.email === "alice.client@verirelease.demo"}
                    onClick={() => handleDemoSwitch("client")}
                    className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                      user.email === "alice.client@verirelease.demo"
                        ? "bg-sky-600 text-white"
                        : "text-slate-400 hover:text-white"
                    }`}
                    title="Switch session to Demo Client (Alice)"
                  >
                    Alice (Client)
                  </button>
                  <button
                    type="button"
                    disabled={busy || user.email === "bob.dev@verirelease.demo"}
                    onClick={() => handleDemoSwitch("developer")}
                    className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                      user.email === "bob.dev@verirelease.demo"
                        ? "bg-violet-600 text-white"
                        : "text-slate-400 hover:text-white"
                    }`}
                    title="Switch session to Demo Developer (Bob)"
                  >
                    Bob (Dev)
                  </button>
                </div>
              )}

              {!systemStatus?.demoAuthEnabled && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleRoleToggle}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-white transition-colors disabled:opacity-50"
                >
                  Switch to {user.role === "CLIENT" ? "Developer" : "Client"}
                </button>
              )}

              {!user.githubUsername && (
                <a
                  href="/api/auth/github/login?action=link&returnTo=/dashboard"
                  className="rounded-lg border border-sky-700/80 bg-sky-950/60 px-2.5 py-1.5 text-xs text-sky-300 hover:bg-sky-900/60 transition-colors"
                >
                  Link GitHub
                </a>
              )}

              <button
                type="button"
                disabled={busy}
                onClick={handleLogout}
                className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-400 hover:border-slate-700 hover:text-white transition-colors disabled:opacity-50"
              >
                Sign out
              </button>
            </div>
          ) : (
            <Link
              href="/dashboard"
              className="rounded-lg bg-sky-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 transition-colors"
            >
              Sign in / Workspace
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
