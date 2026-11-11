"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Navbar } from "../../../components/Navbar";
import { AuthGate } from "../../../components/AuthGate";
import { StatusBadge } from "../../../components/StatusBadge";
import { useSession } from "../../../hooks/useSession";
import {
  ApiClientError,
  apiFetch,
  formatMinorUnits,
  formatRelativeDate,
  shortHash,
  type EvaluationOutcomeResponse,
  type EvidenceSnapshotRecord,
  type MilestoneDetailView,
  type PaymentTransactionItem,
  type PolicyEvaluationRecord,
  type UserProfile,
} from "../../../lib/api-client";

const LIFECYCLE_STEPS = [
  "DRAFT",
  "FUNDED",
  "SUBMITTED",
  "ELIGIBLE_FOR_PAYOUT",
  "SETTLED",
] as const;

export default function MilestoneDetailPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const milestoneId = params.id;
  const { user, setUser, systemStatus, loading: sessionLoading } = useSession();

  const [milestone, setMilestone] = useState<MilestoneDetailView | null>(null);
  const [policyEvaluation, setPolicyEvaluation] = useState<PolicyEvaluationRecord | null>(null);
  const [evidenceSnapshot, setEvidenceSnapshot] = useState<EvidenceSnapshotRecord | null>(null);
  const [aiOutcome, setAiOutcome] = useState<EvaluationOutcomeResponse | null>(null);
  const [payments, setPayments] = useState<PaymentTransactionItem[]>([]);

  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Submission Form State
  const [prNumber, setPrNumber] = useState("1");
  const [prCommitSha, setPrCommitSha] = useState("");
  const [prUrl, setPrUrl] = useState("");

  // Request Changes Form State
  const [changeReason, setChangeReason] = useState("");
  const [showChangeForm, setShowChangeForm] = useState(false);

  // Payout Override State
  const [devPayPalEmail, setDevPayPalEmail] = useState("");

  const loadMilestoneData = useCallback(async () => {
    if (!user || !milestoneId) return;
    setLoading(true);
    setError(null);
    try {
      const mRes = await apiFetch<{ milestone: MilestoneDetailView }>(
        `/api/milestones/${milestoneId}`
      );
      const m = mRes.milestone;
      setMilestone(m);
      if (m.submissions.length > 0 && m.submissions[0]) {
        const topSub = m.submissions[0];
        setPrNumber(String(topSub.prNumber));
        setPrCommitSha(topSub.prCommitSha);
        setPrUrl((prev) => prev || topSub.prUrl);
      } else {
        setPrUrl((prev) =>
          prev ||
          `https://github.com/${m.contract.githubRepoOwner}/${m.contract.githubRepoName}/pull/1`
        );
      }

      const latestSub = m.submissions[0];
      const [payRes, evalRes] = await Promise.all([
        apiFetch<{ payments: PaymentTransactionItem[] }>(`/api/milestones/${milestoneId}/payout`).catch(
          () => ({ payments: [] })
        ),
        latestSub
          ? apiFetch<{
              latest: {
                policyEvaluation: PolicyEvaluationRecord | null;
                evidenceSnapshot: EvidenceSnapshotRecord | null;
              };
            }>(`/api/submissions/${latestSub.id}/evaluate`).catch(() => null)
          : Promise.resolve(null),
      ]);

      setPayments(payRes.payments);
      setPolicyEvaluation(evalRes?.latest?.policyEvaluation ?? null);
      setEvidenceSnapshot(evalRes?.latest?.evidenceSnapshot ?? null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load milestone details");
    } finally {
      setLoading(false);
    }
  }, [user, milestoneId]);

  useEffect(() => {
    if (user) {
      void loadMilestoneData();
    }
  }, [user, loadMilestoneData]);

  async function handleDemoSwitch(persona: "client" | "developer") {
    setBusyAction("switch");
    setError(null);
    try {
      const res = await apiFetch<{ user: UserProfile }>("/api/auth/demo-login", {
        method: "POST",
        body: JSON.stringify({ persona }),
      });
      setUser(res.user);
      setNotice(`Switched session to ${res.user.name} (${res.user.role}).`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to switch persona");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleFund() {
    if (!milestone) return;
    setBusyAction("fund");
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/milestones/${milestone.id}/fund`, { method: "POST" });
      setNotice("Milestone funded (DRAFT -> FUNDED). Assigned developer may now submit PR evidence.");
      await loadMilestoneData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to fund milestone");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSubmitPr(e: React.FormEvent) {
    e.preventDefault();
    if (!milestone) return;
    setBusyAction("submit");
    setError(null);
    setNotice(null);
    try {
      const trimmedUrl = prUrl.trim();
      if (trimmedUrl.includes("/issues/")) {
        setError("Invalid Pull Request URL: URL cannot contain '/issues/'. Provide a valid pull request URL (e.g. https://github.com/owner/repo/pull/123).");
        return;
      }
      const num = parseInt(prNumber, 10);
      if (isNaN(num) || num <= 0) {
        setError("Please enter a valid positive PR number.");
        return;
      }
      await apiFetch(`/api/milestones/${milestone.id}/submissions`, {
        method: "POST",
        body: JSON.stringify({
          prNumber: num,
          prCommitSha: prCommitSha.trim(),
          prUrl:
            trimmedUrl ||
            `https://github.com/${milestone.contract.githubRepoOwner}/${milestone.contract.githubRepoName}/pull/${num}`,
        }),
      });
      setNotice(`Pull Request #${num} submitted with frozen criteria snapshot.`);
      await loadMilestoneData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to submit PR");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleEvaluate() {
    if (!milestone || milestone.submissions.length === 0) return;
    const latestSub = milestone.submissions[0];
    if (!latestSub) return;

    setBusyAction("evaluate");
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{ outcome: EvaluationOutcomeResponse }>(
        `/api/submissions/${latestSub.id}/evaluate`,
        { method: "POST" }
      );
      setAiOutcome(res.outcome);
      setNotice(
        res.outcome.decision === "PASS"
          ? `Deterministic Policy Engine: PASS -> Milestone is now ${res.outcome.milestoneStatus}.`
          : `Deterministic Policy Engine: REFUSED -> ${res.outcome.decisionReason}`
      );
      await loadMilestoneData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to evaluate submission");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCollectEvidence() {
    if (!milestone || milestone.submissions.length === 0) return;
    const latestSub = milestone.submissions[0];
    if (!latestSub) return;

    setBusyAction("evidence");
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{
        status: string;
        evidenceSnapshot: EvidenceSnapshotRecord;
      }>(`/api/submissions/${latestSub.id}/evidence`, {
        method: "POST",
        body: JSON.stringify({ milestoneId: milestone.id }),
      });
      setEvidenceSnapshot(res.evidenceSnapshot);
      setNotice("Fresh GitHub evidence snapshot harvested and SHA-256 hashed.");
      await loadMilestoneData();
    } catch (err: unknown) {
      if (err instanceof ApiClientError) {
        if (err.status === 404) {
          setError("Pull request not found or inaccessible.");
        } else if (err.status === 403) {
          setError("GitHub access permission is insufficient.");
        } else if (err.status === 401) {
          setError("GitHub authentication needs to be refreshed.");
        } else {
          setError(err.message || "GitHub API evidence sync failed");
        }
      } else {
        setError(err instanceof Error ? err.message : "GitHub API evidence sync failed");
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRequestChanges(e: React.FormEvent) {
    e.preventDefault();
    if (!milestone) return;
    setBusyAction("changes");
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/milestones/${milestone.id}/request-changes`, {
        method: "POST",
        body: JSON.stringify({ reason: changeReason }),
      });
      setChangeReason("");
      setShowChangeForm(false);
      setNotice("Changes requested. Developer may submit a revised PR.");
      await loadMilestoneData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to request changes");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleTriggerPayout() {
    if (!milestone) return;
    setBusyAction("payout");
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{
        payout: {
          transaction: PaymentTransactionItem;
          paypalOrderId: string | null;
          paypalCaptureId: string | null;
          providerStatus: string;
          isDemoMode: boolean;
          message: string;
        };
      }>(`/api/milestones/${milestone.id}/payout`, {
        method: "POST",
        body: JSON.stringify(
          devPayPalEmail.trim() ? { developerPayPalEmail: devPayPalEmail.trim() } : {}
        ),
      });
      setNotice(
        `${res.payout.message} (Order: ${res.payout.paypalOrderId ?? "—"}, Capture: ${
          res.payout.paypalCaptureId ?? "—"
        })`
      );
      await loadMilestoneData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Payout execution failed");
    } finally {
      setBusyAction(null);
    }
  }

  const isClient = Boolean(user && milestone && milestone.contract.clientId === user.id);
  const isDeveloper = Boolean(user && milestone && milestone.contract.developerId === user.id);
  const latestSubmission = milestone?.submissions[0] ?? null;
  const succeededTx = payments.find((p) => p.status === "SUCCEEDED") ?? null;
  const uncertainTx = payments.find(
    (p) => p.status === "PAYOUT_UNCERTAIN" || p.status === "RECONCILIATION_REQUIRED"
  );

  const currentStepIndex = (() => {
    if (!milestone) return 0;
    if (succeededTx) return 4;
    switch (milestone.status) {
      case "DRAFT":
        return 0;
      case "FUNDED":
      case "CHANGES_REQUESTED":
        return 1;
      case "SUBMITTED":
      case "EVALUATING":
        return 2;
      case "ELIGIBLE_FOR_PAYOUT":
        return 3;
      default:
        return 1;
    }
  })();

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
          returnTo={`/milestones/${milestoneId}`}
        />
      ) : loading && !milestone ? (
        <div className="mx-auto max-w-7xl px-6 py-28 text-center text-xs font-mono text-[#858F87]">
          LOADING MILESTONE VERIFICATION WORKBENCH...
        </div>
      ) : !milestone ? (
        <div className="mx-auto max-w-4xl px-6 py-20 text-center space-y-4">
          <div className="rounded-2xl border border-[#E77D70]/40 bg-[#E77D70]/10 p-6 text-xs text-[#E77D70]">
            {error ?? "Milestone not found or access denied."}
          </div>
          <Link href="/dashboard" className="text-xs font-mono text-[#C6F36A] hover:underline">
            ← Return to Workspace
          </Link>
        </div>
      ) : (
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-6 relative z-10">
          {/* Breadcrumbs Navigation */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#858F87]">
            <div className="flex items-center gap-2">
              <Link href="/dashboard" className="hover:text-[#F1F0E8] font-mono transition-colors">
                Workspace
              </Link>
              <span>/</span>
              <Link href={`/contracts/${milestone.contract.id}`} className="hover:text-[#F1F0E8] font-mono transition-colors">
                {milestone.contract.title}
              </Link>
              <span>/</span>
              <span className="text-[#F1F0E8] font-mono font-bold">Milestone #{milestone.orderIndex}</span>
            </div>
            <span className="font-mono text-[11px] text-[#858F87]">ID: {milestone.id}</span>
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

          {/* Section A: Milestone Overview & Progress Stepper */}
          <section className="rounded-2xl border border-[rgba(241,240,232,0.12)] bg-[#111512] p-6 sm:p-7 space-y-6 fintech-card-hover">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="text-2xl sm:text-3xl font-extrabold text-[#F1F0E8] tracking-tight">{milestone.title}</h1>
                  <StatusBadge status={milestone.status} size="md" />
                  {succeededTx && <StatusBadge status="SUCCEEDED" size="md" />}
                </div>
                <p className="mt-2 text-xs sm:text-sm text-[#B9C5B5] max-w-3xl leading-relaxed">{milestone.description}</p>
                <div className="mt-3 flex flex-wrap items-center gap-4 text-xs font-mono text-[#858F87]">
                  <span>
                    Repo:{" "}
                    <span className="text-[#F1F0E8]">
                      {milestone.contract.githubRepoOwner}/{milestone.contract.githubRepoName}
                    </span>
                  </span>
                  <span>
                    Client: <span className="text-[#B9C5B5]">{milestone.contract.client.name}</span>
                  </span>
                  <span>
                    Developer:{" "}
                    <span className="text-[#B9C5B5]">{milestone.contract.developer.name}</span>
                  </span>
                </div>
              </div>

              <div className="text-left lg:text-right">
                <div className="text-[11px] font-mono uppercase tracking-wider text-[#858F87]">AUTHORIZED MILESTONE VALUE</div>
                <div className="mt-1 text-2xl sm:text-3xl font-bold font-mono text-[#F1F0E8] tabular-nums">
                  {formatMinorUnits(milestone.amountMinorUnits, milestone.currency)}
                </div>
                <div className="mt-1 text-[11px] font-mono text-[#858F87]">
                  {isClient
                    ? "Active Role: Contract Client"
                    : isDeveloper
                      ? "Active Role: Assigned Developer"
                      : "Active Role: Observer"}
                </div>
              </div>
            </div>

            {/* 5-Stage Verification Lifecycle Stepper */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-3 border-t border-[rgba(241,240,232,0.08)]">
              {LIFECYCLE_STEPS.map((step, idx) => {
                const completed = idx < currentStepIndex || (idx === 4 && Boolean(succeededTx));
                const current = idx === currentStepIndex && !(idx === 4 && Boolean(succeededTx));
                return (
                  <div
                    key={step}
                    className={`rounded-xl border px-3.5 py-2.5 text-[11px] font-mono transition-all ${
                      completed
                        ? "border-[#8FE0A5]/40 bg-[#171C19] text-[#8FE0A5]"
                        : current
                          ? "border-[#C6F36A] bg-[#171C19] text-[#C6F36A] font-bold shadow-md shadow-[#C6F36A]/5"
                          : "border-[rgba(241,240,232,0.08)] bg-[#090B0A] text-[#858F87]"
                    }`}
                  >
                    <div className="text-[10px] opacity-75">STAGE 0{idx + 1}</div>
                    <div className="mt-0.5 truncate">{step.replace(/_/g, " ")}</div>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Main Column (Action Workbench, Criteria, Evidence, AI & Policy) */}
            <div className="lg:col-span-8 space-y-6">
              {/* Interactive Action Workbench */}
              <section className="rounded-2xl border border-[rgba(241,240,232,0.12)] bg-[#111512] p-6 space-y-4 shadow-xl">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[rgba(241,240,232,0.08)] pb-3">
                  <div>
                    <h2 className="text-base font-bold text-[#F1F0E8]">Action Workbench</h2>
                    <p className="text-xs text-[#858F87]">Trigger next workflow phase based on cryptographic state.</p>
                  </div>
                  {systemStatus?.demoAuthEnabled && (
                    <div className="flex items-center gap-2 text-[11px] font-mono">
                      <span className="text-[#858F87]">Quick-Switch:</span>
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => handleDemoSwitch("client")}
                        className="rounded-lg border border-[rgba(241,240,232,0.12)] bg-[#171C19] px-2.5 py-1 text-[#F1F0E8] hover:border-[#C6F36A]/40 transition-colors"
                      >
                        Act as Client
                      </button>
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => handleDemoSwitch("developer")}
                        className="rounded-lg border border-[#C6F36A]/30 bg-[#C6F36A]/10 px-2.5 py-1 text-[#C6F36A] hover:bg-[#C6F36A]/20 transition-colors"
                      >
                        Act as Developer
                      </button>
                    </div>
                  )}
                </div>

                {/* Stage 1: DRAFT -> FUNDED */}
                {milestone.status === "DRAFT" && (
                  <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#171C19] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-bold text-[#F1F0E8]">Fund This Milestone</div>
                      <p className="text-xs text-[#858F87] mt-1">
                        Client authorization moves milestone from DRAFT to FUNDED so developer can submit code deliverables.
                      </p>
                    </div>
                    {isClient ? (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={handleFund}
                        className="shrink-0 rounded-xl bg-[#C6F36A] px-5 py-2.5 text-xs font-bold text-[#090B0A] hover:bg-[#B5E358] transition-all disabled:opacity-50"
                      >
                        {busyAction === "fund" ? "Funding..." : "Fund Milestone →"}
                      </button>
                    ) : (
                      <span className="text-xs font-mono text-[#E9B85D]">
                        Waiting for Client to fund milestone
                      </span>
                    )}
                  </div>
                )}

                {/* Section B: FUNDED / CHANGES_REQUESTED -> SUBMITTED (GitHub PR Form) */}
                {(milestone.status === "FUNDED" || milestone.status === "CHANGES_REQUESTED") && (
                  <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#171C19] p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-bold text-[#F1F0E8]">
                          Submit GitHub Pull Request Deliverable
                        </div>
                        <p className="text-xs text-[#858F87] mt-0.5">
                          Freezes active acceptance criteria into an immutable SHA-256 criteria hash.
                        </p>
                      </div>
                      {!isDeveloper && (
                        <span className="rounded-lg bg-[#E9B85D]/10 border border-[#E9B85D]/30 px-2.5 py-1 text-[10px] font-mono text-[#E9B85D]">
                          DEVELOPER ACTION REQUIRED
                        </span>
                      )}
                    </div>

                    {isDeveloper ? (
                      <form onSubmit={handleSubmitPr} className="space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-[11px] font-mono text-[#858F87] mb-1">
                              PR Number
                            </label>
                            <input
                              required
                              type="number"
                              min={1}
                              value={prNumber}
                              onChange={(e) => {
                                setPrNumber(e.target.value);
                                setPrUrl(
                                  `https://github.com/${milestone.contract.githubRepoOwner}/${milestone.contract.githubRepoName}/pull/${e.target.value}`
                                );
                              }}
                              className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#090B0A] px-3 py-2 text-xs font-mono text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none"
                            />
                          </div>
                          <div className="sm:col-span-2">
                            <label className="block text-[11px] font-mono text-[#858F87] mb-1">
                              40-Char Commit SHA
                            </label>
                            <input
                              required
                              pattern="^[0-9a-fA-F]{40}$"
                              value={prCommitSha}
                              onChange={(e) => setPrCommitSha(e.target.value)}
                              className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#090B0A] px-3 py-2 text-xs font-mono text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-[11px] font-mono text-[#858F87] mb-1">
                            GitHub Pull Request URL
                          </label>
                          <input
                            required
                            type="url"
                            value={prUrl}
                            onChange={(e) => setPrUrl(e.target.value)}
                            className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#090B0A] px-3 py-2 text-xs font-mono text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none"
                          />
                        </div>

                        <div className="flex justify-end">
                          <button
                            type="submit"
                            disabled={busyAction !== null}
                            className="rounded-xl bg-[#C6F36A] px-5 py-2.5 text-xs font-bold text-[#090B0A] hover:bg-[#B5E358] transition-all disabled:opacity-50"
                          >
                            {busyAction === "submit" ? "Submitting PR..." : "Submit PR Deliverable →"}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <p className="text-xs text-[#858F87]">
                        Switch to assigned developer ({milestone.contract.developer.name}) using quick-switch above to submit a Pull Request.
                      </p>
                    )}
                  </div>
                )}

                {/* Stage 3: SUBMITTED -> AI Advisory + Deterministic Policy Verification */}
                {(milestone.status === "SUBMITTED" || milestone.status === "EVALUATING") &&
                  latestSubmission && (
                    <div className="rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] p-5 space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-bold text-[#F1F0E8]">
                            Run AI Advisory Assessment &amp; Deterministic Policy Verification
                          </div>
                          <p className="text-xs text-[#858F87] mt-1 leading-relaxed">
                            AI evaluates PR #{latestSubmission.prNumber} code as advisory input. Only deterministic policy rules can authorize <code className="text-[#C6F36A]">ELIGIBLE_FOR_PAYOUT</code>.
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                          <button
                            type="button"
                            disabled={busyAction !== null}
                            onClick={handleEvaluate}
                            className="rounded-xl bg-[#C6F36A] px-5 py-2.5 text-xs font-bold text-[#090B0A] hover:bg-[#B5E358] transition-all disabled:opacity-50"
                          >
                            {busyAction === "evaluate"
                              ? "Evaluating..."
                              : "Execute Policy Engine →"}
                          </button>

                          {isClient && (
                            <button
                              type="button"
                              onClick={() => setShowChangeForm((v) => !v)}
                              className="rounded-xl border border-[#E9B85D]/40 bg-[#E9B85D]/10 px-3.5 py-2.5 text-xs font-semibold text-[#E9B85D] hover:bg-[#E9B85D]/20 transition-colors"
                            >
                              Request Changes
                            </button>
                          )}
                        </div>
                      </div>

                      {showChangeForm && isClient && (
                        <form
                          onSubmit={handleRequestChanges}
                          className="pt-3 border-t border-[rgba(241,240,232,0.08)] flex flex-col sm:flex-row gap-3"
                        >
                          <input
                            required
                            minLength={5}
                            value={changeReason}
                            onChange={(e) => setChangeReason(e.target.value)}
                            placeholder="Explain required code revisions or missing criteria..."
                            className="flex-1 rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#090B0A] px-3.5 py-2 text-xs text-[#F1F0E8] focus:border-[#C6F36A] focus:outline-none"
                          />
                          <button
                            type="submit"
                            disabled={busyAction !== null}
                            className="rounded-xl bg-[#E9B85D] px-4 py-2 text-xs font-bold text-[#090B0A] hover:bg-[#d8a84d] transition-colors"
                          >
                            Send Change Request
                          </button>
                        </form>
                      )}
                    </div>
                  )}

                {/* Section F: ELIGIBLE_FOR_PAYOUT -> Distinct Financial Panel for PayPal Settlement */}
                {milestone.status === "ELIGIBLE_FOR_PAYOUT" && !succeededTx && (
                  <div className="rounded-2xl border-2 border-[#C6F36A]/50 bg-[#171C19] p-6 space-y-4 shadow-xl shadow-[#C6F36A]/5 relative overflow-hidden">
                    <div className="h-1 w-full bg-gradient-to-r from-[#C6F36A] via-[#8FE0A5] to-transparent absolute top-0 left-0" />
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-base font-extrabold text-[#C6F36A]">
                            ✓ Policy Approved: Ready for PayPal Sandbox Payout
                          </span>
                          <span className="rounded bg-[#090B0A] border border-[rgba(241,240,232,0.12)] px-2 py-0.5 text-[10px] font-mono text-[#8FE0A5]">
                            {systemStatus?.paypalMode === "mock"
                              ? "MOCK SANDBOX ADAPTER"
                              : "LIVE PAYPAL SANDBOX"}
                          </span>
                        </div>
                        <p className="text-xs text-[#B9C5B5] mt-1.5 leading-relaxed">
                          Deterministic policy engine signed an immutable RFC 8785 receipt. Idempotent payout is now authorized for client release.
                        </p>
                      </div>
                    </div>

                    {uncertainTx ? (
                      <div className="rounded-xl border border-[#E9B85D]/40 bg-[#E9B85D]/10 p-3.5 text-xs text-[#E9B85D]">
                        Previous payout attempt is in <strong>{uncertainTx.status}</strong> state.
                        Blind retries are disabled to prevent duplicate settlement; operator reconciliation is required.
                      </div>
                    ) : isClient ? (
                      <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3 pt-2">
                        <div className="flex-1">
                          <label className="block text-[11px] font-mono text-[#858F87] mb-1">
                            Developer PayPal Receiver Email (optional override)
                          </label>
                          <input
                            type="email"
                            value={devPayPalEmail}
                            onChange={(e) => setDevPayPalEmail(e.target.value)}
                            placeholder={milestone.contract.developer.email}
                            className="w-full rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#090B0A] px-3.5 py-2.5 text-xs font-mono text-[#F1F0E8] placeholder-[#858F87] focus:border-[#C6F36A] focus:outline-none"
                          />
                        </div>
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={handleTriggerPayout}
                          className="rounded-xl bg-[#C6F36A] px-6 py-2.5 text-xs font-bold text-[#090B0A] hover:bg-[#B5E358] transition-all shadow-lg shadow-[#C6F36A]/20 disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                          {busyAction === "payout"
                            ? "Capturing via PayPal..."
                            : `Release ${formatMinorUnits(
                                milestone.amountMinorUnits,
                                milestone.currency
                              )} via PayPal →`}
                        </button>
                      </div>
                    ) : (
                      <div className="text-xs font-mono text-[#E9B85D]">
                        Awaiting Contract Client ({milestone.contract.client.name}) to execute PayPal settlement.
                      </div>
                    )}
                  </div>
                )}

                {/* Succeeded Banner */}
                {succeededTx && (
                  <div className="rounded-2xl border border-[#8FE0A5]/40 bg-[#171C19] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-bold text-[#8FE0A5] flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-[#8FE0A5]" />
                        <span>Milestone Settled via PayPal Sandbox</span>
                      </div>
                      <div className="mt-1 text-xs font-mono text-[#858F87]">
                        Order: {succeededTx.paypalOrderId ?? "—"} · Capture: {succeededTx.paypalCaptureId ?? "—"}
                      </div>
                    </div>
                    <div className="text-xl font-bold font-mono text-[#8FE0A5] tabular-nums">
                      {formatMinorUnits(succeededTx.amountMinorUnits, succeededTx.currency)}
                    </div>
                  </div>
                )}
              </section>

              {/* Section D & E: AI Evaluation Advisory (Subtle Sage) vs Deterministic Policy (Lime) */}
              <section className="rounded-2xl border border-[rgba(241,240,232,0.12)] bg-[#111512] p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-bold text-[#F1F0E8]">
                      Acceptance Criteria &amp; Policy Verdict ({milestone.criteria.length})
                    </h2>
                    <p className="text-xs text-[#858F87]">
                      Criteria Version v{milestone.activeCriteriaVersion}
                      {policyEvaluation?.receiptHash
                        ? ` · Policy Receipt: ${shortHash(policyEvaluation.receiptHash)}`
                        : ""}
                    </p>
                  </div>
                  {policyEvaluation?.decision && (
                    <StatusBadge status={policyEvaluation.decision} size="md" />
                  )}
                </div>

                {/* Section D: AI Advisory Assessment (Subtle Sage Identity) */}
                {aiOutcome && (
                  <div className="rounded-xl border border-[rgba(241,240,232,0.12)] bg-[#171C19] p-4 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-[#242C26] border border-[rgba(241,240,232,0.15)] px-2 py-0.5 text-[10px] font-mono text-[#B9C5B5]">
                          AI ADVISORY ASSISTANCE (UNTRUSTED INPUT)
                        </span>
                        <span className="font-mono text-[#858F87]">
                          {aiOutcome.aiEvaluation.provider} ({aiOutcome.aiEvaluation.model})
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-[#858F87]">
                        Action: {aiOutcome.aiEvaluation.suggestedAction}
                      </span>
                    </div>
                    <p className="text-xs text-[#B9C5B5] leading-relaxed">
                      {aiOutcome.aiEvaluation.overallAssessment}
                    </p>
                  </div>
                )}

                {/* Section E: Deterministic Policy Decision (Electric Lime Identity) */}
                {policyEvaluation && (
                  <div className="rounded-xl border border-[#C6F36A]/30 bg-[#171C19] p-4 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-[#C6F36A]/10 border border-[#C6F36A]/30 px-2 py-0.5 text-[10px] font-mono font-bold text-[#C6F36A]">
                          DETERMINISTIC POLICY ENGINE v{policyEvaluation.policyVersion}
                        </span>
                        <span className="font-mono text-[#C6F36A]">
                          Decision: {policyEvaluation.decision}
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-[#858F87]">
                        {formatRelativeDate(policyEvaluation.completedAt ?? policyEvaluation.createdAt)}
                      </span>
                    </div>
                    <p className="text-xs text-[#F1F0E8] leading-relaxed">
                      {policyEvaluation.decisionReason}
                    </p>
                    {policyEvaluation.receiptHash && (
                      <div className="text-[11px] font-mono text-[#858F87] pt-1 flex items-center justify-between">
                        <span>RFC 8785 Receipt Hash:</span>
                        <span className="text-[#C6F36A] break-all">{policyEvaluation.receiptHash}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Criteria List */}
                <div className="space-y-3">
                  {milestone.criteria.map((c) => {
                    const evalItem = policyEvaluation?.evaluations?.find(
                      (ev) => ev.criterionId === c.id
                    );
                    const aiItem = aiOutcome?.aiEvaluation.criterionAssessments.find(
                      (a) => a.criterionId === c.id
                    );
                    const itemPassed = evalItem?.passed ?? aiItem?.passed;
                    const itemReason = evalItem?.reason ?? aiItem?.reason;

                    return (
                      <div
                        key={c.id}
                        className="rounded-xl border border-[rgba(241,240,232,0.08)] bg-[#171C19] p-4 space-y-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-[#858F87]">
                              #{c.orderIndex}
                            </span>
                            <span className="text-sm font-bold text-[#F1F0E8]">{c.title}</span>
                            <span className="rounded bg-[#090B0A] border border-[rgba(241,240,232,0.08)] px-2 py-0.5 text-[10px] font-mono text-[#858F87]">
                              {c.criterionType}
                            </span>
                            {c.isMandatory && (
                              <span className="rounded bg-[#E77D70]/10 border border-[#E77D70]/30 px-2 py-0.5 text-[10px] font-mono text-[#E77D70]">
                                MANDATORY
                              </span>
                            )}
                          </div>

                          {itemPassed !== undefined && (
                            <StatusBadge status={itemPassed ? "PASS" : "FAIL"} />
                          )}
                        </div>
                        <p className="text-xs text-[#B9C5B5]">{c.description}</p>
                        {itemReason && (
                          <div className="mt-2 rounded-lg border border-[rgba(241,240,232,0.06)] bg-[#090B0A] px-3 py-2 text-xs text-[#B9C5B5]">
                            <span className="font-mono text-[10px] text-[#C6F36A] uppercase mr-2">
                              Finding:
                            </span>
                            {itemReason}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Section C: GitHub Submissions & Evidence Explorer */}
              <section className="rounded-2xl border border-[rgba(241,240,232,0.12)] bg-[#111512] p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-bold text-[#F1F0E8]">
                      GitHub Submissions &amp; Evidence Snapshots ({milestone.submissions.length})
                    </h2>
                    <p className="text-xs text-[#858F87]">Harvested commits, diff stats, and check runs.</p>
                  </div>
                  {latestSubmission && (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={handleCollectEvidence}
                      className="rounded-xl border border-[rgba(241,240,232,0.14)] bg-[#171C19] px-3.5 py-1.5 text-xs font-mono text-[#F1F0E8] hover:border-[#C6F36A]/40 transition-colors disabled:opacity-50"
                    >
                      {busyAction === "evidence" ? "Syncing..." : "Sync Live Evidence →"}
                    </button>
                  )}
                </div>

                {evidenceSnapshot && (
                  <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#171C19] p-4 space-y-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono font-bold text-[#F1F0E8]">
                        Evidence Snapshot v{evidenceSnapshot.snapshotVersion} — PR #{evidenceSnapshot.prNumber}
                      </span>
                      <div className="flex items-center gap-2">
                        {evidenceSnapshot.prUrl && (
                          <a
                            href={evidenceSnapshot.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[#C6F36A] hover:underline font-mono text-xs flex items-center gap-1"
                            title="Verified Pull Request"
                          >
                            <span>Verified PR ↗</span>
                          </a>
                        )}
                        <StatusBadge status={evidenceSnapshot.checksStatus} />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px] text-[#858F87] pt-1">
                      <div>Commits: {evidenceSnapshot.commitCount}</div>
                      <div>
                        Branch: {evidenceSnapshot.headBranch} → {evidenceSnapshot.baseBranch}
                      </div>
                      <div>State: {evidenceSnapshot.prState}</div>
                    </div>
                    <div className="font-mono text-[11px] text-[#858F87]">
                      Evidence SHA-256: <span className="text-[#F1F0E8] break-all">{evidenceSnapshot.evidenceHash}</span>
                    </div>
                  </div>
                )}

                {milestone.submissions.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[rgba(241,240,232,0.10)] p-6 text-center text-xs text-[#858F87]">
                    No GitHub Pull Requests submitted yet.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {milestone.submissions.map((s) => (
                      <div
                        key={s.id}
                        className="rounded-xl border border-[rgba(241,240,232,0.08)] bg-[#171C19] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2.5">
                            <span className="font-mono text-xs font-bold text-[#F1F0E8]">
                              Submission #{s.submissionNumber} · PR #{s.prNumber}
                            </span>
                            <StatusBadge status={s.status} />
                          </div>
                          <div className="text-[11px] font-mono text-[#858F87]">
                            SHA: {shortHash(s.prCommitSha, 10)} · Criteria Hash: {shortHash(s.criteriaHash, 10)}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-[#858F87] font-mono text-[11px]">
                            {formatRelativeDate(s.submittedAt)}
                          </span>
                          {s.isVerified && s.verifiedPrUrl ? (
                            <a
                              href={s.verifiedPrUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#C6F36A] hover:underline font-mono text-xs flex items-center gap-1"
                              title="Verified Pull Request from GitHub API"
                            >
                              <span>View PR →</span>
                            </a>
                          ) : (
                            <div className="flex items-center gap-2">
                              <span className="rounded bg-[#858F87]/15 border border-[#858F87]/30 px-1.5 py-0.5 text-[10px] font-mono text-[#858F87]">
                                Unverified PR
                              </span>
                              <button
                                type="button"
                                disabled
                                title="Evidence has not been verified from GitHub for this pull request. Click 'Sync Live Evidence' above to harvest and verify."
                                className="text-[#858F87] font-mono text-xs cursor-not-allowed opacity-60"
                              >
                                View PR (Disabled)
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            {/* Right Sidebar: Section F (PayPal Settlement Ledger) & Section G (Audit Timeline) */}
            <div className="lg:col-span-4 space-y-6">
              {/* Section F: PayPal Settlement Ledger */}
              <section className="rounded-2xl border border-[rgba(241,240,232,0.12)] bg-[#111512] p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold text-[#F1F0E8]">PayPal Settlement Ledger</h2>
                  <span className="text-[10px] font-mono text-[#858F87]">
                    {payments.length} RECORD(S)
                  </span>
                </div>

                {payments.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[rgba(241,240,232,0.10)] p-5 text-center text-xs text-[#858F87]">
                    No settlement records yet. Initiated only after deterministic ELIGIBLE_FOR_PAYOUT approval.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {payments.map((tx) => (
                      <div
                        key={tx.id}
                        className="rounded-xl border border-[rgba(241,240,232,0.08)] bg-[#171C19] p-3.5 space-y-2 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px] text-[#858F87]">
                            Attempt #{tx.attemptNumber}
                          </span>
                          <StatusBadge status={tx.status} />
                        </div>
                        <div className="font-mono text-base font-bold text-[#F1F0E8] tabular-nums">
                          {formatMinorUnits(tx.amountMinorUnits, tx.currency)}
                        </div>
                        <div className="space-y-1 text-[11px] font-mono text-[#858F87]">
                          <div>Order ID: {tx.paypalOrderId ?? "—"}</div>
                          <div>Capture ID: {tx.paypalCaptureId ?? "—"}</div>
                          <div>Idempotency: {shortHash(tx.idempotencyKey, 10)}</div>
                        </div>
                        {tx.errorMessage && (
                          <div className="rounded-lg bg-[#E77D70]/10 border border-[#E77D70]/30 p-2 text-[11px] text-[#E77D70]">
                            {tx.errorMessage}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Section G: Tamper-Evident Audit Timeline */}
              <section className="rounded-2xl border border-[rgba(241,240,232,0.12)] bg-[#111512] p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold text-[#F1F0E8]">Audit Timeline</h2>
                  <span className="text-[10px] font-mono text-[#8FE0A5]">IMMUTABLE LOG</span>
                </div>

                {milestone.auditTimeline.length === 0 ? (
                  <div className="text-xs text-[#858F87]">No audit entries recorded yet.</div>
                ) : (
                  <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
                    {milestone.auditTimeline.map((log) => (
                      <div
                        key={log.id}
                        className="border-l-2 border-[rgba(241,240,232,0.14)] hover:border-[#C6F36A] transition-colors pl-3 py-1 space-y-0.5"
                      >
                        <div className="text-xs font-mono font-semibold text-[#F1F0E8]">
                          {log.action}
                        </div>
                        <div className="text-[11px] font-mono text-[#858F87]">
                          {log.actorType} · {formatRelativeDate(log.timestamp)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
