import { randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import request, { type Test } from "supertest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { createParcAuth } from "../../src/security/parc-service-auth.js";
import type { AccountProvisioningService } from "../../src/services/account-provisioning-service.js";
import type { AdjustmentService } from "../../src/services/adjustment-service.js";
import type { BalanceQueryService } from "../../src/services/balance-query-service.js";
import type { CustomerStatementService } from "../../src/services/customer-statement-service.js";
import type { HoldService } from "../../src/services/hold-service.js";
import type { PostingService } from "../../src/services/posting-service.js";
import type { ReversalService } from "../../src/services/reversal-service.js";

const issuer = "https://auth.parc.invalid";
const tenantId = "11111111-1111-4111-8111-111111111111";
const transactionId = "22222222-2222-4222-8222-222222222222";
const customerId = "33333333-3333-4333-8333-333333333333";
const administratorId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";

describe("Ledger HTTP contract alignment", () => {
  let app: ReturnType<typeof createApp>;
  let sign: (claims: JWTPayload, audience?: string) => Promise<string>;
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
  const wallet = jest.fn(() =>
    Promise.resolve({
      account_id: transactionId,
      available_balance_minor: "0",
    }),
  );

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256");
    const jwks = createLocalJWKSet({
      keys: [{ ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256" }],
    });
    sign = (claims, audience = "parc-ledger") =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);
    app = createApp({
      config: loadConfig({
        SERVICE_CLIENT_KEY_ID: "parc-ledger-1",
        SERVICE_CLIENT_PRIVATE_KEY_BASE64: "unused-in-http-tests",
      }),
      access: createParcAuth({ issuer, audience: "parc-ledger", keys: jwks }),
      postings: {} as PostingService,
      accounts: {} as AccountProvisioningService,
      holds: {} as HoldService,
      reversals: { reverse } as unknown as ReversalService,
      adjustments: { post: adjustment } as unknown as AdjustmentService,
      balances: { customerWallet: wallet } as unknown as BalanceQueryService,
      statements: {} as CustomerStatementService,
    });
  });
  beforeEach(() => {
    reverse.mockClear();
    adjustment.mockClear();
  });

  const serviceToken = (client: string, scope: string) =>
    sign({
      sub: client,
      client_id: client,
      token_use: "service",
      tenant_id: tenantId,
      scope,
    });
  const delegated = (
    client: string,
    scope: string,
    subject: { id: string; type: "CUSTOMER" | "ADMINISTRATOR" },
  ) =>
    sign({
      sub: subject.id,
      client_id: client,
      token_use: "delegated",
      tenant_id: tenantId,
      scope,
      subject_type: subject.type,
      subject_scope: "TENANT",
      session_id: sessionId,
      act: { sub: client },
    });
  const reversal = (token: string, caller = "parc-payment"): Test =>
    request(app)
      .post(`/internal/v1/transactions/${transactionId}/reversals`)
      .set("authorization", `Bearer ${token}`)
      .set("x-tenant-id", tenantId)
      .set("x-calling-service", caller)
      .set("idempotency-key", randomUUID())
      .send({ reason: "automatic reversal", automated_rule_id: "RULE-1" });

  it("requires an Auth-issued bearer token and the calling-service header", async () => {
    await request(app)
      .post(`/internal/v1/transactions/${transactionId}/reversals`)
      .send({ reason: "automatic reversal", automated_rule_id: "RULE-1" })
      .expect(401)
      .expect("www-authenticate", /^Bearer /);
    await request(app)
      .post(`/internal/v1/transactions/${transactionId}/reversals`)
      .set("x-internal-service-token", "legacy-static-secret-0123456789")
      .set("x-tenant-id", tenantId)
      .set("x-calling-service", "parc-payment")
      .set("idempotency-key", randomUUID())
      .send({ reason: "automatic reversal", automated_rule_id: "RULE-1" })
      .expect(401);
    await request(app)
      .post(`/internal/v1/transactions/${transactionId}/reversals`)
      .set(
        "authorization",
        `Bearer ${await serviceToken("parc-payment", "ledger.reversals.write")}`,
      )
      .set("x-tenant-id", tenantId)
      .set("idempotency-key", "missing-caller")
      .send({ reason: "automatic reversal", automated_rule_id: "RULE-1" })
      .expect(422);
  });

  it("propagates automated authorization and the token's calling service", async () => {
    await reversal(await serviceToken("parc-payment", "ledger.reversals.write"))
      .expect(201)
      .expect({ reversal_transaction_id: transactionId, replayed: false });
    expect(reverse).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceService: "parc-payment",
        automatedRuleId: "RULE-1",
      }),
    );
  });

  it("rejects spoofed callers, unpermitted callers, missing scopes and foreign audiences", async () => {
    await reversal(
      await serviceToken("parc-lending", "ledger.reversals.write"),
      "parc-payment",
    ).expect(403);
    await reversal(
      await serviceToken("parc-savings", "ledger.reversals.write"),
      "parc-savings",
    ).expect(403);
    await reversal(
      await serviceToken("parc-payment", "ledger.postings.write"),
    ).expect(403);
    await reversal(
      await sign(
        {
          sub: "parc-payment",
          client_id: "parc-payment",
          token_use: "service",
          tenant_id: tenantId,
          scope: "ledger.reversals.write",
        },
        "parc-payment",
      ),
    ).expect(401);
    expect(reverse).not.toHaveBeenCalled();
  });

  it("accepts manual adjustments only from an administrator via the Admin BFF", async () => {
    const body = {
      approval_id: transactionId,
      reference: "ADJ-1",
      currency: "NGN",
      reason: "approved correction",
      entries: [
        { account_id: transactionId, direction: "DEBIT", amount_minor: "100" },
        { account_id: tenantId, direction: "CREDIT", amount_minor: "100" },
      ],
    };
    const adjust = (token: string, caller: string) =>
      request(app)
        .post("/internal/v1/manual-adjustments")
        .set("authorization", `Bearer ${token}`)
        .set("x-tenant-id", tenantId)
        .set("x-calling-service", caller)
        .set("idempotency-key", randomUUID())
        .send(body);
    await adjust(
      await serviceToken("parc-admin-bff", "ledger.adjustments.write"),
      "parc-admin-bff",
    ).expect(403);
    await adjust(
      await delegated("parc-admin-bff", "ledger.adjustments.write", {
        id: administratorId,
        type: "ADMINISTRATOR",
      }),
      "parc-admin-bff",
    )
      .expect(201)
      .expect({
        adjustment_id: transactionId,
        transaction_id: transactionId,
        replayed: false,
      });
    expect(adjustment).toHaveBeenCalledWith(
      expect.objectContaining({ sourceService: "parc-admin-bff" }),
    );
  });

  it("limits a customer delegation to that customer's own wallet", async () => {
    const token = await delegated("parc-mobile-bff", "ledger.balances.read", {
      id: customerId,
      type: "CUSTOMER",
    });
    const read = (id: string) =>
      request(app)
        .get(`/internal/v1/customers/${id}/wallet-balance?currency=NGN`)
        .set("authorization", `Bearer ${token}`)
        .set("x-tenant-id", tenantId)
        .set("x-calling-service", "parc-mobile-bff");
    await read(customerId).expect(200);
    await read(randomUUID()).expect(403);
  });
});
