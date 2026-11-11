"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Navbar } from "../../../components/Navbar";
import { AuthGate } from "../../../components/AuthGate";
import { StatusBadge } from "../../../components/StatusBadge";
import { useSession } from "../../../hooks/useSession";
import {
  apiFetch,
  formatMinorUnits,
  type ContractSummary,
} from "../../../lib/api-client";

interface LinkedRepoMetadata {
  id: string;
  repoId: string;
  owner: string;
  name: string;
  fullName: string;
  installationId: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  htmlUrl: string;
}

type CriterionType =
  | "AUTOMATED_TEST"
  | "FILE_CHANGE"
  | "CODE_QUALITY"
  | "SPECIFICATION"
  | "MANUAL_APPROVAL";

interface DraftCriterion {
  title: string;
  description: string;
  criterionType: CriterionType;
  isMandatory: boolean;
}

export default function ContractDetailPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const contractId = params.id;
  const { user, setUser, systemStatus, loading: sessionLoading } = useSession();

  const [contract, setContract] = useState<ContractSummary | null>(null);
  const [linkedRepo, setLinkedRepo] = useState<LinkedRepoMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fundingId, setFundingId] = useState<string | null>(null);
  const [linkingRepo, setLinkingRepo] = useState(false);

  // Add Milestone form
  const [showAddMilestone, setShowAddMilestone] = useState(false);
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [mTitle, setMTitle] = useState("");
  const [mDescription, setMDescription] = useState("");
  const [mAmountUsd, setMAmountUsd] = useState("500");
  const [criteria, setCriteria] = useState<DraftCriterion[]>([
    {
      title: "Automated CI Tests Pass",
      description: "GitHub Actions test suite must succeed with zero failures.",
      criterionType: "AUTOMATED_TEST",
      isMandatory: true,
    },
    {
      title: "Code & File Changes Verified",
      description: "Pull request modifies target module files with clean commits.",
      criterionType: "FILE_CHANGE",
      isMandatory: true,
    },
  ]);

  const loadContract = useCallback(async () => {
    if (!user || !contractId) return;
    setLoading(true);
    setError(null);
    try {
      const [cRes, rRes] = await Promise.all([
        apiFetch<{ contract: ContractSummary }>(`/api/contracts/${contractId}`),
        apiFetch<{ repository: LinkedRepoMetadata }>(
          `/api/contracts/${contractId}/github-repo`
        ).catch(() => null),
      ]);
      setContract(cRes.contract);
      setLinkedRepo(rRes ? rRes.repository : null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load contract");
    } finally {
      setLoading(false);
    }
  }, [user, contractId]);

  useEffect(() => {
    if (user) {
      void loadContract();
    }
  }, [user, loadContract]);

  async function handleAddMilestone(e: React.FormEvent) {
    e.preventDefault();
    if (!contract) return;
    setError(null);
    setNotice(null);
    setAddingMilestone(true);
    try {
      await apiFetch(`/api/contracts/${contract.id}/milestones`, {
        method: "POST",
        body: JSON.stringify({
          title: mTitle,
          description: mDescription,
          amountUsd: mAmountUsd,
          currency: contract.currency,
          criteria,
        }),
      });
      setMTitle("");
      setMDescription("");
      setShowAddMilestone(false);
      setNotice("Milestone and immutable acceptance criteria created.");
      await loadContract();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to add milestone");
    } finally {
      setAddingMilestone(false);
    }
  }

  async function handleFundMilestone(milestoneId: string) {
    setError(null);
    setNotice(null);
    setFundingId(milestoneId);
    try {
      await apiFetch(`/api/milestones/${milestoneId}/fund`, { method: "POST" });
      setNotice("Milestone funded cleanly (DRAFT -> FUNDED). Developer may now submit a PR.");
      await loadContract();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to fund milestone");
    } finally {
      setFundingId(null);
    }
  }

  async function handleAssociateGitHubRepo() {
    if (!contract) return;
    setError(null);
    setNotice(null);
    setLinkingRepo(true);
    try {
      const res = await apiFetch<{ repository: LinkedRepoMetadata }>(
        `/api/contracts/${contract.id}/github-repo`,
        {
          method: "POST",
          body: JSON.stringify({
            owner: contract.githubRepoOwner,
            repo: contract.githubRepoName,
          }),
        }
      );
      setLinkedRepo(res.repository);
      setNotice(`GitHub App verified repository '${res.repository.fullName}'.`);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "GitHub App verification requires a connected GitHub token or installation"
      );
    } finally {
      setLinkingRepo(false);
    }
  }

  function addCriterionRow() {
    setCriteria((prev) => [
      ...prev,
      {
        title: "",
        description: "",
        criterionType: "SPECIFICATION",
        isMandatory: true,
      },
    ]);
  }

  function removeCriterionRow(idx: number) {
    setCriteria((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateCriterionRow(idx: number, patch: Partial<DraftCriterion>) {
    setCriteria((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }

  const isClient = Boolean(user && contract && contract.clientId === user.id);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar user={user} systemStatus={systemStatus} onUserUpdated={setUser} />

      {sessionLoading ? (
        <div className="mx-auto max-w-6xl px-6 py-20 text-center text-sm text-slate-400">
          Loading session...
        </div>
      ) : !user ? (
        <AuthGate
          systemStatus={systemStatus}
          onAuthenticated={(u) => setUser(u)}
          returnTo={`/contracts/${contractId}`}
        />
      ) : loading && !contract ? (
        <div className="mx-auto max-w-6xl px-6 py-20 text-center text-sm text-slate-400">
          Loading contract details...
        </div>
      ) : !contract ? (
        <div className="mx-auto max-w-4xl px-6 py-16 text-center space-y-4">
          <div className="rounded-xl border border-rose-800 bg-rose-950/50 p-6 text-sm text-rose-200">
            {error ?? "Contract not found or access denied."}
          </div>
          <Link href="/dashboard" className="text-xs text-sky-400 hover:underline">
            &larr; Back to Workspace
          </Link>
        </div>
      ) : (
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 space-y-7">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <Link href="/dashboard" className="hover:text-white transition-colors">
              &larr; Back to Workspace
            </Link>
            <span className="font-mono text-slate-500">Contract ID: {contract.id}</span>
          </div>

          {error && (
            <div className="rounded-xl border border-rose-800 bg-rose-950/50 px-4 py-3 text-xs text-rose-200">
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded-xl border border-emerald-800 bg-emerald-950/50 px-4 py-3 text-xs text-emerald-200">
              {notice}
            </div>
          )}

          {/* Contract Overview Card */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/75 p-6 space-y-5">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="text-2xl font-bold text-white">{contract.title}</h1>
                  <StatusBadge status={contract.status} size="md" />
                </div>
                <p className="mt-2 text-sm text-slate-300 max-w-3xl">{contract.description}</p>
              </div>
              <div className="text-left md:text-right">
                <div className="text-xs font-mono text-slate-400">TOTAL CONTRACT VALUE</div>
                <div className="mt-1 text-2xl font-bold font-mono text-emerald-300">
                  {formatMinorUnits(contract.totalAmountMinorUnits, contract.currency)}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-slate-800 pt-5 text-xs">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <div className="font-mono text-[11px] text-slate-400">CLIENT</div>
                <div className="mt-1 font-semibold text-white">{contract.client.name}</div>
                <div className="text-slate-400 font-mono text-[11px]">{contract.client.email}</div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <div className="font-mono text-[11px] text-slate-400">ASSIGNED DEVELOPER</div>
                <div className="mt-1 font-semibold text-white">{contract.developer.name}</div>
                <div className="text-slate-400 font-mono text-[11px]">
                  {contract.developer.githubUsername
                    ? `@${contract.developer.githubUsername}`
                    : contract.developer.email}
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 flex flex-col justify-between">
                <div>
                  <div className="font-mono text-[11px] text-slate-400">GITHUB REPOSITORY</div>
                  <div className="mt-1 font-mono font-semibold text-sky-300">
                    {contract.githubRepoOwner}/{contract.githubRepoName}
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  {linkedRepo ? (
                    <span className="text-[11px] font-mono text-emerald-400">
                      ✓ App Verified (#{linkedRepo.repoId})
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={linkingRepo}
                      onClick={handleAssociateGitHubRepo}
                      className="text-[11px] font-mono text-sky-400 hover:underline disabled:opacity-50"
                    >
                      {linkingRepo ? "Verifying..." : "Verify via GitHub App"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Milestones Section */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  Contract Milestones ({contract.milestones.length})
                </h2>
                <p className="text-xs text-slate-400">
                  Each milestone freezes its acceptance criteria via SHA-256 upon submission.
                </p>
              </div>
              {isClient && (
                <button
                  type="button"
                  onClick={() => setShowAddMilestone((v) => !v)}
                  className="rounded-xl bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500 transition-colors"
                >
                  {showAddMilestone ? "Close Form" : "+ Add Milestone"}
                </button>
              )}
            </div>

            {showAddMilestone && isClient && (
              <form
                onSubmit={handleAddMilestone}
                className="rounded-2xl border border-sky-800/70 bg-slate-900/90 p-6 space-y-5"
              >
                <h3 className="text-base font-semibold text-white">
                  Add Milestone &amp; Acceptance Criteria
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Milestone Title
                    </label>
                    <input
                      required
                      minLength={3}
                      value={mTitle}
                      onChange={(e) => setMTitle(e.target.value)}
                      placeholder="e.g. Milestone 2: Webhook Verification"
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Payout Amount ({contract.currency})
                    </label>
                    <input
                      required
                      type="number"
                      step="0.01"
                      min="1"
                      value={mAmountUsd}
                      onChange={(e) => setMAmountUsd(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                  <div className="md:col-span-3">
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Milestone Description
                    </label>
                    <textarea
                      required
                      minLength={5}
                      rows={2}
                      value={mDescription}
                      onChange={(e) => setMDescription(e.target.value)}
                      placeholder="Specify acceptance scope and deliverables..."
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Criteria Builder */}
                <div className="space-y-3 border-t border-slate-800 pt-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Acceptance Criteria ({criteria.length})
                    </span>
                    <button
                      type="button"
                      onClick={addCriterionRow}
                      className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1 text-xs text-slate-200 hover:bg-slate-700"
                    >
                      + Add Criterion
                    </button>
                  </div>

                  {criteria.map((c, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-1 md:grid-cols-12 gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-3.5"
                    >
                      <div className="md:col-span-4">
                        <input
                          required
                          minLength={3}
                          value={c.title}
                          onChange={(e) => updateCriterionRow(idx, { title: e.target.value })}
                          placeholder="Criterion title"
                          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-white focus:border-sky-500 focus:outline-none"
                        />
                      </div>
                      <div className="md:col-span-4">
                        <input
                          required
                          minLength={5}
                          value={c.description}
                          onChange={(e) =>
                            updateCriterionRow(idx, { description: e.target.value })
                          }
                          placeholder="Verification rule description"
                          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-white focus:border-sky-500 focus:outline-none"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <select
                          value={c.criterionType}
                          onChange={(e) =>
                            updateCriterionRow(idx, {
                              criterionType: e.target.value as CriterionType,
                            })
                          }
                          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white focus:border-sky-500 focus:outline-none"
                        >
                          <option value="AUTOMATED_TEST">AUTOMATED_TEST</option>
                          <option value="FILE_CHANGE">FILE_CHANGE</option>
                          <option value="CODE_QUALITY">CODE_QUALITY</option>
                          <option value="SPECIFICATION">SPECIFICATION</option>
                          <option value="MANUAL_APPROVAL">MANUAL_APPROVAL</option>
                        </select>
                      </div>
                      <div className="md:col-span-2 flex items-center justify-between gap-2">
                        <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
                          <input
                            type="checkbox"
                            checked={c.isMandatory}
                            onChange={(e) =>
                              updateCriterionRow(idx, { isMandatory: e.target.checked })
                            }
                          />
                          Mandatory
                        </label>
                        {criteria.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeCriterionRow(idx)}
                            className="text-xs text-rose-400 hover:text-rose-300"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setShowAddMilestone(false)}
                    className="rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={addingMilestone}
                    className="rounded-lg bg-sky-600 px-5 py-2 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
                  >
                    {addingMilestone ? "Saving..." : "Save Milestone"}
                  </button>
                </div>
              </form>
            )}

            {contract.milestones.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-10 text-center text-xs text-slate-400">
                No milestones added yet. {isClient ? "Click '+ Add Milestone' above to define the first deliverable." : "Waiting for client to define milestones."}
              </div>
            ) : (
              <div className="space-y-3">
                {contract.milestones.map((m) => (
                  <div
                    key={m.id}
                    className="rounded-2xl border border-slate-800 bg-slate-900/75 p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4"
                  >
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className="font-mono text-xs text-slate-500">
                          Milestone #{m.orderIndex}
                        </span>
                        <h3 className="text-base font-semibold text-white">{m.title}</h3>
                        <StatusBadge status={m.status} />
                      </div>
                      <p className="text-xs text-slate-400 max-w-2xl">{m.description}</p>
                      <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono text-slate-400 pt-1">
                        <span>{m.criteriaCount ?? 0} Acceptance Criteria</span>
                        {m.latestPrNumber && (
                          <span className="text-sky-300">Latest PR #{m.latestPrNumber}</span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <div className="text-right mr-2">
                        <div className="text-base font-bold font-mono text-emerald-300">
                          {formatMinorUnits(m.amountMinorUnits, m.currency)}
                        </div>
                      </div>

                      {isClient && m.status === "DRAFT" && (
                        <button
                          type="button"
                          disabled={fundingId === m.id}
                          onClick={() => handleFundMilestone(m.id)}
                          className="rounded-lg border border-sky-700 bg-sky-950/70 px-3.5 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-900/70 disabled:opacity-50"
                        >
                          {fundingId === m.id ? "Funding..." : "Fund Milestone"}
                        </button>
                      )}

                      <Link
                        href={`/milestones/${m.id}`}
                        className="rounded-lg bg-slate-800 border border-slate-700 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700 transition-colors"
                      >
                        Open Verification Workspace &rarr;
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
