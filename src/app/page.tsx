import React from "react";
import Link from "next/link";

export default function HomePage(): React.ReactElement {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      {/* Top Bar */}
      <header className="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-blue-700 font-mono text-sm font-bold text-white">
              VR
            </span>
            <span className="font-semibold tracking-wide text-white">VERIRELEASE</span>
            <span className="hidden sm:inline-block rounded bg-sky-950 px-2 py-0.5 text-xs font-mono text-sky-300 border border-sky-800">
              PayPal AI Hackathon 2026
            </span>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors"
            >
              Sign In
            </Link>
            <Link
              href="/dashboard"
              className="rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500 transition-colors shadow-sm shadow-sky-950"
            >
              Open Workspace &rarr;
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="mx-auto max-w-6xl px-6 pt-16 pb-14 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/80 px-4 py-1.5 text-xs text-slate-300">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-sky-400 font-semibold">Trust Architecture</span>
          <span>AI evaluates evidence &bull; Deterministic policy authorizes &bull; PayPal settles</span>
        </div>

        <h1 className="mx-auto mt-6 max-w-4xl text-4xl sm:text-6xl font-bold tracking-tight text-white leading-[1.1]">
          Verifiable Software Milestone Verification &amp;{" "}
          <span className="bg-gradient-to-r from-sky-400 to-emerald-400 bg-clip-text text-transparent">
            PayPal Payout Authorization
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-base sm:text-lg text-slate-300 leading-relaxed">
          Eliminate manual milestone disputes. VeriRelease links software contracts to real GitHub
          pull requests, verifies acceptance criteria with tamper-evident RFC 8785 receipts, enforces
          deterministic payout policy, and settles via idempotent PayPal Sandbox orders.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/dashboard"
            className="rounded-xl bg-sky-600 px-6 py-3.5 text-sm font-semibold text-white hover:bg-sky-500 transition-colors shadow-lg shadow-sky-950/60"
          >
            Launch Interactive Workspace &rarr;
          </Link>
          <a
            href="/api/auth/github/login?returnTo=/dashboard"
            className="rounded-xl border border-slate-700 bg-slate-900 px-6 py-3.5 text-sm font-semibold text-slate-200 hover:bg-slate-800 transition-colors"
          >
            Continue with GitHub OAuth
          </a>
        </div>
      </section>

      {/* 5-Stage Lifecycle Pipeline */}
      <section className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-sm font-mono uppercase tracking-wider text-slate-400">
            End-to-End Verification &amp; Settlement Pipeline
          </h2>
          <span className="text-xs font-mono text-emerald-400">
            Strict Zero-Escrow Custody Model
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {[
            {
              step: "01",
              title: "Contract & Fund",
              desc: "Client defines milestones with immutable acceptance criteria & funds milestone.",
              accent: "border-sky-800/70 bg-sky-950/20",
              tag: "CLIENT",
            },
            {
              step: "02",
              title: "Submit GitHub PR",
              desc: "Developer submits PR number, 40-char SHA, and commits against frozen criteria hash.",
              accent: "border-violet-800/70 bg-violet-950/20",
              tag: "DEVELOPER",
            },
            {
              step: "03",
              title: "Evidence Snapshot",
              desc: "Harvests commits, PR state & CI check runs into RFC 8785 canonical SHA-256 snapshot.",
              accent: "border-indigo-800/70 bg-indigo-950/20",
              tag: "GITHUB",
            },
            {
              step: "04",
              title: "AI + Policy Engine",
              desc: "AI assesses evidence; deterministic policy rules alone decide ELIGIBLE_FOR_PAYOUT.",
              accent: "border-amber-800/70 bg-amber-950/20",
              tag: "DETERMINISTIC",
            },
            {
              step: "05",
              title: "PayPal Sandbox",
              desc: "Client triggers idempotent Orders v2 capture with PostgreSQL row locks & audit trail.",
              accent: "border-emerald-800/70 bg-emerald-950/20",
              tag: "SETTLEMENT",
            },
          ].map((item) => (
            <div
              key={item.step}
              className={`rounded-xl border p-5 flex flex-col justify-between ${item.accent}`}
            >
              <div>
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                  <span>STEP {item.step}</span>
                  <span className="text-slate-300">{item.tag}</span>
                </div>
                <h3 className="mt-2.5 text-base font-semibold text-white">{item.title}</h3>
                <p className="mt-2 text-xs text-slate-400 leading-relaxed">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Security & Architectural Guarantees */}
      <section className="mx-auto max-w-6xl px-6 py-10">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="text-sky-400 font-semibold mb-2 text-sm">
              Zero Financial Authority for AI
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              OpenAI / Demo AI outputs are strictly untrusted candidate assessments. Only the pure
              deterministic <code className="text-slate-200">PolicyEvaluationService</code> evaluates
              frozen criteria hashes and authorizes <code className="text-slate-200">ELIGIBLE_FOR_PAYOUT</code>.
            </p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="text-amber-400 font-semibold mb-2 text-sm">
              Idempotent PayPal Settlement
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              PostgreSQL <code className="text-slate-200">FOR UPDATE</code> row locks, partial unique
              indexes, and <code className="text-slate-200">PayPal-Request-Id</code> keys prevent double
              payouts. Network timeouts transition cleanly to{" "}
              <code className="text-slate-200">PAYOUT_UNCERTAIN</code> without blind retries.
            </p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="text-emerald-400 font-semibold mb-2 text-sm">
              Tamper-Evident Audit Receipts
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Every contract action, GitHub evidence snapshot, AI run, deterministic policy
              evaluation, and PayPal capture writes an immutable RFC 8785 canonical SHA-256 receipt
              and append-only PostgreSQL audit record.
            </p>
          </div>
        </div>
      </section>

      <footer className="mx-auto max-w-6xl px-6 py-8 border-t border-slate-800/80 text-center text-xs text-slate-500">
        VeriRelease coordinates milestone verification and PayPal Sandbox payment authorization. Not an
        escrow provider or financial custodian.
      </footer>
    </main>
  );
}
