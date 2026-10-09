import type { Knex } from "knex";

// The baseline snapshot carries no privileges, and on a database built from it
// 202609110002/0007/0009/0010/0011/0013 return early because their schema is
// already present, so their grants never run. Restate those grants verbatim,
// then grant the runtime reads of accounts, books and periods that no
// migration covered. Grants only: DELETE stays ungranted and RLS still
// applies (the roles are NOBYPASSRLS). Every statement is idempotent.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    GRANT USAGE ON SCHEMA public TO parc_ledger_runtime,parc_ledger_worker,parc_ledger_readonly;
    GRANT SELECT,INSERT,UPDATE ON public.ledger_transactions,public.journals,public.journal_entries,public.ledger_account_balances,public.ledger_outbox_events,public.ledger_audit_logs TO parc_ledger_runtime,parc_ledger_worker;
    GRANT SELECT ON public.ledger_accounts,public.ledger_books,public.accounting_periods,public.ledger_transactions,public.journals,public.journal_entries,public.ledger_account_balances TO parc_ledger_readonly;
    GRANT SELECT,INSERT,UPDATE ON public.customer_ledger_accounts,public.ledger_tenant_accounts,public.ledger_command_idempotency TO parc_ledger_runtime,parc_ledger_worker;
    GRANT SELECT,INSERT,UPDATE ON public.account_holds,public.account_hold_releases,public.ledger_hold_actions TO parc_ledger_runtime,parc_ledger_worker;
    GRANT SELECT,INSERT,UPDATE ON public.transaction_reversals,public.transaction_adjustments,public.transaction_links TO parc_ledger_runtime,parc_ledger_worker;
    GRANT SELECT,INSERT,UPDATE ON public.ledger_inbox_events,public.ledger_outbox_events TO parc_ledger_worker;
    GRANT SELECT,INSERT,UPDATE ON public.ledger_integrity_checks,public.reconciliation_runs,public.reconciliation_items,public.reconciliation_exceptions TO parc_ledger_worker;
    -- Provisioning inserts accounts; posting and holds lock them FOR UPDATE, which requires UPDATE.
    GRANT SELECT,INSERT,UPDATE ON public.ledger_accounts TO parc_ledger_runtime,parc_ledger_worker;
    GRANT SELECT ON public.ledger_books,public.accounting_periods TO parc_ledger_runtime,parc_ledger_worker;
  `);
}

export function down(): Promise<never> {
  return Promise.reject(new Error("Ledger role grants are forward-only"));
}
