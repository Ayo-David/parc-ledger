import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { withTenantTransaction } from "../database/client.js";
import { PostingError } from "./posting-service.js";

type StatementRow = {
  id: string;
  customer_id: string;
  currency_code: string;
  date_from: string | Date;
  date_to: string | Date;
  format: string;
  status: string;
  request_hash: string;
  object_reference: string | null;
  download_expires_at: Date | null;
  failure_code: string | null;
  created_at: Date;
};

export class CustomerStatementService {
  public constructor(private readonly database: Knex) {}

  public async request(input: {
    tenantId: string;
    customerId: string;
    currency: string;
    dateFrom: string;
    dateTo: string;
    format: "PDF";
    idempotencyKey: string;
  }): Promise<{ id: string; status: string; replayed: boolean }> {
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          customerId: input.customerId,
          currency: input.currency,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          format: input.format,
        }),
      )
      .digest("hex");
    return withTenantTransaction(this.database, input.tenantId, async (tx) => {
      const existing = await tx("customer_statement_requests")
        .where({
          tenant_id: input.tenantId,
          idempotency_key: input.idempotencyKey,
        })
        .first<StatementRow>();
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new PostingError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was used for another statement request",
          );
        return { id: existing.id, status: existing.status, replayed: true };
      }
      const id = randomUUID();
      await tx("customer_statement_requests").insert({
        id,
        tenant_id: input.tenantId,
        customer_id: input.customerId,
        currency_code: input.currency,
        date_from: input.dateFrom,
        date_to: input.dateTo,
        format: input.format,
        idempotency_key: input.idempotencyKey,
        request_hash: requestHash,
      });
      return { id, status: "PENDING", replayed: false };
    });
  }

  public async get(input: {
    tenantId: string;
    customerId: string;
    statementId: string;
  }): Promise<Record<string, unknown>> {
    return withTenantTransaction(this.database, input.tenantId, async (tx) => {
      const row = await tx("customer_statement_requests")
        .where({
          tenant_id: input.tenantId,
          customer_id: input.customerId,
          id: input.statementId,
        })
        .first<StatementRow>();
      if (!row)
        throw new PostingError("STATEMENT_NOT_FOUND", "Statement not found");
      return {
        id: row.id,
        status: row.status.toLowerCase(),
        currency: row.currency_code,
        date_from: dateOnly(row.date_from),
        date_to: dateOnly(row.date_to),
        format: row.format.toLowerCase(),
        ...(row.status === "READY" && row.object_reference
          ? {
              download_reference: row.object_reference,
              download_expires_at: row.download_expires_at?.toISOString(),
            }
          : {}),
        ...(row.failure_code ? { failure_code: row.failure_code } : {}),
        created_at: row.created_at.toISOString(),
      };
    });
  }
}

function dateOnly(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}
