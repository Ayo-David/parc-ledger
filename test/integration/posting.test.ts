import { randomUUID } from "node:crypto";
import knex, { type Knex } from "knex";
import { PostingService } from "../../src/services/posting-service.js";
import { AccountProvisioningService } from "../../src/services/account-provisioning-service.js";
import { HoldService } from "../../src/services/hold-service.js";
import { ReversalService } from "../../src/services/reversal-service.js";
import { AdjustmentService } from "../../src/services/adjustment-service.js";
import { EventWorker } from "../../src/services/event-worker.js";
import { IntegrityWorker } from "../../src/services/integrity-worker.js";
import { BalanceQueryService } from "../../src/services/balance-query-service.js";
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
describeDatabase("synchronous double-entry posting", () => {
  let db: Knex;
  let posting: PostingService;
  let accounts: AccountProvisioningService;
  let holds: HoldService;
  let reversals: ReversalService;
  let adjustments: AdjustmentService;
  let integrity: IntegrityWorker;
  let balances: BalanceQueryService;
  const tenantId = randomUUID();
  const entityId = randomUUID();
  const bookId = randomUUID();
  const debitId = randomUUID();
  const creditId = randomUUID();
  beforeAll(async () => {
    db = knex({ client: "pg", connection: databaseUrl! });
    posting = new PostingService(db);
    accounts = new AccountProvisioningService(db);
    holds = new HoldService(db, posting);
    reversals = new ReversalService(db, posting);
    adjustments = new AdjustmentService(db, posting, {
      consume: () => Promise.resolve(),
      report: () => Promise.resolve(),
    });
    integrity = new IntegrityWorker(db, "test-integrity-worker");
    balances = new BalanceQueryService(db);
    await db("ledger_entities").insert({
      id: entityId,
      tenant_id: tenantId,
      entity_code: `E${entityId.slice(0, 8)}`,
      entity_name: "Posting Test Entity",
      entity_type: "TENANT",
    });
    await db("ledger_books").insert({
      id: bookId,
      tenant_id: tenantId,
      entity_id: entityId,
      book_code: `B${bookId.slice(0, 8)}`,
      book_name: "Posting Test Book",
      base_currency: "NGN",
      is_primary: true,
    });
    await db("ledger_accounts").insert([
      {
        id: debitId,
        tenant_id: tenantId,
        book_id: bookId,
        account_code: `D${debitId.slice(0, 8)}`,
        account_name: "Debit",
        account_type: "ASSET",
        currency_code: "NGN",
        normal_balance: "DEBIT",
      },
      {
        id: creditId,
        tenant_id: tenantId,
        book_id: bookId,
        account_code: `C${creditId.slice(0, 8)}`,
        account_name: "Credit",
        account_type: "LIABILITY",
        currency_code: "NGN",
        normal_balance: "CREDIT",
      },
    ]);
  });
  afterAll(async () => {
    await db("ledger_inbox_events").where({ tenant_id: tenantId }).delete();
    await db("reconciliation_exceptions")
      .where({ tenant_id: tenantId })
      .delete();
    await db("reconciliation_items").where({ tenant_id: tenantId }).delete();
    await db("reconciliation_runs").where({ tenant_id: tenantId }).delete();
    await db.raw(
      "ALTER TABLE ledger_integrity_checks DISABLE TRIGGER trg_prevent_completed_integrity_change",
    );
    await db("ledger_integrity_checks").where({ tenant_id: tenantId }).delete();
    await db.raw(
      "ALTER TABLE ledger_integrity_checks ENABLE TRIGGER trg_prevent_completed_integrity_change",
    );
    await db("ledger_outbox_events").where({ tenant_id: tenantId }).delete();
    await db("ledger_audit_logs").where({ tenant_id: tenantId }).delete();
    await db.raw(
      "ALTER TABLE transaction_reversals DISABLE TRIGGER trg_prevent_transaction_reversal_change",
    );
    await db("transaction_reversals").where({ tenant_id: tenantId }).delete();
    await db.raw(
      "ALTER TABLE transaction_reversals ENABLE TRIGGER trg_prevent_transaction_reversal_change",
    );
    await db("transaction_links").where({ tenant_id: tenantId }).delete();
    await db.raw(
      "ALTER TABLE transaction_adjustments DISABLE TRIGGER trg_prevent_posted_adjustment_change",
    );
    await db("transaction_adjustments").where({ tenant_id: tenantId }).delete();
    await db.raw(
      "ALTER TABLE transaction_adjustments ENABLE TRIGGER trg_prevent_posted_adjustment_change",
    );
    await db("ledger_hold_actions").where({ tenant_id: tenantId }).delete();
    await db("account_hold_releases").where({ tenant_id: tenantId }).delete();
    await db.raw(
      "ALTER TABLE account_holds DISABLE TRIGGER trg_prevent_account_hold_lifecycle_change",
    );
    await db("account_holds").where({ tenant_id: tenantId }).delete();
    await db.raw(
      "ALTER TABLE account_holds ENABLE TRIGGER trg_prevent_account_hold_lifecycle_change",
    );
    await db.raw(
      "ALTER TABLE journal_entries DISABLE TRIGGER trg_prevent_posted_entry_change",
    );
    await db("journal_entries").where({ tenant_id: tenantId }).delete();
    await db.raw(
      "ALTER TABLE journal_entries ENABLE TRIGGER trg_prevent_posted_entry_change",
    );
    await db.raw(
      "ALTER TABLE journals DISABLE TRIGGER trg_prevent_posted_journal_delete",
    );
    await db("journals").where({ tenant_id: tenantId }).delete();
    await db.raw(
      "ALTER TABLE journals ENABLE TRIGGER trg_prevent_posted_journal_delete",
    );
    await db.raw(
      "ALTER TABLE ledger_transactions DISABLE TRIGGER trg_prevent_completed_transaction_change",
    );
    await db("ledger_transactions").where({ tenant_id: tenantId }).delete();
    await db.raw(
      "ALTER TABLE ledger_transactions ENABLE TRIGGER trg_prevent_completed_transaction_change",
    );
    await db("ledger_account_balances").where({ tenant_id: tenantId }).delete();
    await db("accounting_periods").where({ tenant_id: tenantId }).delete();
    await db("customer_ledger_accounts")
      .where({ tenant_id: tenantId })
      .delete();
    await db("ledger_tenant_accounts").where({ tenant_id: tenantId }).delete();
    await db("ledger_command_idempotency")
      .where({ tenant_id: tenantId })
      .delete();
    await db("ledger_accounts").where({ tenant_id: tenantId }).delete();
    await db("ledger_books").where({ tenant_id: tenantId }).delete();
    await db("ledger_entities").where({ tenant_id: tenantId }).delete();
    await db.destroy();
  });
  it("posts balanced entries atomically, refreshes balances, and replays exact idempotency", async () => {
    const input = {
      tenantId,
      reference: `POST-${randomUUID()}`,
      currency: "NGN",
      entries: [
        {
          accountId: debitId,
          direction: "DEBIT" as const,
          amountMinor: "12500",
        },
        {
          accountId: creditId,
          direction: "CREDIT" as const,
          amountMinor: "12500",
        },
      ],
      idempotencyKey: randomUUID(),
      sourceService: "parc-payment",
      correlationId: randomUUID(),
    };
    const first = await posting.post(input);
    expect(first).toMatchObject({ status: "POSTED", replayed: false });
    const replay = await posting.post(input);
    expect(replay).toMatchObject({
      transaction_id: first.transaction_id,
      replayed: true,
    });
    expect(
      await db("ledger_account_balances")
        .where({ account_id: debitId })
        .first(),
    ).toMatchObject({ balance: "12500", available_balance: "12500" });
    await expect(
      db("journal_entries").insert({
        tenant_id: tenantId,
        journal_id: first.journal_id,
        account_id: debitId,
        entry_type: "DEBIT",
        amount: 1,
        currency_code: "NGN",
        entry_sequence: 3,
      }),
    ).rejects.toThrow(/immutable/);
    await expect(
      posting.post({
        ...input,
        entries: [
          { ...input.entries[0]!, amountMinor: "13000" },
          { ...input.entries[1]!, amountMinor: "13000" },
        ],
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    const event = await db("ledger_outbox_events")
      .where({ aggregate_id: first.transaction_id })
      .first<{
        payload: { total_debits_minor: string; total_credits_minor: string };
      }>();
    expect(event?.payload.total_debits_minor).toBe("12500");
    expect(event?.payload.total_credits_minor).toBe("12500");
  });
  it("rejects unbalanced postings before persistence", async () => {
    await expect(
      posting.post({
        tenantId,
        reference: `BAD-${randomUUID()}`,
        currency: "NGN",
        entries: [
          { accountId: debitId, direction: "DEBIT", amountMinor: "2" },
          { accountId: creditId, direction: "CREDIT", amountMinor: "1" },
        ],
        idempotencyKey: randomUUID(),
        sourceService: "parc-payment",
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "POSTING_UNBALANCED" });
  });
  it("serializes simultaneous postings and rejects a closed accounting period", async () => {
    const command = (suffix: string) => ({
      tenantId,
      reference: `CONCURRENT-${suffix}-${randomUUID()}`,
      currency: "NGN",
      entries: [
        {
          accountId: debitId,
          direction: "DEBIT" as const,
          amountMinor: "1000",
        },
        {
          accountId: creditId,
          direction: "CREDIT" as const,
          amountMinor: "1000",
        },
      ],
      idempotencyKey: randomUUID(),
      sourceService: "parc-payment",
      correlationId: randomUUID(),
    });
    await Promise.all([posting.post(command("A")), posting.post(command("B"))]);
    expect(
      await db("ledger_account_balances")
        .where({ account_id: debitId })
        .first(),
    ).toMatchObject({ balance: "14500" });
    const today = new Date().toISOString().slice(0, 10);
    await db("accounting_periods").insert({
      tenant_id: tenantId,
      book_id: bookId,
      period_code: `CLOSED-${randomUUID().slice(0, 8)}`,
      start_date: today,
      end_date: today,
      status: "CLOSED",
    });
    await expect(posting.post(command("CLOSED"))).rejects.toMatchObject({
      code: "ACCOUNTING_PERIOD_CLOSED",
    });
  });
  it("provisions currency-specific ownership accounts idempotently and emits the contract event", async () => {
    const customerId = randomUUID();
    const input = {
      tenantId,
      ownerType: "CUSTOMER" as const,
      ownerId: customerId,
      purpose: "ORDINARY_SAVINGS",
      accountType: "LIABILITY" as const,
      currency: "NGN",
      idempotencyKey: randomUUID(),
      sourceService: "parc-auth-customer",
      correlationId: randomUUID(),
    };
    const created = await accounts.provision(input);
    const replay = await accounts.provision(input);
    expect(replay).toMatchObject({
      account_id: created.account_id,
      replayed: true,
    });
    const duplicateNaturalKey = await accounts.provision({
      ...input,
      idempotencyKey: randomUUID(),
    });
    expect(duplicateNaturalKey).toMatchObject({
      account_id: created.account_id,
      replayed: true,
    });
    expect(
      await db("customer_ledger_accounts")
        .where({ ledger_account_id: created.account_id })
        .first(),
    ).toMatchObject({ customer_id: customerId, currency_code: "NGN" });
    const event = await db("ledger_outbox_events")
      .where({
        aggregate_id: created.account_id,
        event_type: "ledger.account-created.v1",
      })
      .first<{ payload: { owner_id: string; currency: string } }>();
    expect(event?.payload).toEqual({
      account_id: created.account_id,
      owner_id: customerId,
      currency: "NGN",
    });
    await expect(
      accounts.provision({ ...input, purpose: "TARGET_SAVINGS" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await expect(
      accounts.provision({
        ...input,
        idempotencyKey: randomUUID(),
        currency: "USD",
      }),
    ).rejects.toMatchObject({ code: "CURRENCY_NOT_ENABLED" });
  });
  it("resolves an authoritative currency-separated customer wallet balance", async () => {
    const customerId = randomUUID();
    const wallet = await accounts.provision({
      tenantId,
      ownerType: "CUSTOMER",
      ownerId: customerId,
      purpose: "WALLET",
      accountType: "LIABILITY",
      currency: "NGN",
      idempotencyKey: randomUUID(),
      sourceService: "parc-mobile-bff",
      correlationId: randomUUID(),
    });
    await db("ledger_account_balances").insert({
      tenant_id: tenantId,
      account_id: wallet.account_id,
      currency_code: "NGN",
      posted_credit: "25000",
      balance: "25000",
      held_balance: "1500",
      available_balance: "23500",
      version: 2,
    });
    await expect(
      balances.customerWallet({ tenantId, customerId, currency: "NGN" }),
    ).resolves.toEqual({
      account_id: wallet.account_id,
      currency: "NGN",
      posted_balance_minor: "25000",
      held_balance_minor: "1500",
      available_balance_minor: "23500",
      version: 2,
    });
    await expect(
      balances.customerWallet({
        tenantId,
        customerId: randomUUID(),
        currency: "NGN",
      }),
    ).rejects.toMatchObject({ code: "CUSTOMER_WALLET_NOT_FOUND" });
    await db("ledger_account_balances")
      .where({ account_id: wallet.account_id })
      .delete();
    await db("ledger_outbox_events")
      .where({ aggregate_id: wallet.account_id })
      .delete();
    await db("ledger_audit_logs")
      .where({ entity_id: wallet.account_id })
      .delete();
    await db("customer_ledger_accounts")
      .where({ ledger_account_id: wallet.account_id })
      .delete();
    await db("ledger_command_idempotency")
      .where({ resource_id: wallet.account_id })
      .delete();
    await db("ledger_accounts").where({ id: wallet.account_id }).delete();
  });
  it("reserves available balance exactly once, releases, captures atomically, and expires due holds", async () => {
    await db("accounting_periods").where({ tenant_id: tenantId }).delete();
    const makeHold = (amountMinor: string, key = randomUUID()) => ({
      tenantId,
      accountId: debitId,
      amountMinor,
      currency: "NGN",
      purpose: "TRANSFER",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      idempotencyKey: key,
      sourceService: "parc-payment",
      correlationId: randomUUID(),
    });
    const firstInput = makeHold("5000");
    const first = await holds.create(firstInput);
    expect(await holds.create(firstInput)).toMatchObject({
      hold_id: first.hold_id,
      replayed: true,
    });
    expect(
      await db("ledger_account_balances")
        .where({ account_id: debitId })
        .first(),
    ).toMatchObject({ held_balance: "5000", available_balance: "9500" });
    const concurrent = await Promise.allSettled([
      holds.create(makeHold("6000")),
      holds.create(makeHold("6000")),
    ]);
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const extra = concurrent.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof holds.create>>
      > => result.status === "fulfilled",
    )!.value;
    await holds.release({
      tenantId,
      holdId: extra.hold_id,
      idempotencyKey: randomUUID(),
      sourceService: "parc-payment",
      correlationId: randomUUID(),
    });
    const captured = await holds.capture({
      tenantId,
      holdId: first.hold_id,
      idempotencyKey: randomUUID(),
      sourceService: "parc-payment",
      correlationId: randomUUID(),
      reference: `CAPTURE-${randomUUID()}`,
      entries: [
        { accountId: debitId, direction: "CREDIT", amountMinor: "5000" },
        { accountId: creditId, direction: "DEBIT", amountMinor: "5000" },
      ],
    });
    expect(captured).toMatchObject({ status: "CAPTURED", replayed: false });
    expect(
      await db("account_holds").where({ id: first.hold_id }).first(),
    ).toMatchObject({
      status: "CAPTURED",
      capture_transaction_id: captured.transaction_id,
    });
    expect(
      await db("ledger_account_balances")
        .where({ account_id: debitId })
        .first(),
    ).toMatchObject({
      balance: "9500",
      held_balance: "0",
      available_balance: "9500",
    });
    const expiring = await holds.create(makeHold("1000"));
    await db("account_holds")
      .where({ id: expiring.hold_id })
      .update({ expires_at: new Date(Date.now() - 1_000) });
    expect(await holds.expireDue(tenantId)).toBe(1);
    expect(
      await db("account_holds").where({ id: expiring.hold_id }).first(),
    ).toMatchObject({ status: "EXPIRED" });
  });
  it("creates one immutable full compensating reversal", async () => {
    const original = await posting.post({
      tenantId,
      reference: `REVERSIBLE-${randomUUID()}`,
      currency: "NGN",
      entries: [
        { accountId: debitId, direction: "DEBIT", amountMinor: "700" },
        { accountId: creditId, direction: "CREDIT", amountMinor: "700" },
      ],
      idempotencyKey: randomUUID(),
      sourceService: "parc-payment",
      correlationId: randomUUID(),
    });
    const input = {
      tenantId,
      transactionId: original.transaction_id,
      reason: "Provider reported final failure",
      idempotencyKey: randomUUID(),
      sourceService: "parc-payment",
      correlationId: randomUUID(),
      automatedRuleId: "failed-transfer-reversal-v1",
    };
    const reversal = await reversals.reverse(input);
    expect(await reversals.reverse(input)).toMatchObject({
      reversal_transaction_id: reversal.reversal_transaction_id,
      replayed: true,
    });
    expect(
      await db("transaction_reversals")
        .where({ original_transaction_id: original.transaction_id })
        .first(),
    ).toMatchObject({
      reversal_transaction_id: reversal.reversal_transaction_id,
    });
    await expect(
      reversals.reverse({
        ...input,
        idempotencyKey: randomUUID(),
        reason: "Different reason",
      }),
    ).rejects.toMatchObject({ code: "REVERSAL_ALREADY_EXISTS" });
  });
  it("posts a manual adjustment only after consuming its bound approval", async () => {
    const result = await adjustments.post({
      tenantId,
      approvalId: randomUUID(),
      reference: `ADJ-${randomUUID()}`,
      currency: "NGN",
      reason: "Correct approved operational discrepancy",
      entries: [
        { accountId: debitId, direction: "DEBIT", amountMinor: "250" },
        { accountId: creditId, direction: "CREDIT", amountMinor: "250" },
      ],
      idempotencyKey: randomUUID(),
      sourceService: "parc-ledger",
      correlationId: randomUUID(),
    });
    expect(result.replayed).toBe(false);
    const stored = await db("transaction_adjustments")
      .where({ id: result.adjustment_id })
      .first<{
        approval_id: string;
        posted_transaction_id: string;
        status: string;
      }>();
    expect(stored?.approval_id).toBeTruthy();
    expect(stored).toMatchObject({
      posted_transaction_id: result.transaction_id,
      status: "POSTED",
    });
  });
  it("leases, confirms, retries outbox events and deduplicates inbox events", async () => {
    const worker = new EventWorker(db, "test-worker");
    const eventId = randomUUID();
    await db("ledger_outbox_events").where({ tenant_id: tenantId }).delete();
    await db("ledger_outbox_events").insert({
      id: eventId,
      tenant_id: tenantId,
      aggregate_type: "test",
      aggregate_id: debitId,
      event_type: "ledger.test.v1",
      payload: { safe: true },
      idempotency_key: `worker-${eventId}`,
    });
    let publishedBody: Record<string, unknown> | undefined;
    const channel = {
      publish: (
        _exchange: string,
        _key: string,
        body: Buffer,
        _options: unknown,
        callback: (error: Error | null) => void,
      ) => {
        publishedBody = JSON.parse(body.toString()) as Record<string, unknown>;
        callback(null);
        return true;
      },
      waitForConfirms: () => Promise.resolve(),
    };
    expect(await worker.publishOne(channel as never)).toBe(true);
    expect(publishedBody).toMatchObject({
      event_id: eventId,
      aggregate_type: "test",
      aggregate_version: 1,
      data_classification: "INTERNAL",
    });
    expect(publishedBody).toHaveProperty("occurred_at");
    expect(publishedBody).toHaveProperty("idempotency_key");
    expect(
      await db("ledger_outbox_events").where({ id: eventId }).first(),
    ).toMatchObject({ status: "PUBLISHED" });
    const inbound = {
      tenantId,
      sourceService: "parc-payment",
      eventId: randomUUID(),
      eventType: "payment.collection-confirmed.v1",
      eventVersion: 1,
      payload: { amount_minor: "1" },
    };
    expect(await worker.receive(inbound)).toBe(true);
    expect(await worker.receive(inbound)).toBe(false);
  });
  it("records balance drift and reconciliation exceptions without changing journals", async () => {
    await db("ledger_account_balances")
      .where({ account_id: debitId })
      .update({ balance: "1" });
    const run = `DRIFT-${randomUUID()}`;
    expect(await integrity.runBalanceDrift(tenantId, run)).toMatchObject({
      discrepancies: 1,
    });
    expect(await integrity.runBalanceDrift(tenantId, run)).toMatchObject({
      discrepancies: 1,
    });
    const runId = randomUUID();
    await db("reconciliation_runs").insert({
      id: runId,
      tenant_id: tenantId,
      run_reference: `REC-${randomUUID()}`,
      source_system: "PAYSTACK",
      reconciliation_date: new Date().toISOString().slice(0, 10),
      source_payload_hash: "a".repeat(64),
      idempotency_key: randomUUID(),
    });
    const reconciliationInput = {
      tenantId,
      runId,
      reference: `REF-${randomUUID()}`,
      sourceAmount: "100",
      ledgerAmount: "99",
      currency: "NGN",
      idempotencyKey: randomUUID(),
    };
    await integrity.recordReconciliationItem(reconciliationInput);
    await integrity.recordReconciliationItem(reconciliationInput);
    expect(
      await db("reconciliation_items")
        .where({ reconciliation_run_id: runId })
        .count<{ count: string }[]>("* AS count")
        .first(),
    ).toMatchObject({ count: "1" });
    expect(
      await db("reconciliation_exceptions")
        .where({ tenant_id: tenantId })
        .first(),
    ).toMatchObject({ exception_code: "AMOUNT_MISMATCH" });
  });
});
