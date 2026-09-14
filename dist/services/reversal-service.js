import { createHash } from "node:crypto";
import { withTenantTransaction } from "../database/client.js";
import { PostingError } from "./posting-service.js";
export class ReversalService {
    database;
    postings;
    approvals;
    constructor(database, postings, approvals) {
        this.database = database;
        this.postings = postings;
        this.approvals = approvals;
    }
    async reverse(input) {
        if (!input.reason.trim() || (!input.approvalId && !input.automatedRuleId))
            throw new PostingError("REVERSAL_AUTHORIZATION_REQUIRED", "A bound approval or pre-approved automated rule is required");
        const requestHash = hash({
            transaction_id: input.transactionId,
            reason: input.reason,
            approval_id: input.approvalId ?? null,
            automated_rule_id: input.automatedRuleId ?? null,
        });
        if (input.approvalId) {
            if (!this.approvals)
                throw new PostingError("APPROVAL_SERVICE_UNAVAILABLE", "Manual reversals require the approval service");
            const original = await withTenantTransaction(this.database, input.tenantId, (tx) => tx("ledger_transactions")
                .where({
                id: input.transactionId,
                tenant_id: input.tenantId,
                status: "COMPLETED",
            })
                .first());
            if (!original)
                throw new PostingError("TRANSACTION_NOT_REVERSIBLE", "Completed transaction is unavailable for reversal");
            await this.approvals.consume({
                tenantId: input.tenantId,
                approvalId: input.approvalId,
                idempotencyKey: input.idempotencyKey,
                binding: {
                    action: "MANUAL_LEDGER_REVERSAL",
                    resource_type: "ledger_transaction",
                    resource_id: input.transactionId,
                    payload_hash: requestHash,
                    amount_minor: String(original.amount),
                    currency: original.currency_code,
                },
            });
        }
        let result;
        try {
            result = await withTenantTransaction(this.database, input.tenantId, async (tx) => {
                await tx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", [
                    `reversal:${input.tenantId}:${input.transactionId}`,
                ]);
                const existing = await tx("transaction_reversals")
                    .where({
                    tenant_id: input.tenantId,
                    original_transaction_id: input.transactionId,
                })
                    .first();
                if (existing) {
                    if (existing.request_hash !== requestHash)
                        throw new PostingError("REVERSAL_ALREADY_EXISTS", "Transaction already has a different reversal");
                    return {
                        reversal_transaction_id: existing.reversal_transaction_id,
                        replayed: true,
                    };
                }
                const original = await tx("ledger_transactions")
                    .where({
                    id: input.transactionId,
                    tenant_id: input.tenantId,
                    status: "COMPLETED",
                })
                    .forUpdate()
                    .first();
                const journal = await tx("journals")
                    .where({ transaction_id: input.transactionId, status: "POSTED" })
                    .first();
                if (!original || !journal)
                    throw new PostingError("TRANSACTION_NOT_REVERSIBLE", "Completed transaction is unavailable for reversal");
                const entries = await tx("journal_entries")
                    .where({ journal_id: journal.id })
                    .orderBy("entry_sequence")
                    .select("account_id", "entry_type", "amount");
                if (entries.length < 2)
                    throw new PostingError("TRANSACTION_NOT_REVERSIBLE", "Completed transaction is unavailable for reversal");
                const posted = await this.postings.postInTransaction(tx, {
                    tenantId: input.tenantId,
                    reference: `REV-${original.transaction_reference}-${input.transactionId.slice(0, 8)}`.slice(0, 100),
                    currency: original.currency_code,
                    entries: entries.map((entry) => ({
                        accountId: entry.account_id,
                        direction: entry.entry_type === "DEBIT"
                            ? "CREDIT"
                            : "DEBIT",
                        amountMinor: String(entry.amount),
                    })),
                    idempotencyKey: `reversal-${hash({ id: input.transactionId, key: input.idempotencyKey })}`,
                    sourceService: input.sourceService,
                    correlationId: input.correlationId,
                });
                await tx("transaction_reversals").insert({
                    tenant_id: input.tenantId,
                    original_transaction_id: input.transactionId,
                    reversal_transaction_id: posted.transaction_id,
                    reason: input.reason,
                    approval_id: input.approvalId ?? null,
                    idempotency_key: input.idempotencyKey,
                    request_hash: requestHash,
                    source_service: input.sourceService,
                    completed_at: tx.fn.now(),
                });
                await tx("transaction_links").insert({
                    tenant_id: input.tenantId,
                    transaction_id: input.transactionId,
                    linked_transaction_id: posted.transaction_id,
                    relationship_type: "REVERSAL",
                });
                await tx("ledger_audit_logs").insert({
                    tenant_id: input.tenantId,
                    entity_type: "ledger_transaction",
                    entity_id: posted.transaction_id,
                    action: "REVERSE",
                    service_name: input.sourceService,
                    after_data: {
                        original_transaction_id: input.transactionId,
                        approval_id: input.approvalId ?? null,
                        automated_rule_id: input.automatedRuleId ?? null,
                    },
                });
                await tx("ledger_outbox_events").insert({
                    tenant_id: input.tenantId,
                    aggregate_type: "ledger_transaction",
                    aggregate_id: posted.transaction_id,
                    event_type: "ledger.transaction-reversed.v1",
                    payload: {
                        original_transaction_id: input.transactionId,
                        reversal_transaction_id: posted.transaction_id,
                        currency: original.currency_code,
                        amount_minor: String(original.amount),
                    },
                    idempotency_key: `reversal:${input.idempotencyKey}`,
                    correlation_id: input.correlationId,
                });
                return {
                    reversal_transaction_id: posted.transaction_id,
                    replayed: false,
                };
            });
        }
        catch (error) {
            if (input.approvalId && this.approvals)
                try {
                    await this.approvals.report({
                        tenantId: input.tenantId,
                        approvalId: input.approvalId,
                        idempotencyKey: input.idempotencyKey,
                        status: "FAILED",
                    });
                }
                catch {
                    console.error("Failed to report reversal failure", input.approvalId);
                }
            throw error;
        }
        if (input.approvalId && this.approvals)
            await this.approvals.report({
                tenantId: input.tenantId,
                approvalId: input.approvalId,
                idempotencyKey: input.idempotencyKey,
                status: "COMPLETED",
                result: { reversal_transaction_id: result.reversal_transaction_id },
            });
        return result;
    }
}
function hash(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
