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
      // Ensure target developer is distinct from current caller
      const targetDevEmail =
        user.email === "bob.dev@verirelease.demo"
          ? "sample.dev@verirelease.demo"
          : "bob.dev@verirelease.demo";

      const contractRes = await apiFetch<{ contract: { id: string } }>("/api/contracts", {
        method: "POST",
        body: JSON.stringify({
          title: "PayPal Checkout & Webhook Verifier",
          description:
            "Build idempotent PayPal Sandbox payout integration with automated CI verification and RFC 8785 audit receipts.",
          developerEmail: targetDevEmail,
          developerGithubUsername: "bob-verirelease",
          totalAmountUsd: "1000",
          currency: "USD",
          githubRepoOwner: "Karmansingh09",
          githubRepoName: "VeriRelease",
        }),
      });

      const contractId = contractRes.contract.id;

      const milestoneRes = await apiFetch<{ milestone: { id: string } }>(
        `/api/contracts/${contractId}/milestones`,
        {
          method: "POST",
          body: JSON.stringify({
            title: "Milestone 1: OAuth2 Settlement Engine",
            description:
              "Implement PayPal Orders v2 capture flow, row-lock reservation, and automated integration tests.",
            amountUsd: "500",
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
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar user={user} systemStatus={systemStatus} onUserUpdated={setUser} />

      {sessionLoading ? (
        <div className="mx-auto max-w-7xl px-6 py-20 text-center text-sm text-slate-400">
          Verifying session...
        </div>
      ) : !user ? (
        <AuthGate
          systemStatus={systemStatus}
          onAuthenticated={(u) => setUser(u)}
          returnTo="/dashboard"
        />
      ) : (
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-8">
          {/* Header & Actions */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-white">Contract &amp; Milestone Workspace</h1>
              <p className="mt-1 text-sm text-slate-400">
                Manage contracts, review GitHub PR evidence, run AI + deterministic policy
                evaluations, and execute PayPal Sandbox payouts.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={seedingSample}
                onClick={handleCreateSampleContract}
                className="rounded-xl border border-emerald-700/80 bg-emerald-950/60 px-4 py-2.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-900/60 transition-colors disabled:opacity-50"
              >
                {seedingSample ? "Creating Sample..." : "+ 1-Click Demo Contract & Funded Milestone"}
              </button>

              <button
                type="button"
                onClick={() => setShowCreateForm((v) => !v)}
                className="rounded-xl bg-sky-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-sky-500 transition-colors"
              >
                {showCreateForm ? "Close Form" : "+ New Contract"}
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-rose-800 bg-rose-950/50 px-4 py-3 text-xs text-rose-200">
              {error}
            </div>
          )}

          {successMsg && (
            <div className="rounded-xl border border-emerald-800 bg-emerald-950/50 px-4 py-3 text-xs text-emerald-200">
              {successMsg}
            </div>
          )}

          {/* KPI Summary Row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
              <div className="text-xs font-mono text-slate-400">CONTRACTS</div>
              <div className="mt-2 text-2xl font-bold text-white">{contracts.length}</div>
              <div className="mt-1 text-[11px] text-slate-500">
                {stats.activeContracts} active / draft
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
              <div className="text-xs font-mono text-slate-400">PENDING VERIFICATION</div>
              <div className="mt-2 text-2xl font-bold text-indigo-300">{stats.pendingReview}</div>
              <div className="mt-1 text-[11px] text-slate-500">
                Submitted PRs awaiting policy run
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
              <div className="text-xs font-mono text-slate-400">ELIGIBLE FOR PAYOUT</div>
              <div className="mt-2 text-2xl font-bold text-emerald-400">
                {stats.eligiblePayouts}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                Ready for PayPal Sandbox release
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
              <div className="text-xs font-mono text-slate-400">TOTAL CONTRACT VOLUME</div>
              <div className="mt-2 text-2xl font-bold text-sky-300">
                {formatMinorUnits(stats.totalMinor, "USD")}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                Authoritative integer minor units
              </div>
            </div>
          </div>

          {/* Create Contract Drawer/Form */}
          {showCreateForm && (
            <form
              onSubmit={handleCreateContract}
              className="rounded-2xl border border-sky-800/70 bg-slate-900/90 p-6 space-y-5 shadow-xl"
            >
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div>
                  <h2 className="text-base font-semibold text-white">Create New Contract</h2>
                  <p className="text-xs text-slate-400">
                    You ({user.name}) will be registered as the Contract Client.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Contract Title
                  </label>
                  <input
                    required
                    minLength={3}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. API Gateway & OAuth Integration"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Assigned Developer Email
                  </label>
                  <input
                    required
                    type="email"
                    value={developerEmail}
                    onChange={(e) => setDeveloperEmail(e.target.value)}
                    placeholder="bob.dev@verirelease.demo"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Scope &amp; Deliverables Description
                  </label>
                  <textarea
                    required
                    minLength={5}
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe deliverables, test expectations, and release criteria..."
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Total Amount
                    </label>
                    <input
                      required
                      type="number"
                      step="0.01"
                      min="1"
                      value={totalAmountUsd}
                      onChange={(e) => setTotalAmountUsd(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Currency
                    </label>
                    <select
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value as "USD" | "EUR" | "GBP")}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
                    >
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                      <option value="GBP">GBP</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      GitHub Repo Owner
                    </label>
                    <input
                      required
                      value={githubRepoOwner}
                      onChange={(e) => setGithubRepoOwner(e.target.value)}
                      placeholder="owner-or-org"
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      GitHub Repo Name
                    </label>
                    <input
                      required
                      value={githubRepoName}
                      onChange={(e) => setGithubRepoName(e.target.value)}
                      placeholder="repo-name"
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300 hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="rounded-lg bg-sky-600 px-5 py-2 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
                >
                  {creating ? "Creating..." : "Create Contract"}
                </button>
              </div>
            </form>
          )}

          {/* Filter Tabs */}
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              {(["ALL", "CLIENT", "DEVELOPER"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setRoleFilter(tab)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    roleFilter === tab
                      ? "bg-slate-800 text-white border border-slate-700"
                      : "text-slate-400 hover:text-white"
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
              className="text-xs text-slate-400 hover:text-sky-300"
            >
              Refresh
            </button>
          </div>

          {/* Contract Cards */}
          {loadingContracts ? (
            <div className="py-12 text-center text-sm text-slate-400">Loading contracts...</div>
          ) : contracts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-12 text-center">
              <h3 className="text-base font-semibold text-white">No contracts found</h3>
              <p className="mt-2 text-xs text-slate-400 max-w-md mx-auto">
                Click &ldquo;1-Click Demo Contract &amp; Funded Milestone&rdquo; above to spin up a
                complete verification &amp; PayPal Sandbox flow in seconds, or create a custom
                contract.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {contracts.map((contract) => {
                const isClient = contract.clientId === user.id;
                return (
                  <div
                    key={contract.id}
                    className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 space-y-5"
                  >
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                      <div>
                        <div className="flex flex-wrap items-center gap-2.5">
                          <Link
                            href={`/contracts/${contract.id}`}
                            className="text-lg font-semibold text-white hover:text-sky-300 transition-colors"
                          >
                            {contract.title}
                          </Link>
                          <StatusBadge status={contract.status} />
                          <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] font-mono text-slate-300">
                            {isClient ? "Your Role: Client" : "Your Role: Developer"}
                          </span>
                        </div>
                        <p className="mt-1.5 text-xs text-slate-400 max-w-3xl">
                          {contract.description}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] font-mono text-slate-400">
                          <span>
                            Repo:{" "}
                            <span className="text-sky-300">
                              {contract.githubRepoOwner}/{contract.githubRepoName}
                            </span>
                          </span>
                          <span>
                            Client: <span className="text-slate-200">{contract.client.name}</span>
                          </span>
                          <span>
                            Dev: <span className="text-slate-200">{contract.developer.name}</span>
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-col items-start md:items-end gap-2">
                        <div className="text-lg font-bold font-mono text-white">
                          {formatMinorUnits(contract.totalAmountMinorUnits, contract.currency)}
                        </div>
                        <Link
                          href={`/contracts/${contract.id}`}
                          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 transition-colors"
                        >
                          Manage Contract &amp; Milestones &rarr;
                        </Link>
                      </div>
                    </div>

                    {/* Milestones Grid */}
                    {contract.milestones.length > 0 && (
                      <div className="border-t border-slate-800 pt-4">
                        <div className="mb-2.5 text-[11px] font-mono uppercase tracking-wider text-slate-400">
                          Milestones ({contract.milestones.length})
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                          {contract.milestones.map((m) => (
                            <Link
                              key={m.id}
                              href={`/milestones/${m.id}`}
                              className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 hover:border-sky-700/80 hover:bg-slate-900 transition-all flex flex-col justify-between gap-3"
                            >
                              <div>
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[11px] font-mono text-slate-500">
                                    #{m.orderIndex}
                                  </span>
                                  <StatusBadge status={m.status} />
                                </div>
                                <div className="mt-2 text-sm font-semibold text-white">
                                  {m.title}
                                </div>
                              </div>

                              <div className="flex items-center justify-between pt-2 border-t border-slate-800/70 text-xs">
                                <span className="font-mono font-semibold text-emerald-300">
                                  {formatMinorUnits(m.amountMinorUnits, m.currency)}
                                </span>
                                <span className="text-[11px] text-slate-400">
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
