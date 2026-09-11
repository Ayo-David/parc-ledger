import { createHash, randomUUID } from "node:crypto";
import { withTenantTransaction } from "../database/client.js";
import { PostingError, } from "./posting-service.js";
export class HoldService {
    database;
    postings;
    constructor(database, postings) {
        this.database = database;
        this.postings = postings;
    }
    async create(input) {
        validAmount(input.amountMinor);
        if (input.currency !== "NGN" ||
            !input.purpose.trim() ||
            Number.isNaN(Date.parse(input.expiresAt)) ||
            new Date(input.expiresAt) <= new Date())
            throw new PostingError("REQUEST_INVALID", "Hold currency, purpose, or expiry is invalid");
        const requestHash = hash({
            account_id: input.accountId,
            amount_minor: input.amountMinor,
            currency: input.currency,
            purpose: input.purpose,
            expires_at: input.expiresAt,
        });
        return withTenantTransaction(this.database, input.tenantId, async (tx) => {
            await tx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", [
                `hold-create:${input.tenantId}:${input.idempotencyKey}`,
            ]);
            const replay = await commandReplay(tx, input.tenantId, "HOLD_CREATE", input.idempotencyKey, requestHash);
            if (replay)
                return { ...replay, replayed: true };
            await tx("ledger_accounts")
                .where({
                id: input.accountId,
                tenant_id: input.tenantId,
                currency_code: input.currency,
                status: "ACTIVE",
            })
                .whereNull("deleted_at")
                .forUpdate()
                .first()
                .then((row) => {
                if (!row)
                    throw new PostingError("ACCOUNT_INVALID", "Hold account is not active for this tenant and currency");
            });
            await tx.raw("SELECT public.refresh_ledger_account_balance(?, ?)", [
                input.accountId,
                input.currency,
            ]);
            const balance = await tx("ledger_account_balances")
                .where({
                tenant_id: input.tenantId,
                account_id: input.accountId,
                currency_code: input.currency,
            })
                .forUpdate()
                .first("available_balance");
            if (BigInt(balance?.available_balance ?? "0") < BigInt(input.amountMinor))
                throw new PostingError("INSUFFICIENT_AVAILABLE_BALANCE", "Hold amount exceeds available balance");
            const holdId = randomUUID();
            const result = {
                hold_id: holdId,
                account_id: input.accountId,
                amount_minor: input.amountMinor,
                currency: input.currency,
                status: "ACTIVE",
            };
            await tx("account_holds").insert({
                id: holdId,
                tenant_id: input.tenantId,
                account_id: input.accountId,
                hold_reference: `H-${hash({ key: input.idempotencyKey }).slice(0, 32)}`,
                amount: input.amountMinor,
                currency_code: input.currency,
                reason: input.purpose,
                source_service: input.sourceService,
                source_reference: input.correlationId,
                expires_at: input.expiresAt,
            });
            await completeCommand(tx, input.tenantId, "HOLD_CREATE", input.idempotencyKey, requestHash, holdId, result);
            await auditAndEvent(tx, input.tenantId, holdId, "CREATE", input.sourceService, result, `hold:${input.idempotencyKey}`, input.correlationId, "ledger.hold-created.v1");
            return { ...result, replayed: false };
        });
    }
    async release(input) {
        return this.act(input, "RELEASE", async (tx, hold) => {
            await tx("account_hold_releases").insert({
                tenant_id: input.tenantId,
                hold_id: hold.id,
                amount: hold.amount,
                currency_code: hold.currency_code,
                reason: input.reason ?? "Released",
            });
            await tx("account_holds")
                .where({ id: hold.id })
                .update({ status: "RELEASED", released_at: tx.fn.now() });
            return {
                hold_id: hold.id,
                account_id: hold.account_id,
                amount_minor: String(hold.amount),
                currency: hold.currency_code,
                status: "RELEASED",
            };
        });
    }
    async capture(input) {
        return this.act(input, "CAPTURE", async (tx, hold) => {
            const expectedDirection = hold.normal_balance === "CREDIT" ? "DEBIT" : "CREDIT";
            const heldAmount = input.entries
                .filter((entry) => entry.accountId === hold.account_id &&
                entry.direction === expectedDirection)
                .reduce((total, entry) => total + BigInt(entry.amountMinor), 0n);
            if (heldAmount !== BigInt(hold.amount))
                throw new PostingError("HOLD_CAPTURE_INVALID", "Capture must consume the complete held amount from the reserved account");
            const post = await this.postings.postInTransaction(tx, {
                tenantId: input.tenantId,
                reference: input.reference,
                currency: hold.currency_code,
                entries: input.entries,
                idempotencyKey: `hold-capture-${hash({ hold: hold.id, key: input.idempotencyKey })}`,
                sourceService: input.sourceService,
                correlationId: input.correlationId,
            });
            await tx("account_holds").where({ id: hold.id }).update({
                status: "CAPTURED",
                captured_at: tx.fn.now(),
                capture_transaction_id: post.transaction_id,
            });
            return {
                hold_id: hold.id,
                account_id: hold.account_id,
                amount_minor: String(hold.amount),
                currency: hold.currency_code,
                status: "CAPTURED",
                transaction_id: post.transaction_id,
            };
        });
    }
    /** Worker entry point; expired holds are released without a financial posting. */
    async expireDue(tenantId, limit = 100) {
        return withTenantTransaction(this.database, tenantId, async (tx) => {
            const holds = await tx("account_holds")
                .where({ tenant_id: tenantId, status: "ACTIVE" })
                .whereNotNull("expires_at")
                .where("expires_at", "<=", tx.fn.now())
                .orderBy("expires_at")
                .limit(limit)
                .forUpdate()
                .skipLocked()
                .select("id");
            for (const hold of holds)
                await tx("account_holds")
                    .where({ id: hold.id, status: "ACTIVE" })
                    .update({ status: "EXPIRED", released_at: tx.fn.now() });
            return holds.length;
        });
    }
    async act(input, action, execute) {
        const requestHash = hash(input);
        return withTenantTransaction(this.database, input.tenantId, async (tx) => {
            await tx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", [
                `hold-action:${input.tenantId}:${action}:${input.idempotencyKey}`,
            ]);
            const existing = await tx("ledger_hold_actions")
                .where({
                tenant_id: input.tenantId,
                action_type: action,
                idempotency_key: input.idempotencyKey,
            })
                .first();
            if (existing) {
                if (existing.request_hash !== requestHash)
                    throw new PostingError("IDEMPOTENCY_MISMATCH", "Idempotency key was previously used for a different hold action");
                if (existing.status !== "COMPLETED" || !existing.response_body)
                    throw new PostingError("REQUEST_IN_PROGRESS", "Hold action is in progress");
                return { ...existing.response_body, replayed: true };
            }
            await tx("ledger_hold_actions").insert({
                tenant_id: input.tenantId,
                hold_id: input.holdId,
                action_type: action,
                idempotency_key: input.idempotencyKey,
                request_hash: requestHash,
            });
            const hold = await tx("account_holds as h")
                .join("ledger_accounts as a", "a.id", "h.account_id")
                .where("h.id", input.holdId)
                .andWhere("h.tenant_id", input.tenantId)
                .forUpdate()
                .first("h.id", "h.account_id", "h.amount", "h.currency_code", "h.status", "h.expires_at", "a.normal_balance");
            if (!hold)
                throw new PostingError("HOLD_NOT_FOUND", "Hold was not found");
            if (hold.status !== "ACTIVE")
                throw new PostingError("HOLD_NOT_ACTIVE", "Hold is not active");
            if (hold.expires_at && hold.expires_at <= new Date())
                throw new PostingError("HOLD_EXPIRED", "Hold has expired");
            const result = await execute(tx, hold);
            await tx("ledger_hold_actions")
                .where({
                tenant_id: input.tenantId,
                action_type: action,
                idempotency_key: input.idempotencyKey,
            })
                .update({
                status: "COMPLETED",
                transaction_id: "transaction_id" in result ? result.transaction_id : null,
                response_body: result,
                updated_at: tx.fn.now(),
            });
            await audit(tx, input.tenantId, hold.id, action, input.sourceService, result);
            return { ...result, replayed: false };
        });
    }
}
function validAmount(amount) {
    if (!/^[1-9][0-9]*$/.test(amount))
        throw new PostingError("AMOUNT_INVALID", "Amount must be a positive integer minor-unit string");
}
function hash(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function commandReplay(tx, tenantId, type, key, requestHash) {
    const row = await tx("ledger_command_idempotency")
        .where({ tenant_id: tenantId, command_type: type, idempotency_key: key })
        .first();
    if (!row)
        return undefined;
    if (row.request_hash !== requestHash)
        throw new PostingError("IDEMPOTENCY_MISMATCH", "Idempotency key was previously used for a different hold request");
    if (row.status !== "COMPLETED" || !row.response_body)
        throw new PostingError("REQUEST_IN_PROGRESS", "Hold creation is in progress");
    return row.response_body;
}
async function completeCommand(tx, tenantId, type, key, requestHash, resourceId, response) {
    await tx("ledger_command_idempotency").insert({
        tenant_id: tenantId,
        command_type: type,
        idempotency_key: key,
        request_hash: requestHash,
        status: "COMPLETED",
        resource_type: "account_hold",
        resource_id: resourceId,
        response_body: response,
        expires_at: new Date(Date.now() + 86_400_000),
    });
}
async function auditAndEvent(tx, tenantId, holdId, action, service, payload, idempotencyKey, correlationId, eventType) {
    await tx("ledger_audit_logs").insert({
        tenant_id: tenantId,
        entity_type: "account_hold",
        entity_id: holdId,
        action,
        service_name: service,
        after_data: payload,
    });
    await tx("ledger_outbox_events").insert({
        tenant_id: tenantId,
        aggregate_type: "account_hold",
        aggregate_id: holdId,
        event_type: eventType,
        payload,
        idempotency_key: idempotencyKey,
        correlation_id: correlationId,
    });
}
async function audit(tx, tenantId, holdId, action, service, payload) {
    await tx("ledger_audit_logs").insert({
        tenant_id: tenantId,
        entity_type: "account_hold",
        entity_id: holdId,
        action,
        service_name: service,
        after_data: payload,
    });
}
