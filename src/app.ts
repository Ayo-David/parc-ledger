import express, { type Express } from "express";
import helmet from "helmet";
import type { AppConfig } from "./config/env.js";
import {
  PostingError,
  type PostingService,
} from "./services/posting-service.js";
import type { AccountProvisioningService } from "./services/account-provisioning-service.js";
import type { HoldService } from "./services/hold-service.js";
import type { ReversalService } from "./services/reversal-service.js";
import type { AdjustmentService } from "./services/adjustment-service.js";
import type { BalanceQueryService } from "./services/balance-query-service.js";
import type { CustomerStatementService } from "./services/customer-statement-service.js";
import {
  principalOf,
  type AccessPolicy,
} from "./security/parc-service-auth.js";

/** Inbound Auth-issued token validation (see parc-service-auth). */
export interface LedgerAccess {
  require(policy: AccessPolicy): express.RequestHandler;
}

const postingServices = ["parc-lending", "parc-payment", "parc-savings"];

/** Ledger endpoint permissions; the caller is derived from the token. */
export const ledgerAccessPolicies = {
  postings: { scopes: ["ledger.postings.write"], actors: postingServices },
  accounts: {
    scopes: ["ledger.accounts.provision"],
    actors: ["parc-payment", "parc-savings"],
  },
  accountBalance: {
    scopes: ["ledger.balances.read"],
    actors: ["parc-admin-bff", "parc-payment", "parc-savings"],
  },
  walletBalance: {
    scopes: ["ledger.balances.read"],
    actors: [
      "parc-admin-bff",
      "parc-mobile-bff",
      "parc-payment",
      "parc-savings",
    ],
  },
  statements: {
    scopes: ["ledger.statements"],
    kinds: ["delegated"],
    subjectTypes: ["CUSTOMER"],
    actors: ["parc-mobile-bff"],
  },
  reversals: {
    scopes: ["ledger.reversals.write"],
    actors: ["parc-lending", "parc-payment"],
  },
  adjustments: {
    scopes: ["ledger.adjustments.write"],
    kinds: ["delegated"],
    subjectTypes: ["ADMINISTRATOR"],
    actors: ["parc-admin-bff"],
  },
} satisfies Record<string, AccessPolicy>;

const ledgerRoutePolicies: ReadonlyArray<
  [
    method: "get" | "post",
    path: string,
    policy: keyof typeof ledgerAccessPolicies,
  ]
> = [
  ["post", "/internal/v1/postings", "postings"],
  ["post", "/internal/v1/accounts", "accounts"],
  ["get", "/internal/v1/accounts/:id/balance", "accountBalance"],
  ["get", "/internal/v1/customers/:customerId/wallet-balance", "walletBalance"],
  ["post", "/internal/v1/customers/:customerId/statements", "statements"],
  [
    "get",
    "/internal/v1/customers/:customerId/statements/:statementId",
    "statements",
  ],
  ["post", "/internal/v1/holds", "postings"],
  ["post", "/internal/v1/holds/:id/release", "postings"],
  ["post", "/internal/v1/holds/:id/capture", "postings"],
  ["post", "/internal/v1/transactions/:id/reversals", "reversals"],
  ["post", "/internal/v1/manual-adjustments", "adjustments"],
];
export function createApp(input: {
  config: AppConfig;
  access: LedgerAccess;
  postings: PostingService;
  accounts: AccountProvisioningService;
  holds: HoldService;
  reversals: ReversalService;
  adjustments: AdjustmentService;
  balances: BalanceQueryService;
  statements: CustomerStatementService;
}): Express {
  const app = express();
  // Endpoint permissions run before each route handler.
  for (const [method, path, name] of ledgerRoutePolicies)
    app[method](path, input.access.require(ledgerAccessPolicies[name]));
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "128kb" }));
  app.get("/health", (_q, r) =>
    r.json({
      status: "UP",
      service: input.config.SERVICE_NAME,
      version: input.config.SERVICE_VERSION,
    }),
  );
  app.post("/internal/v1/postings", async (req, res, next) => {
    try {
      const { tenantId, sourceService } = caller(req);
      const idempotencyKey = req.header("idempotency-key");
      if (!tenantId || !idempotencyKey || !sourceService)
        throw new PostingError(
          "REQUEST_INVALID",
          "Tenant, idempotency key, and calling service are required",
        );
      const body = req.body as {
        reference?: unknown;
        currency?: unknown;
        entries?: Array<{
          account_id?: unknown;
          direction?: unknown;
          amount_minor?: unknown;
        }>;
      };
      if (
        typeof body.reference !== "string" ||
        typeof body.currency !== "string" ||
        !Array.isArray(body.entries)
      )
        throw new PostingError("REQUEST_INVALID", "Invalid posting request");
      const result = await input.postings.post({
        tenantId,
        reference: body.reference,
        currency: body.currency,
        entries: mapEntries(body.entries),
        idempotencyKey,
        sourceService,
        correlationId: req.header("x-correlation-id") ?? crypto.randomUUID(),
      });
      res
        .status(result.replayed ? 200 : 201)
        .setHeader("Idempotent-Replayed", String(result.replayed))
        .json(result);
    } catch (error) {
      next(error);
    }
  });
  app.post("/internal/v1/accounts", async (req, res, next) => {
    try {
      const { tenantId, sourceService } = caller(req),
        idempotencyKey = req.header("idempotency-key");
      if (!tenantId || !idempotencyKey || !sourceService)
        throw new PostingError(
          "REQUEST_INVALID",
          "Tenant, idempotency key, and calling service are required",
        );
      const body = req.body as {
        owner_type?: unknown;
        owner_id?: unknown;
        purpose?: unknown;
        account_type?: unknown;
        currency?: unknown;
      };
      if (
        typeof body.owner_type !== "string" ||
        typeof body.owner_id !== "string" ||
        typeof body.purpose !== "string" ||
        typeof body.account_type !== "string" ||
        typeof body.currency !== "string"
      )
        throw new PostingError(
          "REQUEST_INVALID",
          "Invalid account provisioning request",
        );
      const result = await input.accounts.provision({
        tenantId,
        ownerType: body.owner_type as "CUSTOMER" | "TENANT",
        ownerId: body.owner_id,
        purpose: body.purpose,
        accountType: body.account_type as
          "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE",
        currency: body.currency,
        idempotencyKey,
        sourceService,
        correlationId: req.header("x-correlation-id") ?? crypto.randomUUID(),
      });
      res
        .status(result.replayed ? 200 : 201)
        .setHeader("Idempotent-Replayed", String(result.replayed))
        .json(result);
    } catch (error) {
      next(error);
    }
  });
  app.get("/internal/v1/accounts/:id/balance", async (req, res, next) => {
    try {
      const context = internalReadContext(req);
      res.json(
        await input.balances.byAccount({
          tenantId: context.tenantId,
          accountId: req.params.id,
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  app.get(
    "/internal/v1/customers/:customerId/wallet-balance",
    async (req, res, next) => {
      try {
        const context = internalReadContext(req);
        res.json(
          await input.balances.customerWallet({
            tenantId: context.tenantId,
            customerId: req.params.customerId,
            currency:
              typeof req.query.currency === "string" ? req.query.currency : "",
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  app.post(
    "/internal/v1/customers/:customerId/statements",
    async (req, res, next) => {
      try {
        const context = internalContext(req);
        const body = req.body as Record<string, unknown>;
        if (
          typeof body.date_from !== "string" ||
          typeof body.date_to !== "string" ||
          body.format !== "pdf" ||
          (body.currency !== undefined && typeof body.currency !== "string")
        )
          throw new PostingError(
            "REQUEST_INVALID",
            "Invalid statement request",
          );
        const result = await input.statements.request({
          tenantId: context.tenantId,
          customerId: req.params.customerId,
          currency: body.currency ?? "NGN",
          dateFrom: body.date_from,
          dateTo: body.date_to,
          format: "PDF",
          idempotencyKey: context.idempotencyKey,
        });
        res
          .status(result.replayed ? 200 : 202)
          .setHeader("Idempotent-Replayed", String(result.replayed))
          .json(result);
      } catch (error) {
        next(error);
      }
    },
  );
  app.get(
    "/internal/v1/customers/:customerId/statements/:statementId",
    async (req, res, next) => {
      try {
        const context = internalReadContext(req);
        res.json(
          await input.statements.get({
            tenantId: context.tenantId,
            customerId: req.params.customerId,
            statementId: req.params.statementId,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  app.post("/internal/v1/holds", async (req, res, next) => {
    try {
      const context = internalContext(req);
      const body = req.body as Record<string, unknown>;
      if (
        ![
          "account_id",
          "amount_minor",
          "currency",
          "purpose",
          "expires_at",
        ].every((key) => typeof body[key] === "string")
      )
        throw new PostingError("REQUEST_INVALID", "Invalid hold request");
      const result = await input.holds.create({
        tenantId: context.tenantId,
        accountId: String(body.account_id),
        amountMinor: String(body.amount_minor),
        currency: String(body.currency),
        purpose: String(body.purpose),
        expiresAt: String(body.expires_at),
        idempotencyKey: context.idempotencyKey,
        sourceService: context.sourceService,
        correlationId: context.correlationId,
      });
      res
        .status(result.replayed ? 200 : 201)
        .setHeader("Idempotent-Replayed", String(result.replayed))
        .json(result);
    } catch (error) {
      next(error);
    }
  });
  app.post("/internal/v1/holds/:id/release", async (req, res, next) => {
    try {
      const context = internalContext(req);
      const body = req.body as { reason?: unknown };
      if (body.reason !== undefined && typeof body.reason !== "string")
        throw new PostingError("REQUEST_INVALID", "Release reason is invalid");
      res.json(
        await input.holds.release({
          tenantId: context.tenantId,
          holdId: req.params.id,
          idempotencyKey: context.idempotencyKey,
          sourceService: context.sourceService,
          correlationId: context.correlationId,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post("/internal/v1/holds/:id/capture", async (req, res, next) => {
    try {
      const context = internalContext(req);
      const body = req.body as {
        reference?: unknown;
        entries?: Array<{
          account_id?: unknown;
          direction?: unknown;
          amount_minor?: unknown;
        }>;
      };
      if (typeof body.reference !== "string" || !Array.isArray(body.entries))
        throw new PostingError(
          "REQUEST_INVALID",
          "Invalid hold capture request",
        );
      const result = await input.holds.capture({
        tenantId: context.tenantId,
        holdId: req.params.id,
        idempotencyKey: context.idempotencyKey,
        sourceService: context.sourceService,
        correlationId: context.correlationId,
        reference: body.reference,
        entries: mapEntries(body.entries),
      });
      res
        .status(result.replayed ? 200 : 201)
        .setHeader("Idempotent-Replayed", String(result.replayed))
        .json(result);
    } catch (error) {
      next(error);
    }
  });
  app.post(
    "/internal/v1/transactions/:id/reversals",
    async (req, res, next) => {
      try {
        const context = internalContext(req);
        const body = req.body as {
          reason?: unknown;
          approval_id?: unknown;
          automated_rule_id?: unknown;
        };
        if (
          typeof body.reason !== "string" ||
          (body.approval_id !== undefined &&
            typeof body.approval_id !== "string") ||
          (body.automated_rule_id !== undefined &&
            typeof body.automated_rule_id !== "string")
        )
          throw new PostingError("REQUEST_INVALID", "Invalid reversal request");
        const result = await input.reversals.reverse({
          tenantId: context.tenantId,
          transactionId: req.params.id,
          reason: body.reason,
          idempotencyKey: context.idempotencyKey,
          sourceService: context.sourceService,
          correlationId: context.correlationId,
          ...(body.approval_id === undefined
            ? {}
            : { approvalId: body.approval_id }),
          ...(body.automated_rule_id === undefined
            ? {}
            : { automatedRuleId: body.automated_rule_id }),
        });
        res
          .status(result.replayed ? 200 : 201)
          .setHeader("Idempotent-Replayed", String(result.replayed))
          .json(result);
      } catch (error) {
        next(error);
      }
    },
  );
  app.post("/internal/v1/manual-adjustments", async (req, res, next) => {
    try {
      const context = internalContext(req);
      const body = req.body as {
        approval_id?: unknown;
        reference?: unknown;
        currency?: unknown;
        reason?: unknown;
        entries?: Array<{
          account_id?: unknown;
          direction?: unknown;
          amount_minor?: unknown;
        }>;
      };
      if (
        typeof body.approval_id !== "string" ||
        typeof body.reference !== "string" ||
        typeof body.currency !== "string" ||
        typeof body.reason !== "string" ||
        !Array.isArray(body.entries)
      )
        throw new PostingError(
          "REQUEST_INVALID",
          "Invalid manual adjustment request",
        );
      const result = await input.adjustments.post({
        tenantId: context.tenantId,
        approvalId: body.approval_id,
        reference: body.reference,
        currency: body.currency,
        reason: body.reason,
        entries: mapEntries(body.entries),
        idempotencyKey: context.idempotencyKey,
        sourceService: context.sourceService,
        correlationId: context.correlationId,
      });
      res
        .status(result.replayed ? 200 : 201)
        .setHeader("Idempotent-Replayed", String(result.replayed))
        .json(result);
    } catch (error) {
      next(error);
    }
  });
  app.use(
    (
      error: unknown,
      _q: express.Request,
      res: express.Response,
      _n: express.NextFunction,
    ) => {
      void _n;
      const known = error instanceof PostingError;
      res
        .status(
          error instanceof PostingError && error.code === "UNAUTHORIZED"
            ? 401
            : error instanceof PostingError && error.code.endsWith("FORBIDDEN")
              ? 403
              : error instanceof PostingError &&
                  error.code.endsWith("NOT_FOUND")
                ? 404
                : error instanceof PostingError &&
                    error.code.includes("INVALID")
                  ? 422
                  : error instanceof PostingError
                    ? 409
                    : 500,
        )
        .json({
          code: known ? error.code : "INTERNAL_ERROR",
          message: known ? error.message : "An internal error occurred",
        });
    },
  );
  return app;
}
/**
 * Tenant and calling service from the validated token. The middleware has
 * checked X-Tenant-Id and X-Calling-Service against the token; the header is
 * still required by the contract.
 */
function caller(req: express.Request): {
  tenantId: string | undefined;
  sourceService: string | undefined;
} {
  const principal = principalOf(req);
  return {
    tenantId: req.header("x-tenant-id") ?? undefined,
    sourceService: req.header("x-calling-service")
      ? principal.client
      : undefined,
  };
}

/** A customer delegation may only reach that customer's own resources. */
function assertCustomerScope(req: express.Request, customerId: string): void {
  const subject = principalOf(req).subject;
  if (subject?.type === "CUSTOMER" && subject.id !== customerId)
    throw new PostingError("SUBJECT_FORBIDDEN", "Customer mismatch");
}

function internalReadContext(req: express.Request): {
  tenantId: string;
  sourceService: string;
} {
  const { tenantId, sourceService } = caller(req);
  if (!tenantId || !sourceService)
    throw new PostingError(
      "REQUEST_INVALID",
      "Tenant and calling service are required",
    );
  if (typeof req.params.customerId === "string")
    assertCustomerScope(req, req.params.customerId);
  return { tenantId, sourceService };
}
function internalContext(req: express.Request): {
  tenantId: string;
  idempotencyKey: string;
  sourceService: string;
  correlationId: string;
} {
  const { tenantId, sourceService } = caller(req),
    idempotencyKey = req.header("idempotency-key");
  if (!tenantId || !idempotencyKey || !sourceService)
    throw new PostingError(
      "REQUEST_INVALID",
      "Tenant, idempotency key, and calling service are required",
    );
  if (typeof req.params.customerId === "string")
    assertCustomerScope(req, req.params.customerId);
  return {
    tenantId,
    idempotencyKey,
    sourceService,
    correlationId: req.header("x-correlation-id") ?? crypto.randomUUID(),
  };
}

function mapEntries(entries: unknown): Array<{
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amountMinor: string;
}> {
  if (!Array.isArray(entries))
    throw new PostingError("REQUEST_INVALID", "Entries must be an array");
  return entries.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof (entry as Record<string, unknown>).account_id !== "string" ||
      !["DEBIT", "CREDIT"].includes(
        (entry as Record<string, unknown>).direction as string,
      ) ||
      typeof (entry as Record<string, unknown>).amount_minor !== "string"
    )
      throw new PostingError("REQUEST_INVALID", "Invalid posting entry");
    const value = entry as {
      account_id: string;
      direction: "DEBIT" | "CREDIT";
      amount_minor: string;
    };
    return {
      accountId: value.account_id,
      direction: value.direction,
      amountMinor: value.amount_minor,
    };
  });
}
