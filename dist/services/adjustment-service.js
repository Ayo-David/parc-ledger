import { createHash } from "node:crypto";
import { withTenantTransaction } from "../database/client.js";
import { PostingError } from "./posting-service.js";
export class AdjustmentService {
    database;
    postings;
    approvals;
    constructor(database, postings, approvals) {
        this.database = database;
        this.postings = postings;
        this.approvals = approvals;
    }
    async post(input) {
        const amount = input.entries
            .filter((e) => e.direction === "DEBIT")
            .reduce((sum, e) => sum + BigInt(e.amountMinor), 0n)
            .toString();
        const payloadHash = hash({
            reference: input.reference,
            currency: input.currency,
            entries: input.entries,
            reason: input.reason,
        });
        const adjustmentId = deterministicUuid(`${input.tenantId}:${input.idempotencyKey}`);
        await this.approvals.consume({
            tenantId: input.tenantId,
            approvalId: input.approvalId,
            idempotencyKey: input.idempotencyKey,
            binding: {
                action: "MANUAL_LEDGER_ADJUSTMENT",
                resource_type: "transaction_adjustment",
                resource_id: adjustmentId,
                payload_hash: payloadHash,
                amount_minor: amount,
                currency: input.currency,
            },
        });
        let result;
        try {
            result = await withTenantTransaction(this.database, input.tenantId, async (tx) => {
                const existing = await tx("transaction_adjustments")
                    .where({
                    tenant_id: input.tenantId,
                    idempotency_key: input.idempotencyKey,
                })
                    .first();
                if (existing) {
                    if (existing.request_hash !== payloadHash)
                        throw new PostingError("IDEMPOTENCY_MISMATCH", "Adjustment idempotency key was reused");
                    return {
                        adjustment_id: existing.id,
                        transaction_id: existing.posted_transaction_id,
                        replayed: true,
                    };
                }
                const posted = await this.postings.postInTransaction(tx, {
                    tenantId: input.tenantId,
                    reference: input.reference,
                    currency: input.currency,
                    entries: input.entries,
                    idempotencyKey: `adjustment-${hash({ id: adjustmentId, key: input.idempotencyKey })}`,
                    sourceService: input.sourceService,
                    correlationId: input.correlationId,
                });
                await tx("transaction_adjustments").insert({
                    id: adjustmentId,
                    tenant_id: input.tenantId,
                    adjustment_reference: input.reference,
                    amount,
                    currency_code: input.currency,
                    reason: input.reason,
                    status: "POSTED",
                    approval_id: input.approvalId,
                    idempotency_key: input.idempotencyKey,
                    request_hash: payloadHash,
                    posted_transaction_id: posted.transaction_id,
                    posted_at: tx.fn.now(),
                });
                await tx("ledger_audit_logs").insert({
                    tenant_id: input.tenantId,
                    entity_type: "transaction_adjustment",
                    entity_id: adjustmentId,
                    action: "POST",
                    service_name: input.sourceService,
                    after_data: {
                        approval_id: input.approvalId,
                        transaction_id: posted.transaction_id,
                    },
                });
                return {
                    adjustment_id: adjustmentId,
                    transaction_id: posted.transaction_id,
                    replayed: false,
                };
            });
        }
        catch (error) {
            await this.approvals.report({
                tenantId: input.tenantId,
                approvalId: input.approvalId,
                idempotencyKey: input.idempotencyKey,
                status: "FAILED",
            });
            throw error;
        }
        await this.approvals.report({
            tenantId: input.tenantId,
            approvalId: input.approvalId,
            idempotencyKey: input.idempotencyKey,
            status: "COMPLETED",
            result: {
                adjustment_id: result.adjustment_id,
                transaction_id: result.transaction_id,
            },
        });
        return result;
    }
}
function hash(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function deterministicUuid(value) {
    const hex = hash(value);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
