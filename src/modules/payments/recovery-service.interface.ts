/**
 * VeriRelease Payment Recovery Service Interface
 *
 * Defines the application boundary for automated recovery workflows:
 * claiming stale RESERVED transactions and transitioning stale PROCESSING
 * transactions to PAYOUT_UNCERTAIN without auto-redispatch or auto-success.
 */

import type { PrismaTransactionClient } from "../../lib/prisma";
import type {
  RecoverStaleReservedInput,
  StaleReservedRecoveryReport,
  RecoverStaleProcessingInput,
  StaleProcessingRecoveryReport,
} from "./payment-service.interface";

export interface PaymentRecoveryServiceOptions {
  tx?: PrismaTransactionClient;
}

export interface PaymentRecoveryService {
  /**
   * Scans for stale RESERVED transactions (> olderThanSeconds) and atomically claims them
   * via conditional update, preserving the original transaction ID, idempotency key,
   * attempt number, and parameters in a dispatch-ready report.
   */
  recoverStaleReserved(
    input?: RecoverStaleReservedInput,
    options?: PaymentRecoveryServiceOptions
  ): Promise<StaleReservedRecoveryReport>;

  /**
   * Scans for stale PROCESSING transactions (> olderThanSeconds) and safely transitions them
   * to PAYOUT_UNCERTAIN, preserving the active payment guard and requiring reconciliation.
   */
  recoverStaleProcessing(
    input?: RecoverStaleProcessingInput,
    options?: PaymentRecoveryServiceOptions
  ): Promise<StaleProcessingRecoveryReport>;
}
