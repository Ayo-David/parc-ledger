import type { Knex } from "knex";

/** Approved LEDGER-DB-16 through LEDGER-DB-18. */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn("transaction_reversals", "request_hash"))
    return;
  await knex.raw(`
    ALTER TABLE public.transaction_reversals
      ADD COLUMN approval_id uuid,
      ADD COLUMN idempotency_key varchar(255),
      ADD COLUMN request_hash char(64),
      ADD COLUMN source_service varchar(100),
      ADD COLUMN completed_at timestamptz;
    UPDATE public.transaction_reversals SET approval_id=COALESCE(approval_id,gen_random_uuid()), idempotency_key=COALESCE(idempotency_key,id::text), request_hash=COALESCE(request_hash,encode(digest(id::text,'sha256'),'hex')), source_service=COALESCE(source_service,'legacy') WHERE approval_id IS NULL OR idempotency_key IS NULL OR request_hash IS NULL OR source_service IS NULL;
    ALTER TABLE public.transaction_reversals
      ALTER COLUMN idempotency_key SET NOT NULL,
      ALTER COLUMN request_hash SET NOT NULL,
      ALTER COLUMN source_service SET NOT NULL;
    ALTER TABLE public.transaction_reversals
      ADD CONSTRAINT uq_transaction_reversal_original UNIQUE (original_transaction_id),
      ADD CONSTRAINT uq_transaction_reversal_idempotency UNIQUE (tenant_id,idempotency_key);

    ALTER TABLE public.transaction_adjustments
      ADD COLUMN approval_id uuid,
      ADD COLUMN idempotency_key varchar(255),
      ADD COLUMN request_hash char(64),
      ADD COLUMN posted_transaction_id uuid;
    UPDATE public.transaction_adjustments SET approval_id=COALESCE(approval_id,gen_random_uuid()), idempotency_key=COALESCE(idempotency_key,id::text), request_hash=COALESCE(request_hash,encode(digest(id::text,'sha256'),'hex')) WHERE approval_id IS NULL OR idempotency_key IS NULL OR request_hash IS NULL;
    ALTER TABLE public.transaction_adjustments
      ALTER COLUMN approval_id SET NOT NULL,
      ALTER COLUMN idempotency_key SET NOT NULL,
      ALTER COLUMN request_hash SET NOT NULL;
    ALTER TABLE public.transaction_adjustments
      ADD CONSTRAINT uq_adjustment_idempotency UNIQUE (tenant_id,idempotency_key),
      ADD CONSTRAINT uq_adjustment_posted_transaction UNIQUE (posted_transaction_id),
      ADD CONSTRAINT fk_adjustment_posted_transaction FOREIGN KEY (posted_transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE RESTRICT;

    ALTER TABLE public.transaction_reversals FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.transaction_adjustments FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.transaction_links FORCE ROW LEVEL SECURITY;
    CREATE INDEX IF NOT EXISTS idx_transaction_reversals_original ON public.transaction_reversals(tenant_id,original_transaction_id);
    CREATE INDEX idx_transaction_adjustments_approval ON public.transaction_adjustments(tenant_id,approval_id);
    CREATE OR REPLACE FUNCTION public.validate_transaction_reversal_scope() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE original_tenant uuid; reversal_tenant uuid; original_currency char(3); reversal_currency char(3); original_amount bigint; reversal_amount bigint;
    BEGIN
      SELECT tenant_id,currency_code,amount INTO original_tenant,original_currency,original_amount FROM public.ledger_transactions WHERE id=NEW.original_transaction_id AND status='COMPLETED';
      IF NOT FOUND THEN RAISE EXCEPTION 'Reversal must be a full same-tenant same-currency compensating posting'; END IF;
      SELECT tenant_id,currency_code,amount INTO reversal_tenant,reversal_currency,reversal_amount FROM public.ledger_transactions WHERE id=NEW.reversal_transaction_id AND status='COMPLETED';
      IF NOT FOUND THEN RAISE EXCEPTION 'Reversal must be a full same-tenant same-currency compensating posting'; END IF;
      IF original_tenant<>NEW.tenant_id OR reversal_tenant<>NEW.tenant_id OR original_currency<>reversal_currency OR original_amount<>reversal_amount THEN RAISE EXCEPTION 'Reversal must be a full same-tenant same-currency compensating posting'; END IF;
      RETURN NEW;
    END $$;
    CREATE OR REPLACE FUNCTION public.prevent_financial_link_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF TG_OP='DELETE' OR OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Financial linkage is immutable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER trg_validate_transaction_reversal_scope BEFORE INSERT ON public.transaction_reversals FOR EACH ROW EXECUTE FUNCTION public.validate_transaction_reversal_scope();
    CREATE TRIGGER trg_prevent_transaction_reversal_change BEFORE UPDATE OR DELETE ON public.transaction_reversals FOR EACH ROW EXECUTE FUNCTION public.prevent_financial_link_change();
    CREATE TRIGGER trg_prevent_posted_adjustment_change BEFORE UPDATE OR DELETE ON public.transaction_adjustments FOR EACH ROW WHEN (OLD.status='POSTED') EXECUTE FUNCTION public.prevent_financial_link_change();
    GRANT SELECT,INSERT,UPDATE ON public.transaction_reversals,public.transaction_adjustments,public.transaction_links TO parc_ledger_runtime,parc_ledger_worker;
  `);
}
export function down(): Promise<never> {
  return Promise.reject(
    new Error("Reversal and adjustment integrity is forward-only"),
  );
}
