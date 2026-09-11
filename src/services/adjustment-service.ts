import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { withTenantTransaction } from "../database/client.js";
import { PostingError, PostingService } from "./posting-service.js";

export interface ApprovalGateway {
  consume(input: {
    tenantId: string;
    approvalId: string;
    idempotencyKey: string;
    binding: Record<string, string>;
  }): Promise<void>;
  report(input: {
    tenantId: string;
    approvalId: string;
    idempotencyKey: string;
    status: "COMPLETED" | "FAILED";
    result?: Record<string, string>;
  }): Promise<void>;
}
export class AdjustmentService {
  public constructor(
    private readonly database: Knex,
    private readonly postings: PostingService,
    private readonly approvals: ApprovalGateway,
  ) {}
  public async post(input: {
    tenantId: string;
    approvalId: string;
    reference: string;
    currency: string;
    entries: Array<{
      accountId: string;
      direction: "DEBIT" | "CREDIT";
      amountMinor: string;
    }>;
    idempotencyKey: string;
    sourceService: string;
    correlationId: string;
    reason: string;
  }): Promise<{
    adjustment_id: string;
    transaction_id: string;
    replayed: boolean;
  }> {
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
    const adjustmentId = deterministicUuid(
      `${input.tenantId}:${input.idempotencyKey}`,
    );
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
    let result: {
      adjustment_id: string;
      transaction_id: string;
      replayed: boolean;
    };
    try {
      result = await withTenantTransaction(
        this.database,
        input.tenantId,
        async (tx) => {
          const existing = await tx("transaction_adjustments")
            .where({
              tenant_id: input.tenantId,
              idempotency_key: input.idempotencyKey,
            })
            .first<{
              id: string;
              posted_transaction_id: string;
              request_hash: string;
            }>();
          if (existing) {
            if (existing.request_hash !== payloadHash)
              throw new PostingError(
                "IDEMPOTENCY_MISMATCH",
                "Adjustment idempotency key was reused",
              );
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
        },
      );
    } catch (error) {
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
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function deterministicUuid(value: string): string {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
