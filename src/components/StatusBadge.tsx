"use client";

import React from "react";

interface StatusBadgeProps {
  status: string;
  size?: "sm" | "md";
}

const STYLE_MAP: Record<string, string> = {
  // Milestone statuses
  DRAFT: "bg-[#171C19] text-[#858F87] border-[rgba(241,240,232,0.10)]",
  ACTIVE: "bg-[#1D241F] text-[#B9C5B5] border-[#B9C5B5]/25",
  FUNDED: "bg-[#1D241F] text-[#8FE0A5] border-[#8FE0A5]/25",
  SUBMITTED: "bg-[#E9B85D]/10 text-[#E9B85D] border-[#E9B85D]/30",
  EVALUATING: "bg-[#E9B85D]/15 text-[#E9B85D] border-[#E9B85D]/35",
  ELIGIBLE_FOR_PAYOUT: "bg-[#C6F36A]/15 text-[#C6F36A] border-[#C6F36A]/40 shadow-sm shadow-[#C6F36A]/10 font-semibold",
  CHANGES_REQUESTED: "bg-[#E77D70]/15 text-[#E77D70] border-[#E77D70]/30",
  DISPUTED: "bg-[#E77D70]/20 text-[#E77D70] border-[#E77D70]/40",
  CANCELLED: "bg-[#111512] text-[#858F87] border-[rgba(241,240,232,0.08)]",
  COMPLETED: "bg-[#8FE0A5]/15 text-[#8FE0A5] border-[#8FE0A5]/30",

  // Policy & CI
  PASS: "bg-[#C6F36A]/15 text-[#C6F36A] border-[#C6F36A]/40",
  SUCCESS: "bg-[#8FE0A5]/15 text-[#8FE0A5] border-[#8FE0A5]/30",
  FAIL: "bg-[#E77D70]/15 text-[#E77D70] border-[#E77D70]/35",
  FAILURE: "bg-[#E77D70]/15 text-[#E77D70] border-[#E77D70]/35",
  PENDING: "bg-[#E9B85D]/10 text-[#E9B85D] border-[#E9B85D]/25",
  UNAVAILABLE: "bg-[#171C19] text-[#858F87] border-[rgba(241,240,232,0.10)]",
  EVALUATED: "bg-[#1D241F] text-[#B9C5B5] border-[#B9C5B5]/30",

  // Payment statuses
  CREATED: "bg-[#171C19] text-[#858F87] border-[rgba(241,240,232,0.10)]",
  RESERVED: "bg-[#1D241F] text-[#B9C5B5] border-[#B9C5B5]/30",
  PROCESSING: "bg-[#E9B85D]/15 text-[#E9B85D] border-[#E9B85D]/35",
  SUCCEEDED: "bg-[#C6F36A]/15 text-[#C6F36A] border-[#C6F36A]/40 font-semibold",
  FAILED: "bg-[#E77D70]/20 text-[#E77D70] border-[#E77D70]/40",
  PAYOUT_UNCERTAIN: "bg-[#E9B85D]/20 text-[#E9B85D] border-[#E9B85D]/45",
  RECONCILIATION_REQUIRED: "bg-[#E77D70]/15 text-[#E77D70] border-[#E77D70]/35",

  // Roles
  CLIENT: "bg-[#171C19] text-[#F1F0E8] border-[rgba(241,240,232,0.18)] font-semibold",
  DEVELOPER: "bg-[#C6F36A]/10 text-[#C6F36A] border-[#C6F36A]/30 font-semibold",
  ADMIN: "bg-[#E9B85D]/10 text-[#E9B85D] border-[#E9B85D]/30",
};

export function StatusBadge({ status, size = "sm" }: StatusBadgeProps): React.ReactElement {
  const classes =
    STYLE_MAP[status] ?? "bg-[#171C19] text-[#858F87] border-[rgba(241,240,232,0.10)]";
  const padding = size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[10px]";

  const isPositive = status === "ELIGIBLE_FOR_PAYOUT" || status === "SUCCEEDED" || status === "PASS";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border font-mono tracking-tight tabular-nums ${padding} ${classes}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${isPositive ? "bg-[#C6F36A] animate-pulse" : "bg-current opacity-80"}`} />
      {status.replace(/_/g, " ")}
    </span>
  );
}
