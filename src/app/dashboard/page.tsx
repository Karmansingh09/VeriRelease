"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Navbar } from "../../components/Navbar";
import { AuthGate } from "../../components/AuthGate";
import { StatusBadge } from "../../components/StatusBadge";
import { useSession } from "../../hooks/useSession";
import {
  apiFetch,
  formatMinorUnits,
  type ContractSummary,
} from "../../lib/api-client";

export default function DashboardPage(): React.ReactElement {
  const router = useRouter();
  const { user, setUser, systemStatus, loading: sessionLoading } = useSession();

  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [loadingContracts, setLoadingContracts] = useState(false);
  const [roleFilter, setRoleFilter] = useState<"ALL" | "CLIENT" | "DEVELOPER">("ALL");
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Create Contract Form State
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [seedingSample, setSeedingSample] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [developerEmail, setDeveloperEmail] = useState("bob.dev@verirelease.demo");
  const [totalAmountUsd, setTotalAmountUsd] = useState("1500");
  const [currency, setCurrency] = useState<"USD" | "EUR" | "GBP">("USD");
  const [githubRepoOwner, setGithubRepoOwner] = useState("Karmansingh09");
  const [githubRepoName, setGithubRepoName] = useState("VeriRelease");

  const loadContracts = useCallback(async () => {
    if (!user) return;
    setLoadingContracts(true);
    setError(null);
    try {
      const qs = roleFilter === "ALL" ? "" : `?role=${roleFilter}`;
      const res = await apiFetch<{ contracts: ContractSummary[] }>(`/api/contracts${qs}`);
      setContracts(res.contracts);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load contracts");
    } finally {
      setLoadingContracts(false);
    }
  }, [user, roleFilter]);

  useEffect(() => {
    if (user) {
      void loadContracts();
    } else {
      setContracts([]);
    }
  }, [user, loadContracts]);

  async function handleCreateContract(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setCreating(true);
    try {
      const res = await apiFetch<{ contract: { id: string } }>("/api/contracts", {
        method: "POST",
        body: JSON.stringify({
          title,
          description,
          developerEmail,
          totalAmountUsd,
          currency,
          githubRepoOwner,
          githubRepoName,
        }),
      });
      setTitle("");
      setDescription("");
      setShowCreateForm(false);
      setSuccessMsg("Contract created successfully! Redirecting to add milestones...");
      await loadContracts();
      router.push(`/contracts/${res.contract.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create contract");
    } finally {
      setCreating(false);
    }
  }

  async function handleCreateSampleContract() {
    if (!user) return;
    setError(null);
    setSuccessMsg(null);
    setSeedingSample(true);
    try {
      const targetDevEmail =
        user.email === "bob.dev@verirelease.demo"
          ? "alice.client@verirelease.demo"
          : "bob.dev@verirelease.demo";

      const contractRes = await apiFetch<{ contract: { id: string } }>("/api/contracts", {
        method: "POST",
        body: JSON.stringify({
          title: "PayPal Gateway & Idempotent Webhook Handler",
          description:
            "Implement high-throughput PayPal Orders v2 webhook handler with SELECT FOR UPDATE concurrency locks and SHA-256 criteria receipts.",
          developerEmail: targetDevEmail,
          totalAmountUsd: "1200",
          currency: "USD",
          githubRepoOwner: "Karmansingh09",
          githubRepoName: "VeriRelease",
        }),
      });

      const milestoneRes = await apiFetch<{ milestone: { id: string } }>(
        `/api/contracts/${contractRes.contract.id}/milestones`,
        {
          method: "POST",
          body: JSON.stringify({
            title: "Milestone 1 · Webhook Verification & Concurrency Locks",
            description:
              "Deliver cryptographic webhook signature validation, idempotency key persistence, and automated CI test runs.",
            amountMinorUnits: 120000,
            currency: "USD",
            criteria: [
              {
                title: "Automated CI Tests Pass",
                description: "All integration & unit tests must report SUCCESS on GitHub Actions.",
                criterionType: "AUTOMATED_TEST",
                isMandatory: true,
              },
              {
                title: "Pull Request Code Changes",
                description: "PR contains verified file modifications implementing payout coordinator.",
                criterionType: "FILE_CHANGE",
                isMandatory: true,
              },
              {
                title: "Specification Compliance",
                description: "PR description documents idempotency key handling and error boundaries.",
                criterionType: "SPECIFICATION",
                isMandatory: false,
              },
            ],
          }),
        }
      );

      await apiFetch(`/api/milestones/${milestoneRes.milestone.id}/fund`, {
        method: "POST",
      });

      setSuccessMsg("Sample contract & funded milestone created! Opening milestone workspace...");
      router.push(`/milestones/${milestoneRes.milestone.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create sample contract");
    } finally {
      setSeedingSample(false);
    }
  }

  const stats = useMemo(() => {
    let activeContracts = 0;
    let pendingReview = 0;
    let eligiblePayouts = 0;
    let totalMinor = 0n;

    for (const c of contracts) {
      if (c.status === "ACTIVE" || c.status === "DRAFT") activeContracts += 1;
      totalMinor += BigInt(c.totalAmountMinorUnits || "0");
      for (const m of c.milestones) {
        if (m.status === "SUBMITTED" || m.status === "EVALUATING") pendingReview += 1;
        if (m.status === "ELIGIBLE_FOR_PAYOUT") eligiblePayouts += 1;
      }
    }

    return {
      activeContracts,
      pendingReview,
      eligiblePayouts,
      totalMinor,
    };
  }, [contracts]);

  return (
    <div className="min-h-screen bg-[#090B0A] text-[#F1F0E8] relative selection:bg-[#C6F36A]/20 selection:text-[#C6F36A]">
      <div className="pointer-events-none fixed inset-0 bg-terminal-grid opacity-40 z-0" />
      <Navbar user={user} systemStatus={systemStatus} onUserUpdated={setUser} />

      {sessionLoading ? (
        <div className="mx-auto max-w-7xl px-6 py-28 text-center text-xs font-mono text-[#858F87] flex items-center justify-center gap-2">
          <svg className="animate-spin h-4 w-4 text-[#C6F36A]" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          <span>VERIFYING CRYPTOGRAPHIC SESSION...</span>
        </div>
      ) : !user ? (
        <AuthGate
          systemStatus={systemStatus}
          onAuthenticated={(u) => setUser(u)}
          returnTo="/dashboard"
        />
      ) : (
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-8 relative z-10">
          {/* Header & Terminal Actions */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-[rgba(241,240,232,0.08)] pb-6">
            <div>
              <div className="inline-flex items-center gap-2 rounded-md border border-[#C6F36A]/30 bg-[#C6F36A]/10 px-2.5 py-0.5 text-[10px] font-mono text-[#C6F36A] mb-2">
                <span className="h-1.5 w-1.5 rounded-full bg-[#C6F36A]" />
                OPERATIONS TERMINAL
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-[#F1F0E8] tracking-tight">
                Contract &amp; Milestone Workspace
              </h1>
              <p className="mt-1 text-xs sm:text-sm text-[#858F87]">
                Manage verifiable contracts, harvest GitHub pull request evidence, run AI advisory evaluations, and execute PayPal Sandbox payouts.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={seedingSample}
                onClick={handleCreateSampleContract}
                className="rounded-xl border border-[#8FE0A5]/40 bg-[#171C19] px-4 py-2.5 text-xs font-semibold text-[#8FE0A5] hover:bg-[#1D241F] hover:border-[#8FE0A5] transition-all disabled:opacity-50 shadow-sm"
              >
                {seedingSample ? "Deploying Sample..." : "+ 1-Click Demo Contract"}
              </button>

              <button
                type="button"
                onClick={() => setShowCreateForm((v) => !v)}
                className="rounded-xl bg-[#C6F36A] px-4.5 py-2.5 text-xs font-bold text-[#090B0A] hover:bg-[#B5E358] transition-all shadow-md shadow-[#C6F36A]/15 hover:-translate-y-0.5 active:translate-y-0"
              >
                {showCreateForm ? "Close Drawer" : "+ New Contract"}
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-[#E77D70]/40 bg-[#E77D70]/10 px-4 py-3 text-xs text-[#E77D70] flex items-center gap-2">
              <svg className="w-4 h-4 text-[#E77D70] shrink-0" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
                <path d="M7.002 11a1 1 0 1 1 2 0 1 1 0 0 1-2 0zM7.1 4.995a.905.905 0 1 1 1.8 0l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995z" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {successMsg && (
            <div className="rounded-xl border border-[#8FE0A5]/40 bg-[#8FE0A5]/10 px-4 py-3 text-xs text-[#8FE0A5] flex items-center gap-2">
              <svg className="w-4 h-4 text-[#8FE0A5] shrink-0" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
              </svg>
              <span>{successMsg}</span>
            </div>
          )}

          {/* KPI Financial Metric Summary Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-2xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-5 fintech-card-hover">
              <div className="text-[11px] font-mono uppercase tracking-wider text-[#858F87]">
                TOTAL CONTRACTS
              </div>
              <div className="mt-2 text-3xl font-extrabold font-mono text-[#F1F0E8] tabular-nums">
                {contracts.length}
              </div>
              <div className="mt-1 text-[11px] text-[#858F87]">
                {stats.activeContracts} active or draft
              </div>
            </div>

            <div className="rounded-2xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-5 fintech-card-hover">
              <div className="text-[11px] font-mono uppercase tracking-wider text-[#858F87]">
                PENDING VERIFICATION
              </div>
              <div className="mt-2 text-3xl font-extrabold font-mono text-[#E9B85D] tabular-nums">
                {stats.pendingReview}
              </div>
              <div className="mt-1 text-[11px] text-[#858F87]">
                Harvested PRs awaiting policy run
              </div>
            </div>

            <div className="rounded-2xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-5 fintech-card-hover">
              <div className="text-[11px] font-mono uppercase tracking-wider text-[#858F87]">
                ELIGIBLE FOR PAYOUT
              </div>
              <div className="mt-2 text-3xl font-extrabold font-mono text-[#C6F36A] tabular-nums">
                {stats.eligiblePayouts}
              </div>
              <div className="mt-1 text-[11px] text-[#858F87]">
                Certified by deterministic policy
              </div>
            </div>

            <div className="rounded-2xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-5 fintech-card-hover">
              <div className="text-[11px] font-mono uppercase tracking-wider text-[#858F87]">
                AGGREGATE VOLUME
              </div>
              <div className="mt-2 text-3xl font-extrabold font-mono text-[#8FE0A5] tabular-nums">
                {formatMinorUnits(stats.totalMinor, "USD")}
              </div>
              <div className="mt-1 text-[11px] text-[#858F87]">
                Non-custodial tracked volume
              </div>
            </div>
          </div>

          {/* Create Contract Drawer/Form */}
          {showCreateForm && (
            <form
              onSubmit={handleCreateContract}
              className="rounded-2xl border border-[rgba(241,240,232,0.16)] bg-[#111512] p-6 sm:p-7 space-y-5 shadow-2xl relative overflow-hidden"
            >
              <div className="h-0.5 w-full bg-gradient-to-r from-[#C6F36A] via-[#8FE0A5] to-transparent absolute top-0 left-0" />
              <div className="flex items-center justify-between border-b border-[rgba(241,240,232,0.08)] pb-3">
                <div>
                  <h2 className="text-base font-bold text-[#F1F0E8]">Create Verifiable Contract</h2>
                  <p className="text-xs text-[#858F87]">
                    You ({user.name}) will be recorded as Contract Client. Developer will be granted milestone submission rights.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-mono text-[#B9C5B5] mb-1.5">
                    Contract Title
                  </label>
                  <input
                    required
                    minLength={3}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. PayPal Webhook Listener & Concurrency Guards"
                    className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] px-3.5 py-2.5 text-xs text-[#F1F0E8] placeholder-[#858F87] focus:border-[#C6F36A] focus:outline-none focus:ring-1 focus:ring-[#C6F36A] transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-xs font-mono text-[#B9C5B5] mb-1.5">
                    Assigned Developer Email
                  </label>
                  <input
                    required
                    type="email"
                    value={developerEmail}
                    onChange={(e) => setDeveloperEmail(e.target.value)}
                    placeholder="bob.dev@verirelease.demo"
                    className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] px-3.5 py-2.5 text-xs text-[#F1F0E8] placeholder-[#858F87] focus:border-[#C6F36A] focus:outline-none focus:ring-1 focus:ring-[#C6F36A] transition-colors"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-xs font-mono text-[#B9C5B5] mb-1.5">
                    Scope &amp; Acceptance Overview
                  </label>
                  <textarea
                    required
                    minLength={5}
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Specify contract deliverables, required GitHub repository, and verification criteria..."
                    className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] px-3.5 py-2.5 text-xs text-[#F1F0E8] placeholder-[#858F87] focus:border-[#C6F36A] focus:outline-none focus:ring-1 focus:ring-[#C6F36A] transition-colors"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-mono text-[#B9C5B5] mb-1.5">
                      Total Amount
                    </label>
                    <input
                      required
                      type="number"
                      step="0.01"
                      min="1"
                      value={totalAmountUsd}
                      onChange={(e) => setTotalAmountUsd(e.target.value)}
                      className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] px-3.5 py-2.5 text-xs font-mono text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none focus:ring-1 focus:ring-[#C6F36A] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-mono text-[#B9C5B5] mb-1.5">
                      Currency
                    </label>
                    <select
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value as "USD" | "EUR" | "GBP")}
                      className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] px-3.5 py-2.5 text-xs font-mono text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none focus:ring-1 focus:ring-[#C6F36A] transition-colors"
                    >
                      <option value="USD">USD ($)</option>
                      <option value="EUR">EUR (€)</option>
                      <option value="GBP">GBP (£)</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-mono text-[#B9C5B5] mb-1.5">
                      GitHub Repo Owner
                    </label>
                    <input
                      required
                      value={githubRepoOwner}
                      onChange={(e) => setGithubRepoOwner(e.target.value)}
                      placeholder="e.g. Karmansingh09"
                      className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] px-3.5 py-2.5 text-xs text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none focus:ring-1 focus:ring-[#C6F36A] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-mono text-[#B9C5B5] mb-1.5">
                      GitHub Repo Name
                    </label>
                    <input
                      required
                      value={githubRepoName}
                      onChange={(e) => setGithubRepoName(e.target.value)}
                      placeholder="e.g. VeriRelease"
                      className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] px-3.5 py-2.5 text-xs text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none focus:ring-1 focus:ring-[#C6F36A] transition-colors"
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="rounded-xl border border-[rgba(241,240,232,0.14)] bg-[#171C19] px-4 py-2 text-xs font-semibold text-[#858F87] hover:text-[#F1F0E8]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="rounded-xl bg-[#C6F36A] px-5 py-2 text-xs font-bold text-[#090B0A] hover:bg-[#B5E358] transition-all disabled:opacity-50"
                >
                  {creating ? "Creating Contract..." : "Register Contract →"}
                </button>
              </div>
            </form>
          )}

          {/* Filter Tabs & Terminal Control */}
          <div className="flex items-center justify-between border-b border-[rgba(241,240,232,0.08)] pb-3">
            <div className="flex items-center gap-2">
              {(["ALL", "CLIENT", "DEVELOPER"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setRoleFilter(tab)}
                  className={`rounded-xl px-3 py-1.5 text-xs font-mono font-medium transition-all ${
                    roleFilter === tab
                      ? "bg-[#171C19] text-[#C6F36A] border border-[#C6F36A]/30 shadow-sm"
                      : "text-[#858F87] hover:text-[#F1F0E8]"
                  }`}
                >
                  {tab === "ALL"
                    ? "All Contracts"
                    : tab === "CLIENT"
                      ? "As Client"
                      : "As Developer"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void loadContracts()}
              className="text-xs font-mono text-[#858F87] hover:text-[#C6F36A] transition-colors flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z" />
                <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z" />
              </svg>
              <span>Refresh</span>
            </button>
          </div>

          {/* Contract Cards */}
          {loadingContracts ? (
            <div className="py-16 text-center text-xs font-mono text-[#858F87] flex items-center justify-center gap-2">
              <svg className="animate-spin h-4 w-4 text-[#C6F36A]" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              <span>QUERYING ACTIVE CONTRACTS...</span>
            </div>
          ) : contracts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[rgba(241,240,232,0.12)] bg-[#111512]/50 p-12 text-center">
              <div className="mx-auto w-12 h-12 rounded-xl bg-[#171C19] border border-[rgba(241,240,232,0.10)] flex items-center justify-center text-[#858F87] mb-3">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <h3 className="text-base font-bold text-[#F1F0E8]">No contracts registered yet</h3>
              <p className="mt-1.5 text-xs text-[#858F87] max-w-md mx-auto">
                Click &ldquo;+ 1-Click Demo Contract&rdquo; above to immediately deploy a complete verification &amp; PayPal Sandbox workflow, or register a custom contract.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {contracts.map((contract) => {
                const isClient = contract.clientId === user.id;
                return (
                  <div
                    key={contract.id}
                    className="rounded-2xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-6 space-y-5 fintech-card-hover"
                  >
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                      <div>
                        <div className="flex flex-wrap items-center gap-2.5">
                          <Link
                            href={`/contracts/${contract.id}`}
                            className="text-lg font-bold text-[#F1F0E8] hover:text-[#C6F36A] transition-colors"
                          >
                            {contract.title}
                          </Link>
                          <StatusBadge status={contract.status} />
                          <span className="rounded bg-[#171C19] border border-[rgba(241,240,232,0.10)] px-2 py-0.5 text-[10px] font-mono text-[#B9C5B5]">
                            {isClient ? "ROLE: CLIENT" : "ROLE: DEVELOPER"}
                          </span>
                        </div>
                        <p className="mt-1.5 text-xs text-[#B9C5B5] max-w-3xl leading-relaxed">
                          {contract.description}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] font-mono text-[#858F87]">
                          <span>
                            Repo:{" "}
                            <span className="text-[#F1F0E8]">
                              {contract.githubRepoOwner}/{contract.githubRepoName}
                            </span>
                          </span>
                          <span>
                            Client: <span className="text-[#B9C5B5]">{contract.client.name}</span>
                          </span>
                          <span>
                            Dev: <span className="text-[#B9C5B5]">{contract.developer.name}</span>
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-col items-start md:items-end gap-2">
                        <div className="text-xl font-bold font-mono text-[#F1F0E8] tabular-nums">
                          {formatMinorUnits(contract.totalAmountMinorUnits, contract.currency)}
                        </div>
                        <Link
                          href={`/contracts/${contract.id}`}
                          className="rounded-xl border border-[rgba(241,240,232,0.14)] bg-[#171C19] px-3.5 py-1.5 text-xs font-semibold text-[#F1F0E8] hover:border-[#C6F36A]/50 hover:text-[#C6F36A] transition-all"
                        >
                          Manage Milestones →
                        </Link>
                      </div>
                    </div>

                    {/* Milestones Nested Grid */}
                    {contract.milestones.length > 0 && (
                      <div className="border-t border-[rgba(241,240,232,0.08)] pt-4">
                        <div className="mb-2.5 text-[10px] font-mono uppercase tracking-wider text-[#858F87]">
                          Milestones ({contract.milestones.length})
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                          {contract.milestones.map((m) => (
                            <Link
                              key={m.id}
                              href={`/milestones/${m.id}`}
                              className="rounded-xl border border-[rgba(241,240,232,0.08)] bg-[#171C19] p-4 hover:border-[#C6F36A]/40 transition-all flex flex-col justify-between gap-3 group"
                            >
                              <div>
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[11px] font-mono text-[#858F87]">
                                    #{m.orderIndex}
                                  </span>
                                  <StatusBadge status={m.status} />
                                </div>
                                <div className="mt-2 text-xs font-bold text-[#F1F0E8] group-hover:text-[#C6F36A] transition-colors">
                                  {m.title}
                                </div>
                              </div>

                              <div className="flex items-center justify-between pt-2 border-t border-[rgba(241,240,232,0.06)] text-xs font-mono">
                                <span className="font-bold text-[#8FE0A5] tabular-nums">
                                  {formatMinorUnits(m.amountMinorUnits, m.currency)}
                                </span>
                                <span className="text-[11px] text-[#858F87]">
                                  {m.latestPrNumber
                                    ? `PR #${m.latestPrNumber}`
                                    : `${m.criteriaCount ?? 0} criteria`}
                                </span>
                              </div>
                            </Link>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </main>
      )}
    </div>
  );
}
