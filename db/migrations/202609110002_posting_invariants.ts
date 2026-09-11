import type { Knex } from "knex";

export const config = { transaction: false };
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn("ledger_transactions", "request_hash"))
    return;
  await knex.raw(`
    DO $money$
    DECLARE r record; fractional bigint;
    BEGIN
      FOR r IN SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND data_type='numeric' AND numeric_scale=2 LOOP
        EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I <> trunc(%I)', r.table_schema, r.table_name, r.column_name, r.column_name) INTO fractional;
        IF fractional > 0 THEN RAISE EXCEPTION 'Cannot convert %.%: fractional major-unit values require an approved backfill', r.table_name, r.column_name; END IF;
        EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I TYPE bigint USING %I::bigint', r.table_schema, r.table_name, r.column_name, r.column_name);
      END LOOP;
    END $money$;
    ALTER TABLE public.ledger_transactions ADD COLUMN IF NOT EXISTS request_hash char(64);
    ALTER TABLE public.ledger_transactions ALTER COLUMN idempotency_key SET NOT NULL;
    ALTER TABLE public.ledger_transactions ALTER COLUMN request_hash SET NOT NULL;
    ALTER TABLE public.journals ADD CONSTRAINT uq_journal_transaction UNIQUE (transaction_id);
    CREATE OR REPLACE FUNCTION public.prevent_posted_journal_entry_change() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE state journal_status; journal uuid;
    BEGIN
      journal := COALESCE(NEW.journal_id, OLD.journal_id);
      SELECT status INTO state FROM journals WHERE id=journal;
      IF state IN ('POSTED','REVERSED') THEN RAISE EXCEPTION 'Posted/reversed journal entries are immutable'; END IF;
      RETURN COALESCE(NEW, OLD);
    END $$;
    DROP TRIGGER IF EXISTS trg_prevent_posted_entry_update ON public.journal_entries;
    CREATE TRIGGER trg_prevent_posted_entry_change BEFORE INSERT OR UPDATE OR DELETE ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_journal_entry_change();
    CREATE OR REPLACE FUNCTION public.prevent_completed_ledger_transaction_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status IN ('COMPLETED','REVERSED') AND (TG_OP='DELETE' OR NEW.book_id IS DISTINCT FROM OLD.book_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency_code IS DISTINCT FROM OLD.currency_code OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.transaction_type IS DISTINCT FROM OLD.transaction_type) THEN RAISE EXCEPTION 'Completed/reversed ledger transactions are immutable'; END IF;
      RETURN COALESCE(NEW, OLD);
    END $$;
    CREATE TRIGGER trg_prevent_completed_transaction_change BEFORE UPDATE OR DELETE ON public.ledger_transactions FOR EACH ROW EXECUTE FUNCTION public.prevent_completed_ledger_transaction_change();
    CREATE OR REPLACE FUNCTION public.refresh_ledger_account_balance(p_account_id uuid, p_currency character) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE debits bigint; credits bigint; normal account_nature; held bigint; last_entry uuid; computed bigint;
    BEGIN
      SELECT normal_balance INTO normal FROM ledger_accounts WHERE id=p_account_id AND status='ACTIVE' AND deleted_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Active ledger account % does not exist', p_account_id; END IF;
      SELECT COALESCE(SUM(CASE WHEN je.entry_type='DEBIT' THEN je.amount ELSE 0 END),0)::bigint, COALESCE(SUM(CASE WHEN je.entry_type='CREDIT' THEN je.amount ELSE 0 END),0)::bigint INTO debits,credits FROM journal_entries je JOIN journals j ON j.id=je.journal_id WHERE je.account_id=p_account_id AND je.currency_code=p_currency AND j.status='POSTED';
      SELECT COALESCE(SUM(amount),0)::bigint INTO held FROM account_holds WHERE account_id=p_account_id AND currency_code=p_currency AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>now());
      SELECT je.id INTO last_entry FROM journal_entries je JOIN journals j ON j.id=je.journal_id WHERE je.account_id=p_account_id AND je.currency_code=p_currency AND j.status='POSTED' ORDER BY j.posted_at DESC,je.entry_sequence DESC LIMIT 1;
      computed := CASE WHEN normal='DEBIT' THEN debits-credits ELSE credits-debits END;
      INSERT INTO ledger_account_balances (tenant_id,account_id,currency_code,posted_debit,posted_credit,balance,available_balance,held_balance,last_entry_id,version,calculated_at) SELECT tenant_id,p_account_id,p_currency,debits,credits,computed,computed-held,last_entry,1,now() FROM ledger_accounts WHERE id=p_account_id ON CONFLICT (account_id,currency_code) DO UPDATE SET posted_debit=EXCLUDED.posted_debit,posted_credit=EXCLUDED.posted_credit,balance=EXCLUDED.balance,available_balance=EXCLUDED.available_balance,held_balance=EXCLUDED.held_balance,last_entry_id=EXCLUDED.last_entry_id,version=ledger_account_balances.version+1,calculated_at=now();
    END $$;
    CREATE OR REPLACE FUNCTION public.post_journal(p_journal_id uuid, p_actor_id uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE entry record;
    BEGIN
      PERFORM validate_journal_balance(p_journal_id);
      UPDATE journals SET status='POSTED',posted_at=now(),posted_by=p_actor_id WHERE id=p_journal_id AND status IN ('DRAFT','PENDING');
      IF NOT FOUND THEN RAISE EXCEPTION 'Journal % cannot be posted',p_journal_id; END IF;
      FOR entry IN SELECT DISTINCT account_id,currency_code FROM journal_entries WHERE journal_id=p_journal_id ORDER BY account_id FOR UPDATE LOOP PERFORM refresh_ledger_account_balance(entry.account_id,entry.currency_code); END LOOP;
      UPDATE ledger_transactions SET status='COMPLETED',completed_at=COALESCE(completed_at,now()) WHERE id=(SELECT transaction_id FROM journals WHERE id=p_journal_id) AND status IN ('PENDING','PROCESSING');
    END $$;
    DO $roles$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='parc_ledger_runtime') THEN CREATE ROLE parc_ledger_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='parc_ledger_worker') THEN CREATE ROLE parc_ledger_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='parc_ledger_readonly') THEN CREATE ROLE parc_ledger_readonly NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
    END $roles$;
    ALTER TABLE public.ledger_transactions FORCE ROW LEVEL SECURITY; ALTER TABLE public.journals FORCE ROW LEVEL SECURITY; ALTER TABLE public.journal_entries FORCE ROW LEVEL SECURITY; ALTER TABLE public.ledger_account_balances FORCE ROW LEVEL SECURITY; ALTER TABLE public.ledger_accounts FORCE ROW LEVEL SECURITY; ALTER TABLE public.ledger_books FORCE ROW LEVEL SECURITY; ALTER TABLE public.accounting_periods FORCE ROW LEVEL SECURITY; ALTER TABLE public.ledger_outbox_events FORCE ROW LEVEL SECURITY; ALTER TABLE public.ledger_audit_logs FORCE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA public TO parc_ledger_runtime,parc_ledger_worker,parc_ledger_readonly;
    GRANT SELECT,INSERT,UPDATE ON public.ledger_transactions,public.journals,public.journal_entries,public.ledger_account_balances,public.ledger_outbox_events,public.ledger_audit_logs TO parc_ledger_runtime,parc_ledger_worker;
    GRANT SELECT ON public.ledger_accounts,public.ledger_books,public.accounting_periods,public.ledger_transactions,public.journals,public.journal_entries,public.ledger_account_balances TO parc_ledger_readonly;
  `);
}
export function down(): Promise<never> {
  return Promise.reject(
    new Error("Ledger posting invariants are forward-only"),
  );
}
