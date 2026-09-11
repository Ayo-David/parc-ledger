import type { Knex } from "knex";
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn("ledger_integrity_checks", "run_reference"))
    return;
  await knex.raw(`
    ALTER TABLE public.ledger_integrity_checks ADD COLUMN run_reference varchar(100), ADD COLUMN request_hash char(64), ADD COLUMN worker_id varchar(100), ADD COLUMN started_at timestamptz;
    UPDATE public.ledger_integrity_checks SET run_reference=id::text, request_hash=encode(digest(id::text,'sha256'),'hex') WHERE run_reference IS NULL;
    ALTER TABLE public.ledger_integrity_checks ALTER COLUMN run_reference SET NOT NULL, ALTER COLUMN request_hash SET NOT NULL;
    ALTER TABLE public.ledger_integrity_checks ADD CONSTRAINT uq_integrity_check_run UNIQUE (tenant_id,check_type,run_reference);
    ALTER TABLE public.reconciliation_runs ADD COLUMN source_payload_hash char(64), ADD COLUMN idempotency_key varchar(255), ADD COLUMN source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
    UPDATE public.reconciliation_runs SET source_payload_hash=encode(digest(id::text,'sha256'),'hex'), idempotency_key=id::text WHERE source_payload_hash IS NULL;
    ALTER TABLE public.reconciliation_runs ALTER COLUMN source_payload_hash SET NOT NULL, ALTER COLUMN idempotency_key SET NOT NULL;
    ALTER TABLE public.reconciliation_runs ADD CONSTRAINT uq_reconciliation_idempotency UNIQUE (tenant_id,source_system,idempotency_key);
    ALTER TABLE public.reconciliation_items ADD COLUMN source_payload_hash char(64), ADD COLUMN idempotency_key varchar(255);
    UPDATE public.reconciliation_items SET source_payload_hash=encode(digest(id::text,'sha256'),'hex'), idempotency_key=id::text WHERE source_payload_hash IS NULL;
    ALTER TABLE public.reconciliation_items ALTER COLUMN source_payload_hash SET NOT NULL, ALTER COLUMN idempotency_key SET NOT NULL;
    ALTER TABLE public.reconciliation_exceptions ADD CONSTRAINT uq_reconciliation_exception_code UNIQUE (reconciliation_item_id,exception_code);
    ALTER TABLE public.ledger_integrity_checks FORCE ROW LEVEL SECURITY; ALTER TABLE public.reconciliation_runs FORCE ROW LEVEL SECURITY; ALTER TABLE public.reconciliation_items FORCE ROW LEVEL SECURITY; ALTER TABLE public.reconciliation_exceptions FORCE ROW LEVEL SECURITY;
    CREATE INDEX idx_integrity_run_reference ON public.ledger_integrity_checks(tenant_id,check_type,run_reference);
    CREATE INDEX idx_reconciliation_item_idempotency ON public.reconciliation_items(reconciliation_run_id,idempotency_key);
    GRANT SELECT,INSERT,UPDATE ON public.ledger_integrity_checks,public.reconciliation_runs,public.reconciliation_items,public.reconciliation_exceptions TO parc_ledger_worker;
  `);
}
export function down(): Promise<never> {
  return Promise.reject(
    new Error("Integrity and reconciliation controls are forward-only"),
  );
}
