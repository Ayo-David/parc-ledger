import type { Knex } from "knex";
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
CREATE OR REPLACE FUNCTION public.journal_posting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE debits bigint; credits bigint;
BEGIN
  IF NEW.status='POSTED' AND OLD.status<>'POSTED' THEN
    IF current_setting('app.ledger_posting',true)='true' THEN RETURN NEW; END IF;
    PERFORM validate_journal_balance(NEW.id);
    SELECT COALESCE(SUM(CASE WHEN entry_type='DEBIT' THEN amount ELSE 0 END),0)::bigint,COALESCE(SUM(CASE WHEN entry_type='CREDIT' THEN amount ELSE 0 END),0)::bigint INTO debits,credits FROM journal_entries WHERE journal_id=NEW.id;
    NEW.total_debits=debits; NEW.total_credits=credits; NEW.posted_at=COALESCE(NEW.posted_at,now());
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.post_journal(p_journal_id uuid, p_actor_id uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE entry record; debits bigint; credits bigint;
BEGIN
  PERFORM validate_journal_balance(p_journal_id);
  SELECT COALESCE(SUM(CASE WHEN entry_type='DEBIT' THEN amount ELSE 0 END),0)::bigint,COALESCE(SUM(CASE WHEN entry_type='CREDIT' THEN amount ELSE 0 END),0)::bigint INTO debits,credits FROM journal_entries WHERE journal_id=p_journal_id;
  PERFORM set_config('app.ledger_posting','true',true);
  UPDATE journals SET status='POSTED',posted_at=now(),posted_by=p_actor_id,total_debits=debits,total_credits=credits WHERE id=p_journal_id AND status IN ('DRAFT','PENDING');
  IF NOT FOUND THEN RAISE EXCEPTION 'Journal % cannot be posted',p_journal_id; END IF;
  FOR entry IN SELECT DISTINCT account_id,currency_code FROM journal_entries WHERE journal_id=p_journal_id ORDER BY account_id FOR UPDATE LOOP PERFORM refresh_ledger_account_balance(entry.account_id,entry.currency_code); END LOOP;
  UPDATE ledger_transactions SET status='COMPLETED',completed_at=COALESCE(completed_at,now()) WHERE id=(SELECT transaction_id FROM journals WHERE id=p_journal_id) AND status IN ('PENDING','PROCESSING');
END $$;
`);
}
export function down(): Promise<never> {
  return Promise.reject(
    new Error("Posting trigger correction is forward-only"),
  );
}
