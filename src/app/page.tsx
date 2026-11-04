import React from "react";

export default function HomePage(): React.ReactElement {
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-8 md:p-16">
      <div className="z-10 w-full max-w-5xl items-center justify-between font-mono text-sm flex">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-emerald-500 animate-pulse" />
          <span className="font-semibold tracking-wider text-slate-200">VERIRELEASE</span>
          <span className="rounded bg-sky-950 px-2 py-0.5 text-xs text-sky-400 border border-sky-800">
            PayPal AI Hackathon 2026
          </span>
        </div>
        <div className="text-xs text-slate-400">
          Environment: <span className="font-semibold text-emerald-400">Phase 1 Foundation</span>
        </div>
      </div>

      <div className="my-auto flex flex-col items-center text-center max-w-3xl space-y-6">
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/80 px-4 py-1.5 text-xs text-slate-300">
          <span className="text-sky-400 font-semibold">Core Principle</span>
          <span>AI evaluates evidence &bull; Deterministic logic authorizes &bull; PayPal executes</span>
        </div>

        <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-white">
          Verifiable Milestone Verification &amp; Payment Authorization
        </h1>

        <p className="text-base md:text-lg text-slate-300 max-w-2xl leading-relaxed">
          Connecting software engineering contracts, GitHub pull requests, and automated payment execution
          through tamper-evident evidence receipts and deterministic policy enforcement.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full pt-8 text-left">
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-5">
            <div className="text-sky-400 font-semibold mb-1 text-sm">Evidence Harvester</div>
            <p className="text-xs text-slate-400 leading-normal">
              Extracts Git commits, PR diffs, and CI test run outputs via verified GitHub webhooks.
            </p>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-5">
            <div className="text-amber-400 font-semibold mb-1 text-sm">Deterministic Policy</div>
            <p className="text-xs text-slate-400 leading-normal">
              Pure business logic decides eligibility. The AI evaluates evidence but has zero financial authority.
            </p>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-5">
            <div className="text-emerald-400 font-semibold mb-1 text-sm">Tamper-Evident Receipts</div>
            <p className="text-xs text-slate-400 leading-normal">
              RFC 8785 canonical JSON with SHA-256 digests proving data record integrity and reproducibility.
            </p>
          </div>
        </div>
      </div>

      <div className="w-full max-w-5xl text-center text-xs text-slate-500 border-t border-slate-800/80 pt-6">
        VeriRelease coordinates verification and payment authorization. Not an escrow provider or financial custodian.
      </div>
    </main>
  );
}
