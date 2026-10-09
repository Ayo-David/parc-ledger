import { randomUUID } from "node:crypto";
import knex, { type Knex } from "knex";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

// Tables the API services (and the posting triggers they fire) touch. Other
// integration suites connect as the schema owner, so they cannot catch a
// missing grant for the runtime login.
const runtimeGrants: Readonly<Record<string, readonly string[]>> = {
  ledger_accounts: ["SELECT", "INSERT", "UPDATE"],
  ledger_books: ["SELECT"],
  accounting_periods: ["SELECT"],
  customer_ledger_accounts: ["SELECT", "INSERT", "UPDATE"],
  ledger_tenant_accounts: ["SELECT", "INSERT", "UPDATE"],
  ledger_command_idempotency: ["SELECT", "INSERT", "UPDATE"],
  ledger_transactions: ["SELECT", "INSERT", "UPDATE"],
  journals: ["SELECT", "INSERT", "UPDATE"],
  journal_entries: ["SELECT", "INSERT", "UPDATE"],
  ledger_account_balances: ["SELECT", "INSERT", "UPDATE"],
  ledger_outbox_events: ["SELECT", "INSERT", "UPDATE"],
  ledger_audit_logs: ["SELECT", "INSERT", "UPDATE"],
  account_holds: ["SELECT", "INSERT", "UPDATE"],
  account_hold_releases: ["SELECT", "INSERT", "UPDATE"],
  ledger_hold_actions: ["SELECT", "INSERT", "UPDATE"],
  transaction_reversals: ["SELECT", "INSERT", "UPDATE"],
  transaction_adjustments: ["SELECT", "INSERT", "UPDATE"],
  transaction_links: ["SELECT", "INSERT", "UPDATE"],
  customer_statement_requests: ["SELECT", "INSERT"],
};

describeDatabase("ledger runtime role grants", () => {
  let db: Knex;
  beforeAll(() => {
    db = knex({ client: "pg", connection: databaseUrl! });
  });
  afterAll(async () => {
    await db.destroy();
  });

  it("grants the runtime role every privilege the services need and no DELETE", async () => {
    const missing: string[] = [];
    for (const [table, privileges] of Object.entries(runtimeGrants)) {
      for (const privilege of [...privileges, "DELETE"]) {
        const { rows } = await db.raw<{
          rows: { granted: boolean }[];
        }>(
          "SELECT has_table_privilege('parc_ledger_runtime', ?, ?) AS granted",
          [`public.${table}`, privilege],
        );
        if (rows[0]!.granted !== (privilege !== "DELETE"))
          missing.push(`${privilege} ${table}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("lets the runtime role resolve a customer wallet under tenant RLS", async () => {
    const tenantId = randomUUID();
    const tx = await db.transaction();
    try {
      await tx.raw("SET LOCAL ROLE parc_ledger_runtime");
      await tx.raw("SELECT set_config('app.current_tenant_id', ?, true)", [
        tenantId,
      ]);
      await expect(
        tx("customer_ledger_accounts as m")
          .join("ledger_accounts as a", "a.id", "m.ledger_account_id")
          .where({ "m.tenant_id": tenantId, "m.account_purpose": "WALLET" })
          .first("m.ledger_account_id"),
      ).resolves.toBeUndefined();
      await expect(
        tx("ledger_books").where({ tenant_id: tenantId }).first("id"),
      ).resolves.toBeUndefined();
      await expect(
        tx("accounting_periods").where({ tenant_id: tenantId }).first("id"),
      ).resolves.toBeUndefined();
    } finally {
      await tx.rollback();
    }
  });
});
