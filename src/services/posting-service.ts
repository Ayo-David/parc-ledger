import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { withTenantTransaction } from "../database/client.js";

export interface PostingCommand {
  tenantId: string;
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
}
export class PostingError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class PostingService {
  public constructor(private readonly database: Knex) {}
  public async post(input: PostingCommand): Promise<{
    transaction_id: string;
    journal_id: string;
    status: "POSTED";
    replayed: boolean;
  }> {
    validate(input);
    return withTenantTransaction(this.database, input.tenantId, (tx) =>
      this.postInTransaction(tx, input),
    );
  }
  /** Used by hold capture to make the hold state and resulting posting atomic. */
  public async postInTransaction(
    tx: Knex.Transaction,
    input: PostingCommand,
  ): Promise<{
    transaction_id: string;
    journal_id: string;
    status: "POSTED";
    replayed: boolean;
  }> {
    validate(input);
    await tx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", [
      `posting:${input.tenantId}:${input.idempotencyKey}`,
    ]);
    const hash = commandHash(input);
    const existing = await tx("ledger_transactions")
      .where({
        tenant_id: input.tenantId,
        idempotency_key: input.idempotencyKey,
      })
      .first<{ id: string; request_hash: string; status: string }>();
    if (existing) {
      if (existing.request_hash !== hash)
        throw new PostingError(
          "IDEMPOTENCY_MISMATCH",
          "Idempotency key was previously used for a different posting",
        );
      const journal = await tx("journals")
        .where({ transaction_id: existing.id })
        .first<{ id: string }>();
      if (!journal || existing.status !== "COMPLETED")
        throw new PostingError(
          "POSTING_IN_PROGRESS",
          "Posting is still processing",
        );
      return {
        transaction_id: existing.id,
        journal_id: journal.id,
        status: "POSTED",
        replayed: true,
      };
    }
    const accountRows = await tx("ledger_accounts")
      .whereIn(
        "id",
        input.entries.map((e) => e.accountId),
      )
      .where({
        tenant_id: input.tenantId,
        currency_code: input.currency,
        status: "ACTIVE",
      })
      .whereNull("deleted_at")
      .orderBy("id")
      .forUpdate()
      .select<{ id: string; book_id: string }[]>("id", "book_id");
    if (
      accountRows.length !== new Set(input.entries.map((e) => e.accountId)).size
    )
      throw new PostingError(
        "ACCOUNT_INVALID",
        "Every account must be active, tenant-scoped, and use the posting currency",
      );
    const bookId = accountRows[0]?.book_id;
    if (!bookId || accountRows.some((a) => a.book_id !== bookId))
      throw new PostingError(
        "BOOK_MISMATCH",
        "All posting accounts must belong to one ledger book",
      );
    const period = await tx("accounting_periods")
      .where({ tenant_id: input.tenantId, book_id: bookId })
      .whereRaw("start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE")
      .first<{ id: string; status: string }>("id", "status");
    if (period !== undefined && period.status !== "OPEN")
      throw new PostingError(
        "ACCOUNTING_PERIOD_CLOSED",
        "The applicable accounting period is not open",
      );
    const transactionId = randomUUID();
    const journalId = randomUUID();
    const amount = total(input.entries, "DEBIT");
    await tx("ledger_transactions").insert({
      id: transactionId,
      tenant_id: input.tenantId,
      book_id: bookId,
      transaction_reference: input.reference,
      transaction_type: "OTHER",
      status: "PENDING",
      amount,
      currency_code: input.currency,
      idempotency_key: input.idempotencyKey,
      request_hash: hash,
      source_service: input.sourceService,
      correlation_id: input.correlationId,
    });
    await tx("journals").insert({
      id: journalId,
      tenant_id: input.tenantId,
      book_id: bookId,
      journal_reference: input.reference,
      transaction_id: transactionId,
      accounting_period_id: period?.id ?? null,
      currency_code: input.currency,
      status: "DRAFT",
      description: "Synchronous posting",
    });
    await tx("journal_entries").insert(
      input.entries.map((e, index) => ({
        tenant_id: input.tenantId,
        journal_id: journalId,
        account_id: e.accountId,
        entry_type: e.direction,
        amount: e.amountMinor,
        currency_code: input.currency,
        entry_sequence: index + 1,
        reference: input.reference,
      })),
    );
    await tx.raw("SELECT public.post_journal(?, NULL)", [journalId]);
    const postedJournal = await tx("journals")
      .where({ id: journalId })
      .first<{ posted_at: Date }>("posted_at");
    if (postedJournal?.posted_at == null)
      throw new PostingError(
        "POSTING_INCOMPLETE",
        "Posted journal timestamp was not persisted",
      );
    await tx("ledger_audit_logs").insert({
      tenant_id: input.tenantId,
      entity_type: "ledger_transaction",
      entity_id: transactionId,
      action: "POST",
      service_name: input.sourceService,
      after_data: {
        reference: input.reference,
        currency: input.currency,
        amount_minor: String(amount),
      },
      metadata: { idempotency_key: input.idempotencyKey, request_hash: hash },
    });
    await tx("ledger_outbox_events").insert({
      tenant_id: input.tenantId,
      aggregate_type: "ledger_transaction",
      aggregate_id: transactionId,
      event_type: "ledger.transaction-posted.v1",
      payload: {
        transaction_id: transactionId,
        reference: input.reference,
        currency: input.currency,
        total_debits_minor: String(amount),
        total_credits_minor: String(amount),
        posted_at: postedJournal.posted_at.toISOString(),
      },
      idempotency_key: `posting:${input.idempotencyKey}`,
      correlation_id: input.correlationId,
    });
    return {
      transaction_id: transactionId,
      journal_id: journalId,
      status: "POSTED",
      replayed: false,
    };
  }
}
function validate(input: PostingCommand): void {
  if (!/^[A-Z]{3}$/.test(input.currency))
    throw new PostingError(
      "CURRENCY_INVALID",
      "Currency must be ISO 4217 uppercase",
    );
  if (input.entries.length < 2)
    throw new PostingError(
      "POSTING_INVALID",
      "At least two entries are required",
    );
  for (const e of input.entries)
    if (
      !["DEBIT", "CREDIT"].includes(e.direction) ||
      !/^[1-9][0-9]*$/.test(e.amountMinor)
    )
      throw new PostingError(
        "AMOUNT_INVALID",
        "Amounts must be positive integer minor-unit strings",
      );
  if (total(input.entries, "DEBIT") !== total(input.entries, "CREDIT"))
    throw new PostingError(
      "POSTING_UNBALANCED",
      "Total debits must equal total credits",
    );
}
function total(
  entries: PostingCommand["entries"],
  direction: "DEBIT" | "CREDIT",
): bigint {
  return entries
    .filter((e) => e.direction === direction)
    .reduce((sum, e) => sum + BigInt(e.amountMinor), 0n);
}
function commandHash(input: PostingCommand): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        reference: input.reference,
        currency: input.currency,
        entries: input.entries,
      }),
    )
    .digest("hex");
}
