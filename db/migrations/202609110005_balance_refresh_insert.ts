import type { Knex } from "knex";
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
CREATE OR REPLACE FUNCTION public.refresh_ledger_account_balance(p_account_id uuid, p_currency character) RETURNS void LANGUAGE plpgsql AS $$
DECLARE debits bigint; credits bigint; normal account_nature; held bigint; last_entry uuid; computed bigint;
BEGIN
 SELECT normal_balance INTO normal FROM ledger_accounts WHERE id=p_account_id AND status='ACTIVE' AND deleted_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Active ledger account % does not exist',p_account_id; END IF;
 SELECT COALESCE(SUM(CASE WHEN je.entry_type='DEBIT' THEN je.amount ELSE 0 END),0)::bigint,COALESCE(SUM(CASE WHEN je.entry_type='CREDIT' THEN je.amount ELSE 0 END),0)::bigint INTO debits,credits FROM journal_entries je JOIN journals j ON j.id=je.journal_id WHERE je.account_id=p_account_id AND je.currency_code=p_currency AND j.status='POSTED';
 SELECT COALESCE(SUM(amount),0)::bigint INTO held FROM account_holds WHERE account_id=p_account_id AND currency_code=p_currency AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>now());
 SELECT je.id INTO last_entry FROM journal_entries je JOIN journals j ON j.id=je.journal_id WHERE je.account_id=p_account_id AND je.currency_code=p_currency AND j.status='POSTED' ORDER BY j.posted_at DESC,je.entry_sequence DESC LIMIT 1;
 computed:=CASE WHEN normal='DEBIT' THEN debits-credits ELSE credits-debits END;
 INSERT INTO ledger_account_balances (tenant_id,account_id,currency_code,posted_debit,posted_credit,balance,available_balance,held_balance,last_entry_id,version,calculated_at,updated_at) SELECT tenant_id,p_account_id,p_currency,debits,credits,computed,computed-held,last_entry,1,now(),now() FROM ledger_accounts WHERE id=p_account_id ON CONFLICT (account_id,currency_code) DO UPDATE SET posted_debit=EXCLUDED.posted_debit,posted_credit=EXCLUDED.posted_credit,balance=EXCLUDED.balance,available_balance=EXCLUDED.available_balance,held_balance=EXCLUDED.held_balance,last_entry_id=EXCLUDED.last_entry_id,version=ledger_account_balances.version+1,calculated_at=now(),updated_at=now();
END $$;
`);
}
export function down(): Promise<never> {
  return Promise.reject(
    new Error("Balance refresh correction is forward-only"),
  );
}
