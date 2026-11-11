# VeriRelease Milestone 6 — PayPal Sandbox Payment Integration

**Status:** Completed  
**Tests:** 544 passing across 38 test files (118 PostgreSQL integration, 426 unit)  

## 1. Overview

Milestone 6 implements PayPal Sandbox payment execution on top of the M2 concurrency, reservation, idempotency, and reconciliation state machine. It strictly preserves VeriRelease's core separation between verification eligibility and payment execution: AI evaluates evidence, deterministic logic sets `ELIGIBLE_FOR_PAYOUT`, and only an authorized contract client triggers PayPal Sandbox settlement via `PayoutCoordinator`.

---

## 2. Payment Execution & Safety Architecture

```
[ Authorized Client Action: POST /api/milestones/[id]/payout ]
          │
          ▼
[ PayoutCoordinator.executePayout() ]
   ├─ 1. Verifies caller === contract.clientId
   ├─ 2. Derives authoritative amountMinorUnits & currency from DB Milestone
   ├─ 3. PaymentCoordinatorService.reservePayout()
   │       • Acquires PostgreSQL FOR UPDATE row lock
   │       • Enforces milestone.status === ELIGIBLE_FOR_PAYOUT
   │       • Checks partial unique index against duplicate SUCCEEDED payouts
   │       • Reuses or reserves PaymentTransaction (RESERVED)
   ├─ 4. Claims PROCESSING lock (claimProcessing)
   ├─ 5. Calls PayPalClient.createOrder(intent: "CAPTURE")
   ├─ 6. Calls PayPalClient.captureOrder(PayPal-Request-Id: idempotencyKey)
   ├─ 7. Verifies capture.status === "COMPLETED" & exact DB amount/currency match
   └─ 8. Transitions transaction cleanly:
           • Verified match        ──▶ SUCCEEDED
           • Definitive rejection  ──▶ FAILED
           • Timeout / 5xx / drop  ──▶ PAYOUT_UNCERTAIN (NO blind retries!)
```

### Non-Negotiable Invariants Enforced
1. **Zero Frontend Financial Trust:** The API route (`POST /api/milestones/[id]/payout`) ignores any client-supplied amount or currency; amounts and currencies are read exclusively from the authoritative PostgreSQL `Milestone` row.
2. **Server-Side Secrets Only:** `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and OAuth2 client-credentials bearer tokens never leave the server.
3. **No Blind Retries on Ambiguous Outcomes:** Network drops, timeouts, and PayPal 5xx responses raise `PayPalAmbiguousResponseError`, transitioning the transaction immediately to `PAYOUT_UNCERTAIN` for operator reconciliation rather than risking duplicate charges.
4. **Honest Sandbox Adapter Selection:** When live PayPal Sandbox credentials are configured in `.env`, `RestPayPalClient` targets `https://api-m.sandbox.paypal.com`. In offline/demo environments without live credentials, `MockPayPalClient` is explicitly selected and responses include `isDemoMode: true`.

---

## 3. Files Added & Updated

| File | Responsibility |
| :--- | :--- |
| `src/modules/payments/paypal/paypal-client.interface.ts` | `PayPalClient` provider contract (`createOrder`, `captureOrder`, `getOrder`) |
| `src/modules/payments/paypal/rest-paypal-client.ts` | Official PayPal Sandbox REST API client with OAuth2 token caching, `PayPal-Request-Id` idempotency, and ambiguous timeout/5xx classification |
| `src/modules/payments/paypal/mock-paypal-client.ts` | Deterministic sandbox mock adapter for offline tests and demo workflows (`ord_sbx_*` / `cap_sbx_*`) |
| `src/modules/payments/payout-coordinator.ts` | Orchestrates authorization, DB reservation, PayPal capture verification, state transitions, and audit logs |
| `src/modules/payments/index.ts` | Factory wiring `RestPayPalClient` vs `MockPayPalClient` and exporting `payoutCoordinator` singleton |
| `src/app/api/milestones/[id]/payout/route.ts` | Authenticated, CSRF-protected `POST` & `GET` payout API endpoints |
| `src/lib/env.ts` & `.env.example` | Added validated `PAYPAL_BASE_URL` configuration |
| `tests/unit/payout-coordinator.test.ts` | 10 unit tests covering Mock/REST clients, authorization, amount mismatch, duplicate safety, and `PAYOUT_UNCERTAIN` |
| `tests/integration/paypal-payout-e2e.test.ts` | 3 PostgreSQL integration tests verifying ineligible rejection, full payout persistence, duplicate block, and uncertain outcome persistence |
