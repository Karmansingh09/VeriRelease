/**
 * VeriRelease Audit Domain Types
 *
 * Strongly typed entities, enums, and Zod schemas for append-only Audit Logging.
 */

import { z } from "zod";

// ==========================================
// Audit Enums & Constants
// ==========================================

export const AUDIT_ENTITY_TYPES = [
  "CONTRACT",
  "MILESTONE",
  "PAYMENT",
  "RECEIPT",
  "CRITERIA",
  "SUBMISSION",
  "POLICY_EVALUATION",
  "GITHUB_REPOSITORY",
  "GITHUB_DELIVERY",
  "EVIDENCE_SNAPSHOT",
  "USER",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
export const auditEntityTypeSchema = z.enum(AUDIT_ENTITY_TYPES);

export const AUDIT_ACTOR_TYPES = [
  "USER",
  "SYSTEM_PRINCIPAL",
  "WEBHOOK_GITHUB",
  "WEBHOOK_PAYPAL",
] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export const auditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);

// ==========================================
// AuditLog Domain Entity
// ==========================================

export interface AuditLog {
  id: string;
  entityType: AuditEntityType;
  entityId: string;
  actorType: AuditActorType;
  actorUserId?: string | null;
  actorSystemPrincipal?: string | null;
  action: string;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  correlationId: string;
  timestamp: Date;
}

export const auditLogSchema = z
  .object({
    id: z.string().min(1),
    entityType: auditEntityTypeSchema,
    entityId: z.string().min(1),
    actorType: auditActorTypeSchema,
    actorUserId: z.string().min(1).nullable().optional(),
    actorSystemPrincipal: z.string().min(1).nullable().optional(),
    action: z.string().min(1),
    previousState: z.record(z.unknown()).nullable().optional(),
    newState: z.record(z.unknown()).nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
    correlationId: z.string().min(1),
    timestamp: z.date(),
  })
  .refine(
    (log) => {
      // Invariant: chk_audit_actor_consistency
      // (actorType = 'USER' AND actorUserId IS NOT NULL AND actorSystemPrincipal IS NULL) OR
      // (actorType <> 'USER' AND actorUserId IS NULL AND actorSystemPrincipal IS NOT NULL)
      const hasUserId = typeof log.actorUserId === "string" && log.actorUserId.length > 0;
      const hasPrincipal =
        typeof log.actorSystemPrincipal === "string" &&
        log.actorSystemPrincipal.length > 0;

      if (log.actorType === "USER") {
        return hasUserId && !hasPrincipal;
      }
      return !hasUserId && hasPrincipal;
    },
    {
      message:
        "Mutual-exclusion violation: USER actor requires non-null actorUserId and null actorSystemPrincipal; non-USER requires null actorUserId and non-null actorSystemPrincipal",
      path: ["actorType"],
    }
  );
