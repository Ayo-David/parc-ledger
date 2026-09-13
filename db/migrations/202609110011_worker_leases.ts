import type { Knex } from "knex";
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn("ledger_outbox_events", "lease_expires_at"))
    return;
  await knex.raw(`
    ALTER TABLE public.ledger_outbox_events ADD COLUMN processing_started_at timestamptz, ADD COLUMN lease_expires_at timestamptz, ADD COLUMN published_exchange varchar(150), ADD COLUMN published_routing_key varchar(255), ADD COLUMN last_attempt_at timestamptz;
    ALTER TABLE public.ledger_inbox_events ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN lease_expires_at timestamptz, ADD COLUMN processed_by varchar(100), ADD COLUMN payload_hash char(64);
    UPDATE public.ledger_inbox_events SET payload_hash=encode(digest(payload::text,'sha256'),'hex') WHERE payload_hash IS NULL;
    ALTER TABLE public.ledger_inbox_events ALTER COLUMN payload_hash SET NOT NULL;
    CREATE INDEX idx_ledger_outbox_lease ON public.ledger_outbox_events(lease_expires_at) WHERE status='PENDING';
    CREATE INDEX idx_ledger_inbox_due ON public.ledger_inbox_events(available_at,lease_expires_at) WHERE status IN ('RECEIVED','FAILED','PROCESSING');
    ALTER TABLE public.ledger_inbox_events FORCE ROW LEVEL SECURITY;
    CREATE OR REPLACE FUNCTION public.validate_ledger_worker_transition() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status='PROCESSED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Processed inbox events are immutable'; END IF;
      IF OLD.status='PUBLISHED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Published outbox events are immutable'; END IF;
      IF NEW.retry_count<OLD.retry_count THEN RAISE EXCEPTION 'Worker retry count cannot decrease'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER trg_validate_ledger_outbox_transition BEFORE UPDATE ON public.ledger_outbox_events FOR EACH ROW EXECUTE FUNCTION public.validate_ledger_worker_transition();
    CREATE TRIGGER trg_validate_ledger_inbox_transition BEFORE UPDATE ON public.ledger_inbox_events FOR EACH ROW EXECUTE FUNCTION public.validate_ledger_worker_transition();
    GRANT SELECT,INSERT,UPDATE ON public.ledger_inbox_events,public.ledger_outbox_events TO parc_ledger_worker;
  `);
}
export function down(): Promise<never> {
  return Promise.reject(new Error("Worker leases are forward-only"));
}
