import { jest } from "@jest/globals";
import request, { type Test } from "supertest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import type { AccountProvisioningService } from "../../src/services/account-provisioning-service.js";
import type { AdjustmentService } from "../../src/services/adjustment-service.js";
import type { BalanceQueryService } from "../../src/services/balance-query-service.js";
import type { CustomerStatementService } from "../../src/services/customer-statement-service.js";
import type { HoldService } from "../../src/services/hold-service.js";
import type { PostingService } from "../../src/services/posting-service.js";
import type { ReversalService } from "../../src/services/reversal-service.js";

describe("Ledger HTTP contract alignment", () => {
  const token = "ledger-internal-token-123456789";
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const transactionId = "22222222-2222-4222-8222-222222222222";
  const reverse = jest.fn(() =>
    Promise.resolve({
      reversal_transaction_id: transactionId,
      replayed: false,
    }),
  );
  const adjustment = jest.fn(() =>
    Promise.resolve({
      adjustment_id: transactionId,
      transaction_id: transactionId,
      replayed: false,
    }),
  );
  const app = createApp({
    config: loadConfig({ INTERNAL_SERVICE_TOKEN: token }),
    postings: {} as PostingService,
    accounts: {} as AccountProvisioningService,
    holds: {} as HoldService,
    reversals: { reverse } as unknown as ReversalService,
    adjustments: { post: adjustment } as unknown as AdjustmentService,
    balances: {} as BalanceQueryService,
    statements: {} as CustomerStatementService,
  });
  const headers = (value: Test) =>
    value
      .set("x-internal-service-token", token)
      .set("x-tenant-id", tenantId)
      .set("x-calling-service", "parc-payment")
      .set("idempotency-key", "ledger-http-test");

  it("requires the declared service authentication and calling-service headers", async () => {
    await request(app)
      .post(`/internal/v1/transactions/${transactionId}/reversals`)
      .send({ reason: "automatic reversal", automated_rule_id: "RULE-1" })
      .expect(401);
    await request(app)
      .post(`/internal/v1/transactions/${transactionId}/reversals`)
      .set("x-internal-service-token", token)
      .set("x-tenant-id", tenantId)
      .set("idempotency-key", "missing-caller")
      .send({ reason: "automatic reversal", automated_rule_id: "RULE-1" })
      .expect(422);
  });

  it("propagates automated authorization and the actual calling service", async () => {
    await headers(
      request(app).post(`/internal/v1/transactions/${transactionId}/reversals`),
    )
      .send({ reason: "automatic reversal", automated_rule_id: "RULE-1" })
      .expect(201)
      .expect({ reversal_transaction_id: transactionId, replayed: false });
    expect(reverse).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceService: "parc-payment",
        automatedRuleId: "RULE-1",
      }),
    );
  });

  it("returns the documented manual-adjustment result shape", async () => {
    await headers(request(app).post("/internal/v1/manual-adjustments"))
      .send({
        approval_id: transactionId,
        reference: "ADJ-1",
        currency: "NGN",
        reason: "approved correction",
        entries: [
          {
            account_id: transactionId,
            direction: "DEBIT",
            amount_minor: "100",
          },
          { account_id: tenantId, direction: "CREDIT", amount_minor: "100" },
        ],
      })
      .expect(201)
      .expect({
        adjustment_id: transactionId,
        transaction_id: transactionId,
        replayed: false,
      });
    expect(adjustment).toHaveBeenCalledWith(
      expect.objectContaining({ sourceService: "parc-payment" }),
    );
  });
});
