import type { Knex } from "knex";

/** Approved LEDGER-DB-23: keep validation pure to prevent recursive row updates. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION public.validate_journal_balance(p_journal_id uuid)
    RETURNS void LANGUAGE plpgsql AS $$
    DECLARE
      v_debits numeric(20,2);
      v_credits numeric(20,2);
      v_entry_count integer;
      v_journal_currency char(3);
      v_journal_tenant uuid;
      v_journal_book uuid;
      v_invalid_scope_count integer;
    BEGIN
      SELECT currency_code, tenant_id, book_id
      INTO v_journal_currency, v_journal_tenant, v_journal_book
      FROM public.journals WHERE id = p_journal_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Journal % does not exist.', p_journal_id; END IF;

      SELECT
        COALESCE(SUM(CASE WHEN entry_type='DEBIT' THEN amount ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN entry_type='CREDIT' THEN amount ELSE 0 END),0),
        COUNT(*)
      INTO v_debits, v_credits, v_entry_count
      FROM public.journal_entries WHERE journal_id = p_journal_id;
      IF v_entry_count < 2 THEN RAISE EXCEPTION 'Journal % must contain at least two entries.', p_journal_id; END IF;

      SELECT COUNT(*) INTO v_invalid_scope_count
      FROM public.journal_entries je
      INNER JOIN public.ledger_accounts la ON la.id = je.account_id
      WHERE je.journal_id = p_journal_id
        AND (
          je.tenant_id <> v_journal_tenant
          OR la.tenant_id <> v_journal_tenant
          OR la.book_id <> v_journal_book
          OR je.currency_code <> v_journal_currency
          OR la.currency_code <> v_journal_currency
          OR la.status <> 'ACTIVE'
          OR la.deleted_at IS NOT NULL
        );
      IF v_invalid_scope_count > 0 THEN
        RAISE EXCEPTION 'Journal % contains entries/accounts outside its tenant, book or currency scope, or uses inactive accounts.', p_journal_id;
      END IF;
      IF v_debits <> v_credits THEN
        RAISE EXCEPTION 'Unbalanced journal %. Debits: %, Credits: %.', p_journal_id, v_debits, v_credits;
      END IF;
    END
    $$;
  `);
}

export function down(): Promise<never> {
  return Promise.reject(
    new Error("Journal validation reentrancy correction is forward-only"),
  );
}
