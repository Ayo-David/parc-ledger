import { timingSafeEqual } from "node:crypto";
import express from "express";
import helmet from "helmet";
import { PostingError, } from "./services/posting-service.js";
export function createApp(input) {
    const app = express();
    app.disable("x-powered-by");
    app.use(helmet());
    app.use(express.json({ limit: "128kb" }));
    app.get("/health", (_q, r) => r.json({
        status: "UP",
        service: input.config.SERVICE_NAME,
        version: input.config.SERVICE_VERSION,
    }));
    app.post("/internal/v1/postings", async (req, res, next) => {
        try {
            authenticate(req.header("x-internal-service-token") ?? "", input.config.INTERNAL_SERVICE_TOKEN);
            const tenantId = req.header("x-tenant-id");
            const idempotencyKey = req.header("idempotency-key");
            const sourceService = req.header("x-calling-service");
            if (!tenantId || !idempotencyKey || !sourceService)
                throw new PostingError("REQUEST_INVALID", "Tenant, idempotency key, and calling service are required");
            const body = req.body;
            if (typeof body.reference !== "string" ||
                typeof body.currency !== "string" ||
                !Array.isArray(body.entries))
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
        }
        catch (error) {
            next(error);
        }
    });
    app.post("/internal/v1/accounts", async (req, res, next) => {
        try {
            authenticate(req.header("x-internal-service-token") ?? "", input.config.INTERNAL_SERVICE_TOKEN);
            const tenantId = req.header("x-tenant-id"), idempotencyKey = req.header("idempotency-key"), sourceService = req.header("x-calling-service");
            if (!tenantId || !idempotencyKey || !sourceService)
                throw new PostingError("REQUEST_INVALID", "Tenant, idempotency key, and calling service are required");
            const body = req.body;
            if (typeof body.owner_type !== "string" ||
                typeof body.owner_id !== "string" ||
                typeof body.purpose !== "string" ||
                typeof body.account_type !== "string" ||
                typeof body.currency !== "string")
                throw new PostingError("REQUEST_INVALID", "Invalid account provisioning request");
            const result = await input.accounts.provision({
                tenantId,
                ownerType: body.owner_type,
                ownerId: body.owner_id,
                purpose: body.purpose,
                accountType: body.account_type,
                currency: body.currency,
                idempotencyKey,
                sourceService,
                correlationId: req.header("x-correlation-id") ?? crypto.randomUUID(),
            });
            res
                .status(result.replayed ? 200 : 201)
                .setHeader("Idempotent-Replayed", String(result.replayed))
                .json(result);
        }
        catch (error) {
            next(error);
        }
    });
    app.get("/internal/v1/accounts/:id/balance", async (req, res, next) => {
        try {
            const context = internalReadContext(req, input.config.INTERNAL_SERVICE_TOKEN);
            res.json(await input.balances.byAccount({
                tenantId: context.tenantId,
                accountId: req.params.id,
            }));
        }
        catch (error) {
            next(error);
        }
    });
    app.get("/internal/v1/customers/:customerId/wallet-balance", async (req, res, next) => {
        try {
            const context = internalReadContext(req, input.config.INTERNAL_SERVICE_TOKEN);
            res.json(await input.balances.customerWallet({
                tenantId: context.tenantId,
                customerId: req.params.customerId,
                currency: typeof req.query.currency === "string" ? req.query.currency : "",
            }));
        }
        catch (error) {
            next(error);
        }
    });
    app.post("/internal/v1/customers/:customerId/statements", async (req, res, next) => {
        try {
            const context = internalContext(req, input.config.INTERNAL_SERVICE_TOKEN);
            const body = req.body;
            if (typeof body.date_from !== "string" ||
                typeof body.date_to !== "string" ||
                body.format !== "pdf" ||
                (body.currency !== undefined && typeof body.currency !== "string"))
                throw new PostingError("REQUEST_INVALID", "Invalid statement request");
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
        }
        catch (error) {
            next(error);
        }
    });
    app.get("/internal/v1/customers/:customerId/statements/:statementId", async (req, res, next) => {
        try {
            const context = internalReadContext(req, input.config.INTERNAL_SERVICE_TOKEN);
            res.json(await input.statements.get({
                tenantId: context.tenantId,
                customerId: req.params.customerId,
                statementId: req.params.statementId,
            }));
        }
        catch (error) {
            next(error);
        }
    });
    app.post("/internal/v1/holds", async (req, res, next) => {
        try {
            const context = internalContext(req, input.config.INTERNAL_SERVICE_TOKEN);
            const body = req.body;
            if (![
                "account_id",
                "amount_minor",
                "currency",
                "purpose",
                "expires_at",
            ].every((key) => typeof body[key] === "string"))
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
        }
        catch (error) {
            next(error);
        }
    });
    app.post("/internal/v1/holds/:id/release", async (req, res, next) => {
        try {
            const context = internalContext(req, input.config.INTERNAL_SERVICE_TOKEN);
            const body = req.body;
            if (body.reason !== undefined && typeof body.reason !== "string")
                throw new PostingError("REQUEST_INVALID", "Release reason is invalid");
            res.json(await input.holds.release({
                tenantId: context.tenantId,
                holdId: req.params.id,
                idempotencyKey: context.idempotencyKey,
                sourceService: context.sourceService,
                correlationId: context.correlationId,
                ...(body.reason === undefined ? {} : { reason: body.reason }),
            }));
        }
        catch (error) {
            next(error);
        }
    });
    app.post("/internal/v1/holds/:id/capture", async (req, res, next) => {
        try {
            const context = internalContext(req, input.config.INTERNAL_SERVICE_TOKEN);
            const body = req.body;
            if (typeof body.reference !== "string" || !Array.isArray(body.entries))
                throw new PostingError("REQUEST_INVALID", "Invalid hold capture request");
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
        }
        catch (error) {
            next(error);
        }
    });
    app.post("/internal/v1/transactions/:id/reversals", async (req, res, next) => {
        try {
            const context = internalContext(req, input.config.INTERNAL_SERVICE_TOKEN);
            const body = req.body;
            if (typeof body.reason !== "string" ||
                (body.approval_id !== undefined &&
                    typeof body.approval_id !== "string") ||
                (body.automated_rule_id !== undefined &&
                    typeof body.automated_rule_id !== "string"))
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
        }
        catch (error) {
            next(error);
        }
    });
    app.post("/internal/v1/manual-adjustments", async (req, res, next) => {
        try {
            const context = internalContext(req, input.config.INTERNAL_SERVICE_TOKEN);
            const body = req.body;
            if (typeof body.approval_id !== "string" ||
                typeof body.reference !== "string" ||
                typeof body.currency !== "string" ||
                typeof body.reason !== "string" ||
                !Array.isArray(body.entries))
                throw new PostingError("REQUEST_INVALID", "Invalid manual adjustment request");
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
        }
        catch (error) {
            next(error);
        }
    });
    app.use((error, _q, res, _n) => {
        void _n;
        const known = error instanceof PostingError;
        res
            .status(error instanceof PostingError && error.code === "UNAUTHORIZED"
            ? 401
            : error instanceof PostingError && error.code.endsWith("NOT_FOUND")
                ? 404
                : error instanceof PostingError && error.code.includes("INVALID")
                    ? 422
                    : error instanceof PostingError
                        ? 409
                        : 500)
            .json({
            code: known ? error.code : "INTERNAL_ERROR",
            message: known ? error.message : "An internal error occurred",
        });
    });
    return app;
}
function internalReadContext(req, expectedToken) {
    authenticate(req.header("x-internal-service-token") ?? "", expectedToken);
    const tenantId = req.header("x-tenant-id");
    const sourceService = req.header("x-calling-service");
    if (!tenantId || !sourceService)
        throw new PostingError("REQUEST_INVALID", "Tenant and calling service are required");
    return { tenantId, sourceService };
}
function authenticate(token, expected) {
    if (Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(expected)))
        throw new PostingError("UNAUTHORIZED", "Internal service authentication required");
}
function internalContext(req, expectedToken) {
    authenticate(req.header("x-internal-service-token") ?? "", expectedToken);
    const tenantId = req.header("x-tenant-id"), idempotencyKey = req.header("idempotency-key"), sourceService = req.header("x-calling-service");
    if (!tenantId || !idempotencyKey || !sourceService)
        throw new PostingError("REQUEST_INVALID", "Tenant, idempotency key, and calling service are required");
    return {
        tenantId,
        idempotencyKey,
        sourceService,
        correlationId: req.header("x-correlation-id") ?? crypto.randomUUID(),
    };
}
function mapEntries(entries) {
    if (!Array.isArray(entries))
        throw new PostingError("REQUEST_INVALID", "Entries must be an array");
    return entries.map((entry) => {
        if (entry === null ||
            typeof entry !== "object" ||
            typeof entry.account_id !== "string" ||
            !["DEBIT", "CREDIT"].includes(entry.direction) ||
            typeof entry.amount_minor !== "string")
            throw new PostingError("REQUEST_INVALID", "Invalid posting entry");
        const value = entry;
        return {
            accountId: value.account_id,
            direction: value.direction,
            amountMinor: value.amount_minor,
        };
    });
}
