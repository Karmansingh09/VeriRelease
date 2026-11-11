"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";

type Scenario = "HAPPY" | "CI_FAILS";

export default function HomePage(): React.ReactElement {
  const [activeStep, setActiveStep] = useState<number>(1);
  const [scenario, setScenario] = useState<Scenario>("HAPPY");
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isSettled, setIsSettled] = useState<boolean>(false);
  const [settleStage, setSettleStage] = useState<number>(0);
  const [copiedSha, setCopiedSha] = useState<boolean>(false);
  const [copiedReceipt, setCopiedReceipt] = useState<boolean>(false);
  const [selectedInspectorTab, setSelectedInspectorTab] = useState<"desc" | "evidence">("desc");
  const [showCriteriaModal, setShowCriteriaModal] = useState<boolean>(false);

  // Auto-play timer ref
  const autoPlayTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isPlaying) {
      autoPlayTimerRef.current = setInterval(() => {
        setActiveStep((prev) => (prev >= 5 ? 1 : prev + 1));
      }, 4200);
    } else if (autoPlayTimerRef.current) {
      clearInterval(autoPlayTimerRef.current);
    }
    return () => {
      if (autoPlayTimerRef.current) clearInterval(autoPlayTimerRef.current);
    };
  }, [isPlaying]);

  function handleScenarioChange(newScenario: Scenario) {
    setScenario(newScenario);
    setIsSettled(false);
    setSettleStage(0);
  }

  function handleStepChange(step: number) {
    setActiveStep(step);
    if (isPlaying) setIsPlaying(false);
  }

  function handleSimulateSettlement() {
    if (isSettled || settleStage > 0) return;
    setSettleStage(1);

    setTimeout(() => {
      setSettleStage(2);
      setTimeout(() => {
        setSettleStage(3);
        setTimeout(() => {
          setSettleStage(4);
          setIsSettled(true);
        }, 750);
      }, 750);
    }, 750);
  }

  function handleCopySha(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard?.writeText("9f84a1e7d230491823901bcae88412093847291a");
    setCopiedSha(true);
    setTimeout(() => setCopiedSha(false), 2000);
  }

  function handleCopyReceipt(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard?.writeText("sha256:d892a7e4b98129034fce1029487561928374a6b5c4d3e2f10987654321fedcba");
    setCopiedReceipt(true);
    setTimeout(() => setCopiedReceipt(false), 2000);
  }

  const getSubStatus = () => {
    if (activeStep === 1) return "Defined · Acceptance criteria locked with SHA-256";
    if (activeStep === 2) {
      return scenario === "HAPPY"
        ? "Submitted · PR #42 harvested (CI green)"
        : "Submitted · PR #42 harvested (CI failing)";
    }
    if (activeStep === 3) {
      return scenario === "HAPPY"
        ? "AI Advisory · 3/3 criteria verified (Untrusted input)"
        : "AI Advisory · Recommends approval (Untrusted note)";
    }
    if (activeStep === 4) {
      return scenario === "HAPPY"
        ? "Deterministic Policy · ELIGIBLE_FOR_PAYOUT (Receipt signed)"
        : "Deterministic Policy · REFUSED (CI check failed)";
    }
    if (activeStep === 5) {
      if (scenario === "HAPPY") {
        return isSettled
          ? "Settled · Captured via PayPal Sandbox (Orders v2)"
          : "Authorized · Ready for client PayPal payout trigger";
      }
      return "Settlement Locked · Deterministic policy refused payout";
    }
    return "Defined · Awaiting submission";
  };

  const stepDetails = [
    {
      step: 1,
      title: "Define",
      category: "CONTRACT SPECIFICATION",
      desc: "The client defines the contract and immutable acceptance criteria. Financial values live exclusively in PostgreSQL, never client-side.",
      tag: "BACKEND AUTHORITATIVE",
      tagColor: "border-[#C6F36A]/30 bg-[#C6F36A]/10 text-[#C6F36A]",
      codeSnippet: `// Milestone Specification (PostgreSQL 18 Authoritative)
{
  "contractId": "ctr_982410a8",
  "milestoneIndex": 2,
  "title": "Milestone 2 · PayPal Webhook Ingestion",
  "amountMinorUnits": 120000, // USD 1,200.00
  "currency": "USD",
  "criteriaHash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e464...",
  "criteria": [
    { "id": "AC-1", "spec": "Verify PayPal webhook HMAC signature against secret" },
    { "id": "AC-2", "spec": "Prevent race conditions using SELECT FOR UPDATE lock" },
    { "id": "AC-3", "spec": "Automated test suite passing in GitHub Actions CI" }
  ]
}`,
    },
    {
      step: 2,
      title: "Harvest",
      category: "CRYPTOGRAPHIC EVIDENCE",
      desc: "The developer opens a GitHub pull request. VeriRelease harvests commits, diff stats, and check runs into an immutable snapshot.",
      tag: "GITHUB EVIDENCE HARVEST",
      tagColor: "border-[#8FE0A5]/30 bg-[#8FE0A5]/10 text-[#8FE0A5]",
      codeSnippet: `// Ingested GitHub Pull Request Evidence
{
  "repository": "acme-fintech/core-payment-gateway",
  "pullRequestNumber": 42,
  "title": "feat(webhooks): idempotent paypal event ingest",
  "headSha": "9f84a1e7d230491823901bcae88412093847291a",
  "baseBranch": "main",
  "changedFiles": 4,
  "additions": 284,
  "deletions": 12,
  "checkRuns": [
    {
      "name": "ci/unit-tests",
      "status": "completed",
      "conclusion": "${scenario === "HAPPY" ? "success" : "failure"}"
    }
  ]
}`,
    },
    {
      step: 3,
      title: "Evaluate",
      category: "AI ADVISORY ASSISTANCE",
      desc: "AI evaluates code changes against each acceptance criterion. It provides advisory reasoning with zero financial authority.",
      tag: "ADVISORY ONLY · ZERO PAYMENT AUTHORITY",
      tagColor: "border-[#E9B85D]/30 bg-[#E9B85D]/10 text-[#E9B85D]",
      codeSnippet: `// AI Advisory Evaluation (LLM Technical Assessment)
{
  "confidenceScore": ${scenario === "HAPPY" ? "0.96" : "0.72"},
  "advisoryRecommendation": "${scenario === "HAPPY" ? "APPROVE" : "APPROVE_WITH_NOTE"}",
  "criteriaAssessment": [
    { "criterionId": "AC-1", "satisfied": true, "reason": "Webhook HMAC verification logic verified in src/webhooks.ts:42" },
    { "criterionId": "AC-2", "satisfied": true, "reason": "FOR UPDATE row lock verified in src/db.ts:108" },
    { "criterionId": "AC-3", "satisfied": ${scenario === "HAPPY" ? "true" : "false"}, "reason": "${
        scenario === "HAPPY"
          ? "All automated test runs passed on GitHub Actions"
          : "CI check indicates 2 test failures, but code logic appears sound."
      }" }
  ],
  "securityNotice": "Untrusted advisory input. Cannot trigger or authorize payouts."
}`,
    },
    {
      step: 4,
      title: "Authorize",
      category: "DETERMINISTIC GOVERNANCE",
      desc: "The deterministic policy engine independently validates criteria hashes and CI check runs, signing an RFC 8785 canonical receipt.",
      tag: "RFC 8785 CANONICAL SHA-256 RECEIPT",
      tagColor: "border-[#C6F36A]/30 bg-[#C6F36A]/10 text-[#C6F36A]",
      codeSnippet: `// Deterministic Policy Engine Decision
{
  "policyVersion": "2026.1",
  "decision": "${scenario === "HAPPY" ? "ELIGIBLE_FOR_PAYOUT" : "DISQUALIFIED"}",
  "rulesEvaluated": [
    { "rule": "CRITERIA_HASH_MATCH", "result": "PASS" },
    { "rule": "CI_CHECK_RUNS_GREEN", "result": "${scenario === "HAPPY" ? "PASS" : "FAIL"}" },
    { "rule": "COMMITS_ON_TARGET_BRANCH", "result": "PASS" }
  ],
  "canonicalSha256Receipt": "${
    scenario === "HAPPY"
      ? "sha256:d892a7e4b98129034fce1029487561928374a6b5c4d3e2f10987654321fedcba"
      : "sha256:e104f2981bc0934812304918230918239018239018230918230918230918231a"
  }",
  "immutableAuditLogged": true
}`,
    },
    {
      step: 5,
      title: "Settle",
      category: "NON-CUSTODIAL SETTLEMENT",
      desc: "Only an ELIGIBLE_FOR_PAYOUT decision unlocks client payout initiation. PayPal Sandbox captures funds idempotently via Orders v2.",
      tag: "IDEMPOTENT PAYPAL SANDBOX",
      tagColor: "border-[#8FE0A5]/30 bg-[#8FE0A5]/10 text-[#8FE0A5]",
      codeSnippet: `// PayPal Settlement Execution (Orders v2 API)
{
  "endpoint": "https://api-m.sandbox.paypal.com/v2/checkout/orders/PAYPAL_CAP_88192/capture",
  "headers": {
    "PayPal-Request-Id": "vr_idempotency_m2_9f84a1e",
    "Content-Type": "application/json"
  },
  "status": "${isSettled ? "COMPLETED" : scenario === "HAPPY" ? "READY_FOR_CAPTURE" : "BLOCKED_BY_POLICY"}",
  "payoutAmount": { "currency_code": "USD", "value": "1200.00" },
  "recipient": "bob.developer@verirelease.demo",
  "policyReceiptRef": "sha256:d892a7e4b9812903..."
}`,
    },
  ];

  const currentStep = (stepDetails[activeStep - 1] ?? stepDetails[0])!;

  return (
    <main className="min-h-screen bg-[#090B0A] text-[#F1F0E8] relative overflow-x-hidden selection:bg-[#C6F36A]/20 selection:text-[#C6F36A]">
      {/* Background Ambience: Fine Grid + Subtle Lime Accents */}
      <div className="pointer-events-none fixed inset-0 bg-terminal-grid opacity-60 z-0" />
      <div className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-[600px] ambient-glow-lime z-0" />
      <div className="pointer-events-none absolute top-[600px] right-0 w-[500px] h-[500px] ambient-glow-mint z-0" />

      {/* Top Header */}
      <header className="border-b border-[rgba(241,240,232,0.08)] bg-[#090B0A]/85 backdrop-blur-xl sticky top-0 z-50">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-3 group">
            {/* Geometric Interlocking Fintech Emblem */}
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#111512] border border-[#C6F36A]/30 text-[#C6F36A] shadow-sm shadow-[#C6F36A]/10 group-hover:border-[#C6F36A] transition-all">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold tracking-tight text-[#F1F0E8] group-hover:text-[#C6F36A] transition-colors">
                  VeriRelease
                </span>
                <span className="hidden sm:inline-flex rounded border border-[rgba(241,240,232,0.12)] bg-[#111512] px-2 py-0.5 text-[10px] font-mono text-[#858F87]">
                  PAYPAL AI HACKATHON
                </span>
              </div>
            </div>
          </Link>

          <div className="flex items-center gap-6 text-sm">
            <nav className="hidden md:flex items-center gap-6 text-xs text-[#858F87]">
              <a href="#how" className="hover:text-[#F1F0E8] transition-colors">
                How it works
              </a>
              <a href="#sim" className="hover:text-[#F1F0E8] transition-colors">
                Live simulation
              </a>
              <a href="#trust" className="hover:text-[#F1F0E8] transition-colors">
                Trust model
              </a>
            </nav>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#C6F36A] px-4 py-2 text-xs font-semibold text-[#090B0A] hover:bg-[#B5E358] transition-all shadow-md shadow-[#C6F36A]/15 hover:-translate-y-0.5 active:translate-y-0"
            >
              <span>Launch Workspace</span>
              <span className="font-mono">→</span>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative mx-auto max-w-6xl px-6 pt-20 pb-16 z-10">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-md border border-[#C6F36A]/30 bg-[#C6F36A]/10 px-3 py-1 text-xs font-mono text-[#C6F36A] mb-6 shadow-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-[#C6F36A] animate-pulse" />
            <span>AI EVALUATES · POLICY AUTHORIZES · PAYPAL SETTLES</span>
          </div>

          {/* Exact Required Editorial Headline */}
          <h1 className="text-4xl sm:text-6xl md:text-7xl font-extrabold tracking-tight text-[#F1F0E8] leading-[1.05]">
            Work delivered.
            <br />
            Proof established.
            <br />
            <span className="text-[#C6F36A]">Payments unlocked.</span>
          </h1>

          {/* Exact Required Supporting Copy */}
          <p className="mt-6 text-base sm:text-lg text-[#B9C5B5] leading-relaxed max-w-2xl">
            VeriRelease connects software development milestones with GitHub evidence,
            AI-assisted verification and deterministic payment authorization.
          </p>

          {/* Primary & Secondary CTAs */}
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link
              href="/dashboard"
              className="rounded-xl bg-[#C6F36A] px-6 py-3.5 text-xs font-bold text-[#090B0A] hover:bg-[#B5E358] transition-all shadow-lg shadow-[#C6F36A]/20 hover:-translate-y-0.5 active:translate-y-0"
            >
              Launch Workspace →
            </Link>
            <a
              href="#sim"
              className="rounded-xl border border-[rgba(241,240,232,0.16)] bg-[#111512] px-6 py-3.5 text-xs font-semibold text-[#F1F0E8] hover:bg-[#171C19] hover:border-[rgba(241,240,232,0.3)] transition-all hover:-translate-y-0.5 active:translate-y-0 shadow-sm"
            >
              Explore the Workflow
            </a>
          </div>
        </div>

        {/* 4 Architecture Pillars Grid */}
        <div className="mt-16 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-10 border-t border-[rgba(241,240,232,0.10)]">
          <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-4.5 fintech-card-hover">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-[#F1F0E8]">GitHub Evidence</span>
              <span className="text-[10px] font-mono uppercase text-[#858F87] bg-[#171C19] px-1.5 py-0.5 rounded border border-[rgba(241,240,232,0.08)]">
                INPUT
              </span>
            </div>
            <p className="text-xs text-[#B9C5B5] leading-relaxed">
              Cryptographic harvest of PRs, 40-char commit SHAs, and GitHub Actions CI check runs.
            </p>
          </div>

          <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-4.5 fintech-card-hover">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-[#F1F0E8]">AI Evaluates</span>
              <span className="text-[10px] font-mono uppercase text-[#E9B85D] bg-[#E9B85D]/10 px-1.5 py-0.5 rounded border border-[#E9B85D]/30">
                ADVISORY
              </span>
            </div>
            <p className="text-xs text-[#B9C5B5] leading-relaxed">
              Deep semantic evaluation across acceptance criteria with zero financial or payment authority.
            </p>
          </div>

          <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-4.5 fintech-card-hover">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-[#F1F0E8]">Policy Authorizes</span>
              <span className="text-[10px] font-mono uppercase text-[#C6F36A] bg-[#C6F36A]/10 px-1.5 py-0.5 rounded border border-[#C6F36A]/30">
                GOVERNANCE
              </span>
            </div>
            <p className="text-xs text-[#B9C5B5] leading-relaxed">
              Independent deterministic engine validates hashes and signs an immutable RFC 8785 receipt.
            </p>
          </div>

          <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-4.5 fintech-card-hover">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-[#F1F0E8]">PayPal Settles</span>
              <span className="text-[10px] font-mono uppercase text-[#8FE0A5] bg-[#8FE0A5]/10 px-1.5 py-0.5 rounded border border-[#8FE0A5]/30">
                SETTLEMENT
              </span>
            </div>
            <p className="text-xs text-[#B9C5B5] leading-relaxed">
              Client initiates payout; PostgreSQL row locks ensure safe, idempotent Orders v2 execution.
            </p>
          </div>
        </div>
      </section>

      {/* Realistic Interactive Product Simulation Section (#sim) */}
      <section id="sim" className="relative mx-auto max-w-6xl px-6 py-12 scroll-mt-20 z-10">
        <div className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl sm:text-3xl font-extrabold text-[#F1F0E8] tracking-tight">
                Interactive Verification &amp; Payout Workbench
              </h2>
              {/* Play / Pause Auto-play walkthrough */}
              <button
                type="button"
                onClick={() => setIsPlaying(!isPlaying)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#C6F36A]/30 bg-[#C6F36A]/10 px-2.5 py-1 text-[11px] font-mono text-[#C6F36A] hover:bg-[#C6F36A]/20 transition-colors"
                title={isPlaying ? "Pause auto-walkthrough" : "Auto-cycle full walkthrough"}
              >
                {isPlaying ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-[#C6F36A] animate-ping" />
                    <span>Pause</span>
                  </>
                ) : (
                  <>
                    <svg className="w-2.5 h-2.5 fill-current" viewBox="0 0 16 16">
                      <path d="m11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z" />
                    </svg>
                    <span>Auto-play (4.2s)</span>
                  </>
                )}
              </button>
            </div>

            <p className="mt-1.5 text-xs sm:text-sm text-[#858F87] max-w-2xl leading-relaxed">
              Step through a real milestone workflow. Switch to <strong className="text-[#E77D70]">&ldquo;CI fails&rdquo;</strong> to witness the AI model suggest approval while the deterministic policy engine strictly denies authorization.
            </p>
          </div>

          {/* Scenario Mode Toggle */}
          <div className="flex items-center gap-1.5 bg-[#111512] p-1.5 rounded-xl border border-[rgba(241,240,232,0.12)] self-start md:self-auto shadow-sm">
            <button
              type="button"
              onClick={() => handleScenarioChange("HAPPY")}
              className={`rounded-lg px-3 py-1.5 text-xs font-mono font-medium transition-all ${
                scenario === "HAPPY"
                  ? "bg-[#C6F36A]/15 text-[#C6F36A] border border-[#C6F36A]/35 shadow-sm"
                  : "text-[#858F87] hover:text-[#F1F0E8]"
              }`}
            >
              CI Passes (Happy Path)
            </button>
            <button
              type="button"
              onClick={() => handleScenarioChange("CI_FAILS")}
              className={`rounded-lg px-3 py-1.5 text-xs font-mono font-medium transition-all ${
                scenario === "CI_FAILS"
                  ? "bg-[#E77D70]/15 text-[#E77D70] border border-[#E77D70]/40 shadow-sm"
                  : "text-[#858F87] hover:text-[#F1F0E8]"
              }`}
            >
              CI Fails (AI vs Policy)
            </button>
          </div>
        </div>

        {/* 5-Stage Animated Workflow Stepper Bar */}
        <div className="mb-6 grid grid-cols-5 gap-2 text-center text-xs font-mono">
          {stepDetails.map((item) => {
            const isActive = activeStep === item.step;
            const isCompleted = activeStep > item.step;
            return (
              <button
                key={item.step}
                type="button"
                onClick={() => handleStepChange(item.step)}
                className={`relative py-2.5 px-2 rounded-xl border transition-all text-left flex flex-col justify-between ${
                  isActive
                    ? "border-[#C6F36A] bg-[#171C19] shadow-lg shadow-[#C6F36A]/5"
                    : isCompleted
                    ? "border-[#8FE0A5]/40 bg-[#111512] text-[#F1F0E8]"
                    : "border-[rgba(241,240,232,0.08)] bg-[#111512] text-[#858F87] hover:border-[rgba(241,240,232,0.18)]"
                }`}
              >
                <div className="flex items-center justify-between w-full mb-1">
                  <span className={`text-[10px] font-bold ${isActive ? "text-[#C6F36A]" : "text-[#858F87]"}`}>
                    0{item.step}
                  </span>
                  {isCompleted && (
                    <svg className="w-3 h-3 text-[#8FE0A5]" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
                    </svg>
                  )}
                  {isActive && (
                    <span className="h-1.5 w-1.5 rounded-full bg-[#C6F36A] animate-pulse" />
                  )}
                </div>
                <div className={`text-xs font-bold truncate ${isActive ? "text-[#F1F0E8]" : ""}`}>
                  {item.title}
                </div>
              </button>
            );
          })}
        </div>

        {/* The Main Simulation Terminal Card */}
        <div className="rounded-2xl border border-[rgba(241,240,232,0.14)] bg-[#111512] shadow-2xl overflow-hidden divide-y divide-[rgba(241,240,232,0.08)] backdrop-blur-sm">
          {/* Milestone Header */}
          <div className="p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#171C19]/50">
            <div>
              <div className="text-sm font-bold text-[#F1F0E8] flex items-center gap-2">
                <span>Milestone 2 · PayPal Webhook Ingestion</span>
                <span className="rounded bg-[#C6F36A]/10 border border-[#C6F36A]/30 px-2 py-0.5 text-[10px] font-mono text-[#C6F36A]">
                  SIMULATED CONTRACT
                </span>
              </div>
              <div className="text-xs text-[#858F87] mt-0.5 font-mono">
                contract_id: ctr_982410a8 · criteria_sha256: e3b0c442...
              </div>
            </div>

            {/* Quick trigger to inspect sample criteria */}
            <button
              type="button"
              onClick={() => setShowCriteriaModal(true)}
              className="text-xs text-[#C6F36A] hover:text-[#B5E358] font-mono flex items-center gap-1.5 underline decoration-[#C6F36A]/40 underline-offset-4"
            >
              <span>Inspect 3 Criteria Specs</span>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Amount Section with Tabular Numbers */}
          <div className="p-6 bg-[#090B0A]/40">
            <div className="text-[11px] font-mono uppercase tracking-wider text-[#858F87]">
              Milestone Escrow-Free Value
            </div>
            <div className="text-4xl sm:text-5xl font-mono font-bold text-[#F1F0E8] tracking-tight mt-1 tabular-nums flex items-baseline gap-2">
              <span>USD 1,200.00</span>
            </div>
            <div className="text-xs text-[#C6F36A] font-medium mt-2 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#C6F36A] animate-pulse" />
              <span>{getSubStatus()}</span>
            </div>
          </div>

          {/* Data Table Rows with Clean Fintech Styling */}
          <div
            onClick={() => setShowCriteriaModal(true)}
            className="px-6 py-3.5 flex items-center justify-between text-xs sm:text-sm hover:bg-[#171C19]/60 transition-colors cursor-pointer group"
          >
            <div className="flex items-center gap-2">
              <span className="text-[#858F87] group-hover:text-[#F1F0E8]">Acceptance Criteria</span>
              <span className="text-[10px] text-[#858F87] font-mono opacity-0 group-hover:opacity-100 transition-opacity">
                (click to inspect)
              </span>
            </div>
            <span className="rounded-md bg-[#171C19] border border-[rgba(241,240,232,0.12)] px-2.5 py-0.5 text-xs font-mono text-[#F1F0E8]">
              3 defined &amp; hashed
            </span>
          </div>

          <div className="px-6 py-3.5 flex items-center justify-between text-xs sm:text-sm hover:bg-[#171C19]/60 transition-colors">
            <span className="text-[#858F87]">GitHub Pull Request</span>
            <div className="flex items-center gap-2">
              {activeStep > 1 ? (
                <>
                  <span className="text-[#F1F0E8] font-mono text-xs">
                    #42: feat(webhooks) (9f84a1e)
                  </span>
                  <button
                    type="button"
                    onClick={handleCopySha}
                    className="text-[11px] font-mono text-[#858F87] hover:text-[#F1F0E8] px-2 py-0.5 rounded bg-[#171C19] border border-[rgba(241,240,232,0.12)] transition-colors"
                    title="Copy Commit SHA"
                  >
                    {copiedSha ? "Copied SHA!" : "Copy SHA"}
                  </button>
                </>
              ) : (
                <span className="text-[#858F87] font-mono">Awaiting submission</span>
              )}
            </div>
          </div>

          <div className="px-6 py-3.5 flex items-center justify-between text-xs sm:text-sm hover:bg-[#171C19]/60 transition-colors">
            <span className="text-[#858F87]">CI Check Runs (Automated)</span>
            {activeStep === 1 ? (
              <span className="text-[#858F87] font-mono">Awaiting run</span>
            ) : scenario === "HAPPY" ? (
              <span className="text-[#8FE0A5] font-mono font-medium flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5 text-[#8FE0A5]" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
                </svg>
                <span>Passed (14/14 tests green)</span>
              </span>
            ) : (
              <span className="text-[#E77D70] font-mono font-medium flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5 text-[#E77D70]" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                </svg>
                <span>Failed (2 test suites failing)</span>
              </span>
            )}
          </div>

          <div className="px-6 py-3.5 flex items-center justify-between text-xs sm:text-sm hover:bg-[#171C19]/60 transition-colors">
            <span className="text-[#858F87]">AI Model Assessment</span>
            {activeStep < 3 ? (
              <span className="text-[#858F87] font-mono">Awaiting step</span>
            ) : scenario === "HAPPY" ? (
              <span className="text-[#B9C5B5] font-mono flex items-center gap-1.5">
                <span className="rounded bg-[#171C19] border border-[rgba(241,240,232,0.12)] px-2 py-0.5 text-[11px] text-[#F1F0E8]">
                  Verified (3/3 Criteria) · Advisory
                </span>
              </span>
            ) : (
              <span className="text-[#E9B85D] font-mono flex items-center gap-1.5">
                <span className="rounded bg-[#E9B85D]/10 border border-[#E9B85D]/30 px-2 py-0.5 text-[11px] text-[#E9B85D]">
                  Recommend Approval (Advisory with Warning)
                </span>
              </span>
            )}
          </div>

          <div className="px-6 py-3.5 flex items-center justify-between text-xs sm:text-sm hover:bg-[#171C19]/60 transition-colors">
            <span className="text-[#858F87]">Deterministic Policy Decision</span>
            {activeStep < 4 ? (
              <span className="text-[#858F87] font-mono">Awaiting step</span>
            ) : scenario === "HAPPY" ? (
              <span className="text-[#C6F36A] font-mono font-bold tracking-wide">
                ELIGIBLE_FOR_PAYOUT
              </span>
            ) : (
              <span className="text-[#E77D70] font-mono font-bold tracking-wide">
                REFUSED (CI_FAILURE)
              </span>
            )}
          </div>

          <div className="px-6 py-3.5 flex items-center justify-between text-xs sm:text-sm hover:bg-[#171C19]/60 transition-colors">
            <span className="text-[#858F87]">Tamper-Evident Receipt</span>
            {activeStep < 4 ? (
              <span className="text-[#858F87] font-mono">Awaiting policy run</span>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-[#C6F36A] font-mono text-xs">
                  {scenario === "HAPPY" ? "sha256:d892a7...4c19" : "sha256:refusal...881a"}
                </span>
                <button
                  type="button"
                  onClick={handleCopyReceipt}
                  className="text-[11px] font-mono text-[#858F87] hover:text-[#F1F0E8] px-2 py-0.5 rounded bg-[#171C19] border border-[rgba(241,240,232,0.12)] transition-colors"
                  title="Copy RFC 8785 Receipt Hash"
                >
                  {copiedReceipt ? "Copied!" : "Copy"}
                </button>
              </div>
            )}
          </div>

          <div className="px-6 py-3.5 flex items-center justify-between text-xs sm:text-sm hover:bg-[#171C19]/60 transition-colors">
            <span className="text-[#858F87]">PayPal Settlement Execution</span>
            {activeStep < 4 ? (
              <span className="text-[#858F87] font-mono">Awaiting authorization</span>
            ) : scenario === "HAPPY" ? (
              activeStep === 4 ? (
                <span className="text-[#C6F36A] font-mono font-medium">Ready to initiate</span>
              ) : isSettled ? (
                <span className="text-[#8FE0A5] font-mono font-bold flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-[#8FE0A5]" />
                  CAPTURED (USD 1,200.00)
                </span>
              ) : (
                <span className="text-[#C6F36A] font-mono font-medium">Awaiting client payout trigger</span>
              )
            ) : (
              <span className="text-[#E77D70] font-mono font-bold">LOCKED BY POLICY</span>
            )}
          </div>

          {/* Stepper Navigation Controls */}
          <div className="px-6 py-4 flex items-center justify-between text-xs bg-[#090B0A]/80">
            <div className="flex items-center gap-2">
              <span className="text-[#858F87] font-mono">Jump to stage:</span>
              {isPlaying && (
                <span className="text-[10px] font-mono text-[#C6F36A] animate-pulse">
                  · Auto-cycling
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {[1, 2, 3, 4, 5].map((num) => (
                <button
                  key={num}
                  type="button"
                  onClick={() => handleStepChange(num)}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg border text-xs font-mono font-bold transition-all ${
                    activeStep === num
                      ? "border-[#C6F36A] bg-[#C6F36A] text-[#090B0A] shadow-md shadow-[#C6F36A]/30 scale-105"
                      : "border-[rgba(241,240,232,0.12)] bg-[#171C19] text-[#858F87] hover:border-[rgba(241,240,232,0.25)] hover:text-[#F1F0E8]"
                  }`}
                  aria-label={`Jump to Stage ${num}`}
                >
                  {num}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Step Explanation & Raw Payload Inspector */}
        <div className="mt-8 p-6 sm:p-7 rounded-2xl border border-[rgba(241,240,232,0.12)] bg-[#111512] shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[rgba(241,240,232,0.08)] pb-4">
            <div>
              <div className="text-[10px] font-mono font-bold uppercase text-[#C6F36A] tracking-wider">
                STAGE 0{currentStep.step} · {currentStep.category}
              </div>
              <h3 className="text-xl sm:text-2xl font-extrabold text-[#F1F0E8] mt-0.5">
                {currentStep.title}
              </h3>
            </div>

            {/* Inspector Toggle Tabs */}
            <div className="flex items-center gap-1 bg-[#171C19] p-1 rounded-lg border border-[rgba(241,240,232,0.10)] text-xs font-mono">
              <button
                type="button"
                onClick={() => setSelectedInspectorTab("desc")}
                className={`px-3 py-1 rounded-md transition-colors ${
                  selectedInspectorTab === "desc"
                    ? "bg-[#242C26] text-[#F1F0E8] font-bold"
                    : "text-[#858F87] hover:text-[#F1F0E8]"
                }`}
              >
                Architecture Concept
              </button>
              <button
                type="button"
                onClick={() => setSelectedInspectorTab("evidence")}
                className={`px-3 py-1 rounded-md transition-colors ${
                  selectedInspectorTab === "evidence"
                    ? "bg-[#C6F36A]/15 text-[#C6F36A] font-bold"
                    : "text-[#858F87] hover:text-[#F1F0E8]"
                }`}
              >
                Inspect Canonical JSON
              </button>
            </div>
          </div>

          {/* Tab 1: Description */}
          {selectedInspectorTab === "desc" && (
            <div className="pt-4">
              <p className="text-sm sm:text-base text-[#B9C5B5] leading-relaxed max-w-3xl">
                {currentStep.desc}
              </p>

              <div className="mt-4 flex items-center gap-2">
                <span
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider ${currentStep.tagColor}`}
                >
                  {currentStep.tag}
                </span>
              </div>
            </div>
          )}

          {/* Tab 2: Raw Code / Payload Inspector */}
          {selectedInspectorTab === "evidence" && (
            <div className="pt-4">
              <div className="rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#090B0A] p-4 font-mono text-xs overflow-x-auto text-[#B9C5B5] leading-relaxed max-h-[280px] overflow-y-auto">
                <pre>{currentStep.codeSnippet}</pre>
              </div>
            </div>
          )}

          {/* Interactive Action Controls in Step 5 (Settle) */}
          {activeStep === 5 && (
            <div className="mt-6 pt-5 border-t border-[rgba(241,240,232,0.08)]">
              {scenario === "HAPPY" ? (
                <div>
                  <div className="flex flex-wrap items-center gap-4">
                    {isSettled ? (
                      <div className="inline-flex items-center gap-2 rounded-xl bg-[#8FE0A5]/10 border border-[#8FE0A5]/40 px-5 py-3 text-xs font-semibold text-[#8FE0A5] shadow-lg shadow-[#8FE0A5]/5">
                        <svg className="w-4 h-4 text-[#8FE0A5]" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
                        </svg>
                        <span>Captured via PayPal Sandbox (#PAYPAL_CAP_88192)</span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={settleStage > 0}
                        onClick={handleSimulateSettlement}
                        className="rounded-xl bg-[#C6F36A] px-6 py-3 text-xs font-bold text-[#090B0A] hover:bg-[#B5E358] transition-all shadow-md shadow-[#C6F36A]/20 disabled:opacity-75 flex items-center gap-2 hover:-translate-y-0.5 active:translate-y-0"
                      >
                        {settleStage === 0 && <span>Execute Idempotent PayPal Settlement →</span>}
                        {settleStage === 1 && <span>[1/3] Locking PostgreSQL row FOR UPDATE...</span>}
                        {settleStage === 2 && <span>[2/3] Verifying RFC 8785 receipt...</span>}
                        {settleStage === 3 && <span>[3/3] Calling PayPal Orders v2 Capture...</span>}
                      </button>
                    )}

                    <span className="text-xs text-[#858F87] font-mono">
                      Idempotency key: <code className="text-[#C6F36A]">vr_m2_9f84a1e</code>
                    </span>
                  </div>

                  {settleStage > 0 && (
                    <div className="mt-3 text-xs font-mono text-[#858F87] bg-[#090B0A] p-3 rounded-lg border border-[rgba(241,240,232,0.10)] space-y-1">
                      {settleStage >= 1 && <div className="text-[#8FE0A5]">✓ SQL: SELECT * FROM &quot;Milestone&quot; WHERE id = &apos;mls_m2&apos; FOR UPDATE;</div>}
                      {settleStage >= 2 && <div className="text-[#8FE0A5]">✓ Audit: Verified canonical SHA-256 criteria hash &amp; CI green conclusion.</div>}
                      {settleStage >= 3 && <div className="text-[#8FE0A5]">✓ PayPal: POST /v2/checkout/orders/capture (Idempotency Key Delivered)</div>}
                      {settleStage >= 4 && <div className="text-[#C6F36A] font-bold">✓ Success: Funds captured in Sandbox. Milestone transitioned to SETTLED.</div>}
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-xl bg-[#E77D70]/10 border border-[#E77D70]/30 p-4 text-xs text-[#E77D70]">
                  <div className="font-bold text-[#F1F0E8] flex items-center gap-2 mb-1">
                    <svg className="w-4 h-4 text-[#E77D70]" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
                      <path d="M7.002 11a1 1 0 1 1 2 0 1 1 0 0 1-2 0zM7.1 4.995a.905.905 0 1 1 1.8 0l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995z" />
                    </svg>
                    <span>Deterministic Policy Lock Active</span>
                  </div>
                  <div className="text-[#B9C5B5] leading-relaxed">
                    Client cannot initiate PayPal settlement because the policy engine refused authorization due to failing CI tests. Even though the AI model advisory suggested approval, the deterministic policy engine safeguards funds.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Stepper Prev / Next Footer */}
          <div className="mt-6 flex items-center justify-between border-t border-[rgba(241,240,232,0.08)] pt-4 text-xs">
            <button
              type="button"
              disabled={activeStep <= 1}
              onClick={() => handleStepChange(Math.max(1, activeStep - 1))}
              className="font-medium text-[#858F87] hover:text-[#F1F0E8] disabled:opacity-30 transition-colors flex items-center gap-1"
            >
              <span>← Previous stage</span>
            </button>
            <span className="text-[#858F87] font-mono">Stage 0{activeStep} of 05</span>
            <button
              type="button"
              disabled={activeStep >= 5}
              onClick={() => handleStepChange(Math.min(5, activeStep + 1))}
              className="font-bold text-[#C6F36A] hover:text-[#B5E358] disabled:opacity-30 transition-colors flex items-center gap-1"
            >
              <span>Next stage →</span>
            </button>
          </div>
        </div>
      </section>

      {/* How It Works Architecture Section (#how) */}
      <section id="how" className="relative mx-auto max-w-6xl px-6 py-20 scroll-mt-20 border-t border-[rgba(241,240,232,0.08)] z-10">
        <div className="mb-12">
          <div className="text-xs font-mono uppercase tracking-wider text-[#C6F36A]">
            SYSTEM TOPOLOGY
          </div>
          <h2 className="text-2xl sm:text-4xl font-extrabold text-[#F1F0E8] mt-1.5 tracking-tight">
            How VeriRelease Works
          </h2>
          <p className="mt-2 text-sm text-[#858F87] max-w-2xl leading-relaxed">
            A 5-step cryptographic separation of powers separating contract definition from payment settlement.
          </p>
        </div>

        <div className="space-y-4">
          {stepDetails.map((item) => (
            <div
              key={item.step}
              onClick={() => {
                setActiveStep(item.step);
                const el = document.getElementById("sim");
                el?.scrollIntoView({ behavior: "smooth" });
              }}
              className="rounded-2xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-5 sm:p-6 hover:border-[#C6F36A]/40 transition-all cursor-pointer group fintech-card-hover"
            >
              <div className="flex items-center justify-between">
                <div className="text-xs font-mono font-bold uppercase text-[#C6F36A]">
                  Stage 0{item.step} · {item.category}
                </div>
                <span className="text-[11px] font-mono text-[#858F87] group-hover:text-[#C6F36A] transition-colors">
                  Open in workbench →
                </span>
              </div>
              <h3 className="text-lg sm:text-xl font-bold text-[#F1F0E8] mt-1 group-hover:text-[#C6F36A] transition-colors">
                {item.title}
              </h3>
              <p className="mt-1.5 text-xs sm:text-sm text-[#B9C5B5] leading-relaxed max-w-3xl">
                {item.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Trust Model Section (#trust) with Visual Architecture Flow */}
      <section id="trust" className="relative mx-auto max-w-6xl px-6 py-20 scroll-mt-20 border-t border-[rgba(241,240,232,0.08)] z-10">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <div className="text-xs font-mono uppercase tracking-wider text-[#E9B85D]">
            ZERO FINANCIAL AUTHORITY FOR AI
          </div>
          <h2 className="text-3xl sm:text-5xl font-extrabold text-[#F1F0E8] mt-2 tracking-tight">
            AI cannot authorize a payment.
          </h2>
          <p className="mt-3 text-sm text-[#858F87] leading-relaxed">
            AI models evaluate code changes and technical evidence, but only independent, deterministic software rules have the authority to unlock client payouts.
          </p>
        </div>

        {/* 3 Pillar Distinction Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-2xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-6 flex flex-col justify-between fintech-card-hover">
            <div>
              <div className="h-10 w-10 rounded-xl bg-[#E9B85D]/10 border border-[#E9B85D]/30 flex items-center justify-center text-[#E9B85D] mb-4">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <h3 className="font-bold text-[#F1F0E8] text-lg">AI Evaluation</h3>
              <p className="mt-2 text-xs sm:text-sm text-[#B9C5B5] leading-relaxed">
                Assesses the code diff and commit against acceptance criteria. Advisory only with zero payout execution capability.
              </p>
            </div>
            <div className="mt-6 pt-4 border-t border-[rgba(241,240,232,0.08)] text-xs font-mono text-[#E9B85D]">
              *Evaluates evidence*
            </div>
          </div>

          <div className="rounded-2xl border border-[#C6F36A]/30 bg-[#111512] p-6 flex flex-col justify-between fintech-card-hover shadow-lg shadow-[#C6F36A]/5">
            <div>
              <div className="h-10 w-10 rounded-xl bg-[#C6F36A]/10 border border-[#C6F36A]/30 flex items-center justify-center text-[#C6F36A] mb-4">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <h3 className="font-bold text-[#F1F0E8] text-lg">Policy Engine</h3>
              <p className="mt-2 text-xs sm:text-sm text-[#B9C5B5] leading-relaxed">
                Deterministic and independent. Verifies criteria hashes, branch origins, and CI results, signing an RFC 8785 receipt.
              </p>
            </div>
            <div className="mt-6 pt-4 border-t border-[rgba(241,240,232,0.08)] text-xs font-mono text-[#C6F36A]">
              *Authorizes eligibility*
            </div>
          </div>

          <div className="rounded-2xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-6 flex flex-col justify-between fintech-card-hover">
            <div>
              <div className="h-10 w-10 rounded-xl bg-[#8FE0A5]/10 border border-[#8FE0A5]/30 flex items-center justify-center text-[#8FE0A5] mb-4">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
              <h3 className="font-bold text-[#F1F0E8] text-lg">PayPal Settlement</h3>
              <p className="mt-2 text-xs sm:text-sm text-[#B9C5B5] leading-relaxed">
                Executes non-custodial payouts via PayPal Sandbox Orders v2 when explicitly initiated by the client.
              </p>
            </div>
            <div className="mt-6 pt-4 border-t border-[rgba(241,240,232,0.08)] text-xs font-mono text-[#8FE0A5]">
              *Settles payout*
            </div>
          </div>
        </div>

        {/* Legal Disclaimer Box */}
        <div className="mt-10 rounded-xl border border-[rgba(241,240,232,0.10)] bg-[#111512] p-5 text-center text-xs text-[#858F87] leading-relaxed font-mono">
          VeriRelease is not an escrow provider and does not hold or custody funds. &ldquo;ELIGIBLE_FOR_PAYOUT&rdquo; certifies that cryptographic policy conditions are met, not that money has moved.
        </div>
      </section>

      {/* Closing Call to Action */}
      <section className="relative mx-auto max-w-6xl px-6 py-20 border-t border-[rgba(241,240,232,0.08)] text-center z-10">
        <h2 className="text-3xl sm:text-5xl font-extrabold text-[#F1F0E8] tracking-tight">
          Let the evidence decide what gets paid.
        </h2>
        <p className="mt-4 text-sm sm:text-base text-[#858F87] max-w-xl mx-auto">
          Start building verifiable software milestone contracts powered by GitHub evidence and PayPal settlement.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/dashboard"
            className="rounded-xl bg-[#C6F36A] px-7 py-3.5 text-xs font-bold text-[#090B0A] hover:bg-[#B5E358] transition-all shadow-lg shadow-[#C6F36A]/20 hover:-translate-y-0.5 active:translate-y-0"
          >
            Launch Workspace →
          </Link>
          <a
            href="/api/auth/github/login?returnTo=/dashboard"
            className="rounded-xl border border-[rgba(241,240,232,0.16)] bg-[#111512] px-6 py-3.5 text-xs font-semibold text-[#F1F0E8] hover:bg-[#171C19] hover:border-[rgba(241,240,232,0.3)] transition-all hover:-translate-y-0.5 active:translate-y-0"
          >
            Sign in with GitHub
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[rgba(241,240,232,0.08)] bg-[#090B0A] py-8 relative z-10">
        <div className="mx-auto max-w-6xl px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#858F87]">
          <div className="flex items-center gap-2">
            <span className="font-bold text-[#F1F0E8]">VeriRelease</span>
            <span>·</span>
            <span>PayPal AI Hackathon 2026</span>
          </div>
          <div className="font-mono text-[11px]">
            AI Evaluates · Deterministic Policy Authorizes · PayPal Settles
          </div>
        </div>
      </footer>

      {/* Interactive Criteria Modal */}
      {showCriteriaModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#090B0A]/85 backdrop-blur-md">
          <div className="rounded-2xl border border-[rgba(241,240,232,0.14)] bg-[#111512] p-6 max-w-lg w-full shadow-2xl relative">
            <div className="flex items-center justify-between pb-3 border-b border-[rgba(241,240,232,0.08)]">
              <div>
                <h4 className="font-bold text-[#F1F0E8] text-base">
                  Milestone 2 Acceptance Criteria Spec
                </h4>
                <div className="text-[11px] font-mono text-[#858F87]">Immutable RFC 8785 Spec</div>
              </div>
              <button
                type="button"
                onClick={() => setShowCriteriaModal(false)}
                className="text-[#858F87] hover:text-[#F1F0E8] text-lg p-1 rounded hover:bg-[#171C19] transition-colors"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-3 text-xs">
              <div className="p-3.5 rounded-xl bg-[#171C19] border border-[rgba(241,240,232,0.10)]">
                <div className="text-[#C6F36A] font-mono font-semibold">AC-1 · Webhook Signature Verification</div>
                <div className="text-[#B9C5B5] mt-1 leading-relaxed">
                  Implement idempotent PayPal webhook listener that cryptographically validates HMAC signatures against configured webhook secrets.
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-[#171C19] border border-[rgba(241,240,232,0.10)]">
                <div className="text-[#C6F36A] font-mono font-semibold">AC-2 · Concurrency &amp; Race Condition Prevention</div>
                <div className="text-[#B9C5B5] mt-1 leading-relaxed">
                  Prevent double payouts by enforcing PostgreSQL <code className="text-[#F1F0E8]">SELECT ... FOR UPDATE</code> row locking on payment state transitions.
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-[#171C19] border border-[rgba(241,240,232,0.10)]">
                <div className="text-[#C6F36A] font-mono font-semibold">AC-3 · Automated CI Test Verification</div>
                <div className="text-[#B9C5B5] mt-1 leading-relaxed">
                  Automated test suite must complete with green conclusion on GitHub Actions before payout authorization can be considered.
                </div>
              </div>

              <div className="p-3 rounded-xl bg-[#090B0A] border border-[rgba(241,240,232,0.08)] text-[11px] font-mono text-[#858F87]">
                Frozen SHA-256 Hash: <span className="text-[#C6F36A] break-all">e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855</span>
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setShowCriteriaModal(false)}
                className="rounded-lg bg-[#C6F36A] px-4 py-2 text-xs font-bold text-[#090B0A] hover:bg-[#B5E358] transition-colors"
              >
                Close Inspector
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
