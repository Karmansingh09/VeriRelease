"use client";

import React from "react";

interface StatusBadgeProps {
  status: string;
  size?: "sm" | "md";
}

const STYLE_MAP: Record<string, string> = {
  // Milestone statuses
  DRAFT: "bg-slate-800/80 text-slate-300 border-slate-700",
  ACTIVE: "bg-sky-950/70 text-sky-300 border-sky-800",
  FUNDED: "bg-blue-950/70 text-blue-300 border-blue-800",
  SUBMITTED: "bg-indigo-950/70 text-indigo-300 border-indigo-800",
  EVALUATING: "bg-amber-950/70 text-amber-300 border-amber-700",
  ELIGIBLE_FOR_PAYOUT: "bg-emerald-950/70 text-emerald-300 border-emerald-700",
  CHANGES_REQUESTED: "bg-orange-950/70 text-orange-300 border-orange-700",
  DISPUTED: "bg-rose-950/70 text-rose-300 border-rose-800",
  CANCELLED: "bg-slate-900 text-slate-500 border-slate-800",
  COMPLETED: "bg-emerald-950/70 text-emerald-300 border-emerald-700",

  // Policy & CI
  PASS: "bg-emerald-950/80 text-emerald-300 border-emerald-700",
  SUCCESS: "bg-emerald-950/80 text-emerald-300 border-emerald-700",
  FAIL: "bg-rose-950/80 text-rose-300 border-rose-700",
  FAILURE: "bg-rose-950/80 text-rose-300 border-rose-700",
  PENDING: "bg-amber-950/70 text-amber-300 border-amber-700",
  UNAVAILABLE: "bg-slate-800 text-slate-300 border-slate-700",
  EVALUATED: "bg-sky-950/70 text-sky-300 border-sky-800",

  // Payment statuses
  CREATED: "bg-slate-800 text-slate-300 border-slate-700",
  RESERVED: "bg-blue-950/70 text-blue-300 border-blue-800",
  PROCESSING: "bg-amber-950/70 text-amber-300 border-amber-700",
  SUCCEEDED: "bg-emerald-950/80 text-emerald-300 border-emerald-600",
  FAILED: "bg-rose-950/80 text-rose-300 border-rose-700",
  PAYOUT_UNCERTAIN: "bg-amber-950/90 text-amber-300 border-amber-600",
  RECONCILIATION_REQUIRED: "bg-orange-950/80 text-orange-300 border-orange-600",

  // Roles
  CLIENT: "bg-sky-950/80 text-sky-300 border-sky-800",
  DEVELOPER: "bg-violet-950/80 text-violet-300 border-violet-800",
  ADMIN: "bg-amber-950/80 text-amber-300 border-amber-800",
};

export function StatusBadge({ status, size = "sm" }: StatusBadgeProps): React.ReactElement {
  const classes =
    STYLE_MAP[status] ?? "bg-slate-800 text-slate-300 border-slate-700";
  const padding = size === "md" ? "px-3 py-1 text-xs" : "px-2 py-0.5 text-[11px]";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-mono font-medium tracking-tight ${padding} ${classes}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {status.replace(/_/g, " ")}
    </span>
  );
}
