/**
 * VeriRelease Payments Module
 *
 * Payment Transactions, state machine, idempotency key generation,
 * and Payment Coordinator service.
 */

export * from "./types";
export * from "./payment-state-machine";
export * from "./idempotency";
export * from "./payment-repository.interface";
export * from "./prisma-payment-repository";
export * from "./payment-service.interface";
export * from "./payment-service";
export * from "./reconciliation-repository.interface";
export * from "./prisma-reconciliation-repository";
export * from "./reconciliation-service.interface";
export * from "./reconciliation-service";
export * from "./recovery-service.interface";
export * from "./recovery-service";
export * from "./paypal/paypal-client.interface";
export * from "./paypal/rest-paypal-client";
export * from "./paypal/mock-paypal-client";
export * from "./payout-coordinator";

import { env } from "../../lib/env";
import { prisma } from "../../lib/prisma";
import { DefaultAuditService, PrismaAuditRepository } from "../audit";
import { PaymentCoordinatorService } from "./payment-service";
import { PrismaPaymentRepository } from "./prisma-payment-repository";
import { PrismaReconciliationRepository } from "./prisma-reconciliation-repository";
import { RestPayPalClient } from "./paypal/rest-paypal-client";
import { MockPayPalClient } from "./paypal/mock-paypal-client";
import { PayoutCoordinator } from "./payout-coordinator";

function createPayPalClient() {
  const hasRealCredentials =
    env.PAYPAL_CLIENT_ID &&
    env.PAYPAL_CLIENT_SECRET &&
    !env.PAYPAL_CLIENT_ID.includes("placeholder") &&
    !env.PAYPAL_CLIENT_ID.includes("your_") &&
    !env.PAYPAL_CLIENT_SECRET.includes("placeholder") &&
    !env.PAYPAL_CLIENT_SECRET.includes("your_");

  if (hasRealCredentials) {
    return new RestPayPalClient({
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      baseUrl: env.PAYPAL_BASE_URL,
      mode: env.PAYPAL_MODE,
    });
  }
  return new MockPayPalClient();
}

const auditService = new DefaultAuditService(new PrismaAuditRepository(prisma), prisma);
const paymentService = new PaymentCoordinatorService(
  new PrismaPaymentRepository(prisma),
  auditService,
  prisma,
  new PrismaReconciliationRepository(prisma)
);

export const payoutCoordinator = new PayoutCoordinator(
  paymentService,
  createPayPalClient(),
  auditService,
  prisma
);
