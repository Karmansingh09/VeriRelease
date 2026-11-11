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
    <div className="min-h-screen bg-[#090B0A] text-[#F1F0E8] relative selection:bg-[#C6F36A]/20 selection:text-[#C6F36A]">
      <div className="pointer-events-none fixed inset-0 bg-terminal-grid opacity-40 z-0" />
      <Navbar user={user} systemStatus={systemStatus} onUserUpdated={setUser} />

      {sessionLoading ? (
        <div className="mx-auto max-w-6xl px-6 py-28 text-center text-xs font-mono text-[#858F87] flex items-center justify-center gap-2">
          <svg className="animate-spin h-4 w-4 text-[#C6F36A]" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          <span>VERIFYING CONTRACT SESSION...</span>
        </div>
      ) : !user ? (
        <AuthGate
          systemStatus={systemStatus}
          onAuthenticated={(u) => setUser(u)}
          returnTo={`/contracts/${contractId}`}
        />
      ) : loading && !contract ? (
        <div className="mx-auto max-w-6xl px-6 py-28 text-center text-xs font-mono text-[#858F87]">
          LOADING CONTRACT TOPOLOGY...
        </div>
      ) : !contract ? (
        <div className="mx-auto max-w-4xl px-6 py-20 text-center space-y-4">
          <div className="rounded-2xl border border-[#E77D70]/40 bg-[#E77D70]/10 p-6 text-xs text-[#E77D70]">
            {error ?? "Contract not found or access denied."}
          </div>
          <Link href="/dashboard" className="text-xs font-mono text-[#C6F36A] hover:underline">
            ← Return to Workspace
          </Link>
        </div>
      ) : (
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 space-y-7 relative z-10">
          <div className="flex items-center justify-between text-xs text-[#858F87]">
            <Link href="/dashboard" className="hover:text-[#F1F0E8] font-mono transition-colors flex items-center gap-1">
              <span>← Back to Workspace</span>
            </Link>
            <span className="font-mono text-[11px] text-[#858F87]">Contract ID: {contract.id}</span>
          </div>

          {error && (
            <div className="rounded-xl border border-[#E77D70]/40 bg-[#E77D70]/10 px-4 py-3 text-xs text-[#E77D70] flex items-center gap-2">
              <svg className="w-4 h-4 text-[#E77D70] shrink-0" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
              </svg>
              <span>{error}</span>
            </div>
          )}
          {notice && (
            <div className="rounded-xl border border-[#8FE0A5]/40 bg-[#8FE0A5]/10 px-4 py-3 text-xs text-[#8FE0A5] flex items-center gap-2">
              <svg className="w-4 h-4 text-[#8FE0A5] shrink-0" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
              </svg>
              <span>{notice}</span>
            </div>
          )}

          {/* Contract Overview Card */}
          <section className="rounded-2xl border border-[rgba(241,240,232,0.12)] bg-[#111512] p-6 sm:p-7 space-y-6 fintech-card-hover">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="text-2xl sm:text-3xl font-extrabold text-[#F1F0E8] tracking-tight">{contract.title}</h1>
                  <StatusBadge status={contract.status} size="md" />
                </div>
                <p className="mt-2 text-xs sm:text-sm text-[#B9C5B5] max-w-3xl leading-relaxed">{contract.description}</p>
              </div>
              <div className="text-left md:text-right">
                <div className="text-[11px] font-mono uppercase tracking-wider text-[#858F87]">TOTAL CONTRACT VALUE</div>
                <div className="mt-1 text-2xl sm:text-3xl font-bold font-mono text-[#F1F0E8] tabular-nums">
                  {formatMinorUnits(contract.totalAmountMinorUnits, contract.currency)}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-[rgba(241,240,232,0.08)] pt-5 text-xs">
              <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#171C19] p-4">
                <div className="font-mono text-[10px] uppercase text-[#858F87]">CONTRACT CLIENT</div>
                <div className="mt-1 font-bold text-[#F1F0E8]">{contract.client.name}</div>
                <div className="text-[#858F87] font-mono text-[11px]">{contract.client.email}</div>
              </div>

              <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#171C19] p-4">
                <div className="font-mono text-[10px] uppercase text-[#858F87]">ASSIGNED DEVELOPER</div>
                <div className="mt-1 font-bold text-[#F1F0E8]">{contract.developer.name}</div>
                <div className="text-[#858F87] font-mono text-[11px]">
                  {contract.developer.githubUsername
                    ? `@${contract.developer.githubUsername}`
                    : contract.developer.email}
                </div>
              </div>

              <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#171C19] p-4 flex flex-col justify-between">
                <div>
                  <div className="font-mono text-[10px] uppercase text-[#858F87]">GITHUB REPOSITORY</div>
                  <div className="mt-1 font-mono font-bold text-[#F1F0E8]">
                    {contract.githubRepoOwner}/{contract.githubRepoName}
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  {linkedRepo ? (
                    <span className="text-[11px] font-mono text-[#8FE0A5]">
                      ✓ App Verified (#{linkedRepo.repoId})
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={linkingRepo}
                      onClick={handleAssociateGitHubRepo}
                      className="text-[11px] font-mono text-[#C6F36A] hover:underline disabled:opacity-50"
                    >
                      {linkingRepo ? "Verifying..." : "Verify via GitHub App →"}
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
                <h2 className="text-lg font-bold text-[#F1F0E8]">
                  Contract Milestones ({contract.milestones.length})
                </h2>
                <p className="text-xs text-[#858F87]">
                  Each milestone locks its acceptance criteria via SHA-256 upon submission.
                </p>
              </div>
              {isClient && (
                <button
                  type="button"
                  onClick={() => setShowAddMilestone((v) => !v)}
                  className="rounded-xl bg-[#C6F36A] px-4 py-2 text-xs font-bold text-[#090B0A] hover:bg-[#B5E358] transition-all shadow-md shadow-[#C6F36A]/15"
                >
                  {showAddMilestone ? "Close Form" : "+ Add Milestone"}
                </button>
              )}
            </div>

            {showAddMilestone && isClient && (
              <form
                onSubmit={handleAddMilestone}
                className="rounded-2xl border border-[rgba(241,240,232,0.14)] bg-[#111512] p-6 space-y-5 shadow-2xl relative overflow-hidden"
              >
                <div className="h-0.5 w-full bg-gradient-to-r from-[#C6F36A] via-[#8FE0A5] to-transparent absolute top-0 left-0" />
                <h3 className="text-base font-bold text-[#F1F0E8]">
                  Add Milestone &amp; Immutable Acceptance Criteria
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-xs font-mono text-[#B9C5B5] mb-1.5">
                      Milestone Title
                    </label>
                    <input
                      required
                      minLength={3}
                      value={mTitle}
                      onChange={(e) => setMTitle(e.target.value)}
                      placeholder="e.g. Milestone 2: Webhook Verification"
                      className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] px-3.5 py-2 text-xs text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none focus:ring-1 focus:ring-[#C6F36A]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-mono text-[#B9C5B5] mb-1.5">
                      Payout Amount ({contract.currency})
                    </label>
                    <input
                      required
                      type="number"
                      step="0.01"
                      min="1"
                      value={mAmountUsd}
                      onChange={(e) => setMAmountUsd(e.target.value)}
                      className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] px-3.5 py-2 text-xs font-mono text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none focus:ring-1 focus:ring-[#C6F36A]"
                    />
                  </div>
                  <div className="md:col-span-3">
                    <label className="block text-xs font-mono text-[#B9C5B5] mb-1.5">
                      Milestone Description
                    </label>
                    <textarea
                      required
                      minLength={5}
                      rows={2}
                      value={mDescription}
                      onChange={(e) => setMDescription(e.target.value)}
                      placeholder="Specify acceptance scope, test criteria, and deliverables..."
                      className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] px-3.5 py-2 text-xs text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none focus:ring-1 focus:ring-[#C6F36A]"
                    />
                  </div>
                </div>

                {/* Criteria Builder */}
                <div className="space-y-3 border-t border-[rgba(241,240,232,0.08)] pt-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono uppercase tracking-wider text-[#858F87]">
                      Acceptance Criteria ({criteria.length})
                    </span>
                    <button
                      type="button"
                      onClick={addCriterionRow}
                      className="rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] px-3 py-1 text-xs font-mono text-[#F1F0E8] hover:border-[#C6F36A]/40 transition-colors"
                    >
                      + Add Criterion
                    </button>
                  </div>

                  {criteria.map((c, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-1 md:grid-cols-12 gap-3 rounded-xl border border-[rgba(241,240,232,0.08)] bg-[#171C19] p-3.5"
                    >
                      <div className="md:col-span-4">
                        <input
                          required
                          minLength={3}
                          value={c.title}
                          onChange={(e) => updateCriterionRow(idx, { title: e.target.value })}
                          placeholder="Criterion title"
                          className="w-full rounded-lg border border-[rgba(241,240,232,0.10)] bg-[#090B0A] px-2.5 py-1.5 text-xs text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none"
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
                          className="w-full rounded-lg border border-[rgba(241,240,232,0.10)] bg-[#090B0A] px-2.5 py-1.5 text-xs text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none"
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
                          className="w-full rounded-lg border border-[rgba(241,240,232,0.10)] bg-[#090B0A] px-2 py-1.5 text-xs font-mono text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none"
                        >
                          <option value="AUTOMATED_TEST">AUTOMATED_TEST</option>
                          <option value="FILE_CHANGE">FILE_CHANGE</option>
                          <option value="CODE_QUALITY">CODE_QUALITY</option>
                          <option value="SPECIFICATION">SPECIFICATION</option>
                          <option value="MANUAL_APPROVAL">MANUAL_APPROVAL</option>
                        </select>
                      </div>
                      <div className="md:col-span-2 flex items-center justify-between gap-2">
                        <label className="flex items-center gap-1.5 text-[11px] font-mono text-[#B9C5B5]">
                          <input
                            type="checkbox"
                            checked={c.isMandatory}
                            onChange={(e) =>
                              updateCriterionRow(idx, { isMandatory: e.target.checked })
                            }
                            className="accent-[#C6F36A]"
                          />
                          Mandatory
                        </label>
                        {criteria.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeCriterionRow(idx)}
                            className="text-xs text-[#E77D70] hover:underline"
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
                    className="rounded-xl border border-[rgba(241,240,232,0.12)] px-4 py-2 text-xs text-[#858F87] hover:text-[#F1F0E8]"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={addingMilestone}
                    className="rounded-xl bg-[#C6F36A] px-5 py-2 text-xs font-bold text-[#090B0A] hover:bg-[#B5E358] disabled:opacity-50"
                  >
                    {addingMilestone ? "Saving..." : "Lock & Save Milestone"}
                  </button>
                </div>
              </form>
            )}

            {contract.milestones.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[rgba(241,240,232,0.10)] bg-[#111512]/50 p-10 text-center text-xs text-[#858F87]">
                No milestones defined yet. {isClient ? "Click '+ Add Milestone' above to specify the first milestone deliverable." : "Waiting for client to define milestones."}
              </div>
            ) : (
              <div className="space-y-3">
                {contract.milestones.map((m) => (
                  <div
                    key={m.id}
                    className="rounded-2xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4 fintech-card-hover"
                  >
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className="font-mono text-xs text-[#858F87]">
                          Milestone #{m.orderIndex}
                        </span>
                        <h3 className="text-base font-bold text-[#F1F0E8]">{m.title}</h3>
                        <StatusBadge status={m.status} />
                      </div>
                      <p className="text-xs text-[#B9C5B5] max-w-2xl leading-relaxed">{m.description}</p>
                      <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono text-[#858F87] pt-1">
                        <span>{m.criteriaCount ?? 0} Acceptance Criteria</span>
                        {m.latestPrNumber && (
                          <span className="text-[#F1F0E8]">Latest PR #{m.latestPrNumber}</span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <div className="text-right mr-2">
                        <div className="text-base font-bold font-mono text-[#F1F0E8] tabular-nums">
                          {formatMinorUnits(m.amountMinorUnits, m.currency)}
                        </div>
                      </div>

                      {isClient && m.status === "DRAFT" && (
                        <button
                          type="button"
                          disabled={fundingId === m.id}
                          onClick={() => handleFundMilestone(m.id)}
                          className="rounded-xl border border-[#C6F36A]/30 bg-[#C6F36A]/10 px-3.5 py-2 text-xs font-semibold text-[#C6F36A] hover:bg-[#C6F36A]/20 transition-colors disabled:opacity-50"
                        >
                          {fundingId === m.id ? "Funding..." : "Fund Milestone"}
                        </button>
                      )}

                      <Link
                        href={`/milestones/${m.id}`}
                        className="rounded-xl bg-[#171C19] border border-[rgba(241,240,232,0.14)] px-4 py-2 text-xs font-semibold text-[#F1F0E8] hover:border-[#C6F36A]/50 hover:text-[#C6F36A] transition-all"
                      >
                        Open Workbench →
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
