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
  const [prNumber, setPrNumber] = useState("42");
  const [prCommitSha, setPrCommitSha] = useState("a1b2c3d4e5f678901234567890abcdef12345678");
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
      setPrUrl((prev) =>
        prev ||
        `https://github.com/${m.contract.githubRepoOwner}/${m.contract.githubRepoName}/pull/42`
      );

      // Load payments in parallel with latest evaluation if submissions exist
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
      setNotice(`Switched active session to ${res.user.name} (${res.user.role}).`);
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
      setNotice("Milestone funded (DRAFT -> FUNDED). Assigned developer can now submit a PR.");
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
      const num = parseInt(prNumber, 10);
      await apiFetch(`/api/milestones/${milestone.id}/submissions`, {
        method: "POST",
        body: JSON.stringify({
          prNumber: num,
          prCommitSha: prCommitSha.trim(),
          prUrl:
            prUrl.trim() ||
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
          : `Deterministic Policy Engine: FAIL -> ${res.outcome.decisionReason}`
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
      await apiFetch(`/api/submissions/${latestSub.id}/evidence`, {
        method: "POST",
        body: JSON.stringify({ milestoneId: milestone.id }),
      });
      setNotice("Fresh GitHub evidence snapshot harvested and SHA-256 hashed.");
      await loadMilestoneData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "GitHub API evidence sync failed");
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

  // Determine active lifecycle step index
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
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar user={user} systemStatus={systemStatus} onUserUpdated={setUser} />

      {sessionLoading ? (
        <div className="mx-auto max-w-7xl px-6 py-20 text-center text-sm text-slate-400">
          Loading session...
        </div>
      ) : !user ? (
        <AuthGate
          systemStatus={systemStatus}
          onAuthenticated={(u) => setUser(u)}
          returnTo={`/milestones/${milestoneId}`}
        />
      ) : loading && !milestone ? (
        <div className="mx-auto max-w-7xl px-6 py-20 text-center text-sm text-slate-400">
          Loading milestone workspace...
        </div>
      ) : !milestone ? (
        <div className="mx-auto max-w-4xl px-6 py-16 text-center space-y-4">
          <div className="rounded-xl border border-rose-800 bg-rose-950/50 p-6 text-sm text-rose-200">
            {error ?? "Milestone not found or access denied."}
          </div>
          <Link href="/dashboard" className="text-xs text-sky-400 hover:underline">
            &larr; Back to Workspace
          </Link>
        </div>
      ) : (
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-6">
          {/* Breadcrumbs */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
            <div className="flex items-center gap-2">
              <Link href="/dashboard" className="hover:text-white">
                Workspace
              </Link>
              <span>/</span>
              <Link href={`/contracts/${milestone.contract.id}`} className="hover:text-white">
                {milestone.contract.title}
              </Link>
              <span>/</span>
              <span className="text-slate-200 font-medium">Milestone #{milestone.orderIndex}</span>
            </div>
            <span className="font-mono text-[11px] text-slate-500">ID: {milestone.id}</span>
          </div>

          {error && (
            <div className="rounded-xl border border-rose-800 bg-rose-950/60 px-4 py-3 text-xs text-rose-200">
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded-xl border border-emerald-800 bg-emerald-950/60 px-4 py-3 text-xs text-emerald-200">
              {notice}
            </div>
          )}

          {/* Milestone Header + Stepper */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 space-y-6">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="text-2xl font-bold text-white">{milestone.title}</h1>
                  <StatusBadge status={milestone.status} size="md" />
                  {succeededTx && <StatusBadge status="SUCCEEDED" size="md" />}
                </div>
                <p className="mt-2 text-sm text-slate-300 max-w-3xl">{milestone.description}</p>
                <div className="mt-3 flex flex-wrap items-center gap-4 text-xs font-mono text-slate-400">
                  <span>
                    Repo:{" "}
                    <span className="text-sky-300">
                      {milestone.contract.githubRepoOwner}/{milestone.contract.githubRepoName}
                    </span>
                  </span>
                  <span>
                    Client: <span className="text-slate-200">{milestone.contract.client.name}</span>
                  </span>
                  <span>
                    Developer:{" "}
                    <span className="text-slate-200">{milestone.contract.developer.name}</span>
                  </span>
                </div>
              </div>

              <div className="text-left lg:text-right">
                <div className="text-xs font-mono text-slate-400">MILESTONE PAYOUT</div>
                <div className="mt-1 text-2xl font-bold font-mono text-emerald-300">
                  {formatMinorUnits(milestone.amountMinorUnits, milestone.currency)}
                </div>
                <div className="mt-1 text-[11px] font-mono text-slate-400">
                  {isClient
                    ? "Session Role: Contract Client"
                    : isDeveloper
                      ? "Session Role: Assigned Developer"
                      : "Session Role: Observer"}
                </div>
              </div>
            </div>

            {/* Progress Stepper */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 border-t border-slate-800">
              {LIFECYCLE_STEPS.map((step, idx) => {
                const completed = idx < currentStepIndex || (idx === 4 && Boolean(succeededTx));
                const current = idx === currentStepIndex && !(idx === 4 && Boolean(succeededTx));
                return (
                  <div
                    key={step}
                    className={`rounded-lg border px-3 py-2 text-[11px] font-mono ${
                      completed
                        ? "border-emerald-700/80 bg-emerald-950/50 text-emerald-300"
                        : current
                          ? "border-sky-500 bg-sky-950/60 text-white font-semibold"
                          : "border-slate-800 bg-slate-950/50 text-slate-500"
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
            {/* Main Column (Actions, Criteria, Evidence) */}
            <div className="lg:col-span-8 space-y-6">
              {/* Interactive Action Workbench */}
              <section className="rounded-2xl border border-sky-800/60 bg-slate-900/80 p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-white">Action Workbench</h2>
                  {systemStatus?.demoAuthEnabled && (
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="text-slate-400">Demo Quick-Switch:</span>
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => handleDemoSwitch("client")}
                        className="rounded border border-sky-800 bg-sky-950/60 px-2 py-1 text-sky-300 hover:bg-sky-900/70"
                      >
                        Act as Client
                      </button>
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => handleDemoSwitch("developer")}
                        className="rounded border border-violet-800 bg-violet-950/60 px-2 py-1 text-violet-300 hover:bg-violet-900/70"
                      >
                        Act as Developer
                      </button>
                    </div>
                  )}
                </div>

                {/* Stage 1: DRAFT -> FUNDED */}
                {milestone.status === "DRAFT" && (
                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-white">Fund This Milestone</div>
                      <p className="text-xs text-slate-400 mt-1">
                        Client authorization transitions the milestone from DRAFT to FUNDED so the
                        developer can submit deliverables.
                      </p>
                    </div>
                    {isClient ? (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={handleFund}
                        className="shrink-0 rounded-xl bg-sky-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
                      >
                        {busyAction === "fund" ? "Funding..." : "Fund Milestone"}
                      </button>
                    ) : (
                      <span className="text-xs font-mono text-amber-300">
                        Waiting for Client to fund milestone
                      </span>
                    )}
                  </div>
                )}

                {/* Stage 2: FUNDED / CHANGES_REQUESTED -> SUBMITTED */}
                {(milestone.status === "FUNDED" || milestone.status === "CHANGES_REQUESTED") && (
                  <div className="rounded-xl border border-violet-800/60 bg-slate-950/70 p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-white">
                          Submit GitHub Pull Request Deliverable
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5">
                          Freezes active acceptance criteria into an immutable SHA-256 snapshot.
                        </p>
                      </div>
                      {!isDeveloper && (
                        <span className="rounded bg-amber-950/70 border border-amber-800 px-2.5 py-1 text-[11px] font-mono text-amber-300">
                          Developer Action Required
                        </span>
                      )}
                    </div>

                    {isDeveloper ? (
                      <form onSubmit={handleSubmitPr} className="space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-[11px] text-slate-400 mb-1">
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
                              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-mono text-white"
                            />
                          </div>
                          <div className="sm:col-span-2">
                            <label className="block text-[11px] text-slate-400 mb-1">
                              40-Char Commit SHA
                            </label>
                            <input
                              required
                              pattern="^[0-9a-fA-F]{40}$"
                              value={prCommitSha}
                              onChange={(e) => setPrCommitSha(e.target.value)}
                              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-mono text-white"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">
                            GitHub Pull Request URL
                          </label>
                          <input
                            required
                            type="url"
                            value={prUrl}
                            onChange={(e) => setPrUrl(e.target.value)}
                            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-mono text-white"
                          />
                        </div>

                        <div className="flex justify-end">
                          <button
                            type="submit"
                            disabled={busyAction !== null}
                            className="rounded-xl bg-violet-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                          >
                            {busyAction === "submit" ? "Submitting PR..." : "Submit PR Deliverable"}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <p className="text-xs text-slate-400">
                        Switch to the assigned developer ({milestone.contract.developer.name}) to
                        submit a Pull Request.
                      </p>
                    )}
                  </div>
                )}

                {/* Stage 3: SUBMITTED -> AI + Deterministic Policy Evaluation */}
                {(milestone.status === "SUBMITTED" || milestone.status === "EVALUATING") &&
                  latestSubmission && (
                    <div className="rounded-xl border border-indigo-800/70 bg-slate-950/70 p-5 space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold text-white">
                            Run AI Evaluation &amp; Deterministic Policy Verification
                          </div>
                          <p className="text-xs text-slate-400 mt-1">
                            AI assesses PR #{latestSubmission.prNumber} evidence as untrusted input;
                            only the deterministic policy engine may authorize{" "}
                            <code className="text-emerald-300">ELIGIBLE_FOR_PAYOUT</code>.
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                          <button
                            type="button"
                            disabled={busyAction !== null}
                            onClick={handleEvaluate}
                            className="rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                          >
                            {busyAction === "evaluate"
                              ? "Evaluating..."
                              : "Run AI + Policy Verification"}
                          </button>

                          {isClient && (
                            <button
                              type="button"
                              onClick={() => setShowChangeForm((v) => !v)}
                              className="rounded-xl border border-orange-700/80 bg-orange-950/50 px-3.5 py-2.5 text-xs font-semibold text-orange-300 hover:bg-orange-900/50"
                            >
                              Request Changes
                            </button>
                          )}
                        </div>
                      </div>

                      {showChangeForm && isClient && (
                        <form
                          onSubmit={handleRequestChanges}
                          className="pt-3 border-t border-slate-800 flex flex-col sm:flex-row gap-3"
                        >
                          <input
                            required
                            minLength={5}
                            value={changeReason}
                            onChange={(e) => setChangeReason(e.target.value)}
                            placeholder="Explain required revisions..."
                            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white"
                          />
                          <button
                            type="submit"
                            disabled={busyAction !== null}
                            className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500"
                          >
                            Send Change Request
                          </button>
                        </form>
                      )}
                    </div>
                  )}

                {/* Stage 4: ELIGIBLE_FOR_PAYOUT -> PayPal Sandbox Release */}
                {milestone.status === "ELIGIBLE_FOR_PAYOUT" && !succeededTx && (
                  <div className="rounded-xl border border-emerald-700/80 bg-emerald-950/25 p-5 space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-emerald-300">
                            Policy Approved: Ready for PayPal Sandbox Payout
                          </span>
                          <span className="rounded bg-slate-900 border border-slate-700 px-2 py-0.5 text-[10px] font-mono text-amber-300">
                            {systemStatus?.paypalMode === "mock"
                              ? "MOCK SANDBOX ADAPTER"
                              : "LIVE PAYPAL SANDBOX"}
                          </span>
                        </div>
                        <p className="text-xs text-slate-300 mt-1">
                          Authoritative Amount:{" "}
                          <strong className="font-mono text-white">
                            {formatMinorUnits(milestone.amountMinorUnits, milestone.currency)}
                          </strong>{" "}
                          &bull; Protected by PostgreSQL row locks &amp;{" "}
                          <code className="text-slate-200">PayPal-Request-Id</code> idempotency.
                        </p>
                      </div>
                    </div>

                    {uncertainTx ? (
                      <div className="rounded-lg border border-amber-700 bg-amber-950/60 p-3 text-xs text-amber-200">
                        Previous payout attempt is in <strong>{uncertainTx.status}</strong> state.
                        Blind retries are disabled to prevent duplicate settlement; operator
                        reconciliation is required.
                      </div>
                    ) : isClient ? (
                      <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3">
                        <div className="flex-1">
                          <label className="block text-[11px] text-slate-400 mb-1">
                            Developer PayPal Receiver Email (optional override)
                          </label>
                          <input
                            type="email"
                            value={devPayPalEmail}
                            onChange={(e) => setDevPayPalEmail(e.target.value)}
                            placeholder={milestone.contract.developer.email}
                            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500"
                          />
                        </div>
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={handleTriggerPayout}
                          className="rounded-xl bg-[#0070ba] px-6 py-2.5 text-xs font-semibold text-white hover:bg-[#005ea6] transition-colors shadow-lg disabled:opacity-50"
                        >
                          {busyAction === "payout"
                            ? "Settling via PayPal..."
                            : `Release ${formatMinorUnits(
                                milestone.amountMinorUnits,
                                milestone.currency
                              )} via PayPal`}
                        </button>
                      </div>
                    ) : (
                      <div className="text-xs font-mono text-amber-300">
                        Awaiting Contract Client ({milestone.contract.client.name}) to trigger
                        PayPal payout.
                      </div>
                    )}
                  </div>
                )}

                {/* Stage 5: Settled Banner */}
                {succeededTx && (
                  <div className="rounded-xl border border-emerald-700 bg-emerald-950/40 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-emerald-300">
                        ✓ Milestone Settled via PayPal Sandbox
                      </div>
                      <div className="mt-1 text-xs font-mono text-slate-300">
                        Order: {succeededTx.paypalOrderId} &bull; Capture:{" "}
                        {succeededTx.paypalCaptureId}
                      </div>
                    </div>
                    <div className="text-lg font-bold font-mono text-emerald-300">
                      {formatMinorUnits(succeededTx.amountMinorUnits, succeededTx.currency)}
                    </div>
                  </div>
                )}
              </section>

              {/* Acceptance Criteria & Evaluation Breakdown */}
              <section className="rounded-2xl border border-slate-800 bg-slate-900/75 p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-white">
                      Acceptance Criteria &amp; Policy Verdict ({milestone.criteria.length})
                    </h2>
                    <p className="text-xs text-slate-400">
                      Criteria Version v{milestone.activeCriteriaVersion}
                      {policyEvaluation?.receiptHash
                        ? ` • Policy Receipt: ${shortHash(policyEvaluation.receiptHash)}`
                        : ""}
                    </p>
                  </div>
                  {policyEvaluation?.decision && (
                    <StatusBadge status={policyEvaluation.decision} size="md" />
                  )}
                </div>

                {/* AI Summary Box if fresh or stored policy evaluation exists */}
                {(aiOutcome || policyEvaluation) && (
                  <div className="rounded-xl border border-slate-800 bg-slate-950/75 p-4 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-mono text-sky-300">
                        {aiOutcome
                          ? `AI Provider: ${aiOutcome.aiEvaluation.provider} (${aiOutcome.aiEvaluation.model})`
                          : `Deterministic Policy Engine v${policyEvaluation?.policyVersion ?? "1.0.0"}`}
                      </span>
                      {aiOutcome?.aiEvaluation.isDemoMode && (
                        <span className="rounded bg-amber-950/70 border border-amber-800 px-2 py-0.5 text-[10px] font-mono text-amber-300">
                          DEMO AI MODE (UNTRUSTED INPUT TO POLICY)
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      {aiOutcome?.aiEvaluation.overallAssessment ??
                        policyEvaluation?.decisionReason}
                    </p>
                    {policyEvaluation?.receiptHash && (
                      <div className="text-[11px] font-mono text-slate-400 pt-1">
                        RFC 8785 Receipt SHA-256:{" "}
                        <span className="text-emerald-300">{policyEvaluation.receiptHash}</span>
                      </div>
                    )}
                  </div>
                )}

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
                        className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-slate-500">
                              #{c.orderIndex}
                            </span>
                            <span className="text-sm font-semibold text-white">{c.title}</span>
                            <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-slate-300">
                              {c.criterionType}
                            </span>
                            {c.isMandatory && (
                              <span className="rounded bg-rose-950/70 border border-rose-800/70 px-2 py-0.5 text-[10px] font-mono text-rose-300">
                                MANDATORY
                              </span>
                            )}
                          </div>

                          {itemPassed !== undefined && (
                            <StatusBadge status={itemPassed ? "PASS" : "FAIL"} />
                          )}
                        </div>
                        <p className="text-xs text-slate-400">{c.description}</p>
                        {itemReason && (
                          <div className="mt-2 rounded-lg border border-slate-800/80 bg-slate-900/70 px-3 py-2 text-xs text-slate-300">
                            <span className="font-mono text-[10px] text-sky-400 uppercase mr-2">
                              Verification Finding:
                            </span>
                            {itemReason}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* GitHub PR Submissions & Evidence Snapshot */}
              <section className="rounded-2xl border border-slate-800 bg-slate-900/75 p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-white">
                    GitHub Submissions &amp; Evidence Snapshots ({milestone.submissions.length})
                  </h2>
                  {latestSubmission && (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={handleCollectEvidence}
                      className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                    >
                      {busyAction === "evidence" ? "Syncing..." : "Sync Live GitHub Evidence"}
                    </button>
                  )}
                </div>

                {evidenceSnapshot && (
                  <div className="rounded-xl border border-indigo-800/60 bg-indigo-950/20 p-4 space-y-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-indigo-300">
                        Evidence Snapshot v{evidenceSnapshot.snapshotVersion} — PR #
                        {evidenceSnapshot.prNumber}
                      </span>
                      <StatusBadge status={evidenceSnapshot.checksStatus} />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px] text-slate-300 pt-1">
                      <div>Commits: {evidenceSnapshot.commitCount}</div>
                      <div>
                        Branch: {evidenceSnapshot.headBranch} &rarr; {evidenceSnapshot.baseBranch}
                      </div>
                      <div>State: {evidenceSnapshot.prState}</div>
                    </div>
                    <div className="font-mono text-[11px] text-slate-400">
                      Evidence SHA-256: {evidenceSnapshot.evidenceHash}
                    </div>
                  </div>
                )}

                {milestone.submissions.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-xs text-slate-400">
                    No GitHub Pull Requests submitted yet.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {milestone.submissions.map((s) => (
                      <div
                        key={s.id}
                        className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2.5">
                            <span className="font-mono text-xs font-semibold text-white">
                              Submission #{s.submissionNumber} &bull; PR #{s.prNumber}
                            </span>
                            <StatusBadge status={s.status} />
                          </div>
                          <div className="text-[11px] font-mono text-slate-400">
                            SHA: {shortHash(s.prCommitSha, 10)} &bull; Criteria Hash:{" "}
                            {shortHash(s.criteriaHash, 10)}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-slate-500 font-mono text-[11px]">
                            {formatRelativeDate(s.submittedAt)}
                          </span>
                          <a
                            href={s.prUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-400 hover:underline font-mono text-xs"
                          >
                            View PR &rarr;
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            {/* Right Sidebar (PayPal Ledger + Audit Trail) */}
            <div className="lg:col-span-4 space-y-6">
              {/* PayPal Payment Transactions */}
              <section className="rounded-2xl border border-slate-800 bg-slate-900/75 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-white">PayPal Settlement Ledger</h2>
                  <span className="text-[10px] font-mono text-slate-400">
                    {payments.length} tx(s)
                  </span>
                </div>

                {payments.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-800 p-5 text-center text-xs text-slate-500">
                    No payment transactions reserved yet. Triggered only after deterministic
                    ELIGIBLE_FOR_PAYOUT approval.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {payments.map((tx) => (
                      <div
                        key={tx.id}
                        className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5 space-y-2 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px] text-slate-400">
                            Attempt #{tx.attemptNumber}
                          </span>
                          <StatusBadge status={tx.status} />
                        </div>
                        <div className="font-mono text-sm font-bold text-white">
                          {formatMinorUnits(tx.amountMinorUnits, tx.currency)}
                        </div>
                        <div className="space-y-1 text-[11px] font-mono text-slate-400">
                          <div>Order ID: {tx.paypalOrderId ?? "—"}</div>
                          <div>Capture ID: {tx.paypalCaptureId ?? "—"}</div>
                          <div>Idempotency: {shortHash(tx.idempotencyKey, 10)}</div>
                        </div>
                        {tx.errorMessage && (
                          <div className="rounded bg-rose-950/50 border border-rose-800/70 p-2 text-[11px] text-rose-200">
                            {tx.errorMessage}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Tamper-Evident Audit Timeline */}
              <section className="rounded-2xl border border-slate-800 bg-slate-900/75 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-white">Audit Timeline</h2>
                  <span className="text-[10px] font-mono text-slate-400">APPEND-ONLY LOG</span>
                </div>

                {milestone.auditTimeline.length === 0 ? (
                  <div className="text-xs text-slate-500">No audit records yet.</div>
                ) : (
                  <div className="space-y-3 max-h-[480px] overflow-y-auto pr-1">
                    {milestone.auditTimeline.map((log) => (
                      <div
                        key={log.id}
                        className="border-l-2 border-slate-700 pl-3 py-0.5 space-y-0.5"
                      >
                        <div className="text-xs font-mono font-semibold text-slate-200">
                          {log.action}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500">
                          {log.actorType} &bull; {formatRelativeDate(log.timestamp)}
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
