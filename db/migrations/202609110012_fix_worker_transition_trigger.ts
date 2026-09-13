import type { Knex } from "knex";
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION public.validate_ledger_outbox_transition() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.status='PUBLISHED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Published outbox events are immutable'; END IF; IF NEW.retry_count<OLD.retry_count THEN RAISE EXCEPTION 'Worker retry count cannot decrease'; END IF; RETURN NEW; END $$;
    CREATE OR REPLACE FUNCTION public.validate_ledger_inbox_transition() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.status='PROCESSED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Processed inbox events are immutable'; END IF; IF NEW.retry_count<OLD.retry_count THEN RAISE EXCEPTION 'Worker retry count cannot decrease'; END IF; RETURN NEW; END $$;
    DROP TRIGGER IF EXISTS trg_validate_ledger_outbox_transition ON public.ledger_outbox_events;
    DROP TRIGGER IF EXISTS trg_validate_ledger_inbox_transition ON public.ledger_inbox_events;
    CREATE TRIGGER trg_validate_ledger_outbox_transition BEFORE UPDATE ON public.ledger_outbox_events FOR EACH ROW EXECUTE FUNCTION public.validate_ledger_outbox_transition();
    CREATE TRIGGER trg_validate_ledger_inbox_transition BEFORE UPDATE ON public.ledger_inbox_events FOR EACH ROW EXECUTE FUNCTION public.validate_ledger_inbox_transition();
  `);
}
export function down(): Promise<never> {
  return Promise.reject(new Error("Worker trigger correction is forward-only"));
}
