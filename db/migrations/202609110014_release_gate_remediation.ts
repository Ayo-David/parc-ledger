import type { Knex } from "knex";

export const config = { transaction: false };

/** Approved LEDGER-DB-25 through LEDGER-DB-27. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    "ALTER TYPE public.ledger_outbox_status ADD VALUE IF NOT EXISTS 'DEAD_LETTERED'",
  );
  if (!(await knex.schema.hasColumn("ledger_outbox_events", "claimed_by"))) {
    await knex.schema.alterTable("ledger_outbox_events", (table) => {
      table.string("claimed_by", 100);
    });
  }
  await knex.raw(`
    ALTER TABLE public.reconciliation_items
      DROP CONSTRAINT IF EXISTS uq_reconciliation_item_idempotency;
    ALTER TABLE public.reconciliation_items
      ADD CONSTRAINT uq_reconciliation_item_idempotency
      UNIQUE (reconciliation_run_id, idempotency_key);

    CREATE OR REPLACE FUNCTION public.validate_transaction_reversal_scope() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE original_row public.ledger_transactions%ROWTYPE; reversal_row public.ledger_transactions%ROWTYPE;
    BEGIN
      SELECT * INTO original_row FROM public.ledger_transactions WHERE id=NEW.original_transaction_id AND status='COMPLETED';
      IF NOT FOUND THEN RAISE EXCEPTION 'Original transaction must exist and be completed'; END IF;
      SELECT * INTO reversal_row FROM public.ledger_transactions WHERE id=NEW.reversal_transaction_id AND status='COMPLETED';
      IF NOT FOUND THEN RAISE EXCEPTION 'Reversal transaction must exist and be completed'; END IF;
      IF original_row.tenant_id<>NEW.tenant_id OR reversal_row.tenant_id<>NEW.tenant_id OR original_row.book_id<>reversal_row.book_id OR original_row.currency_code<>reversal_row.currency_code OR original_row.amount<>reversal_row.amount THEN
        RAISE EXCEPTION 'Reversal must be a full same-tenant same-book same-currency compensating posting';
      END IF;
      RETURN NEW;
    END $$;

    CREATE OR REPLACE FUNCTION public.claim_next_ledger_outbox(p_worker_id text, p_lease_seconds integer DEFAULT 30)
    RETURNS SETOF public.ledger_outbox_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
    BEGIN
      IF nullif(btrim(p_worker_id), '') IS NULL THEN
        RAISE EXCEPTION 'Worker id is required';
      END IF;
      RETURN QUERY
        UPDATE public.ledger_outbox_events o
        SET processing_started_at=now(),
            lease_expires_at=now()+make_interval(secs=>greatest(5, least(p_lease_seconds, 300))),
            last_attempt_at=now(),
            claimed_by=p_worker_id
        WHERE o.id=(
          SELECT id FROM public.ledger_outbox_events
          WHERE status='PENDING' AND available_at<=now()
            AND (lease_expires_at IS NULL OR lease_expires_at<now())
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        )
        RETURNING o.*;
    END
    $$;
    CREATE OR REPLACE FUNCTION public.complete_ledger_outbox(p_id uuid,p_worker_id text,p_exchange text,p_routing_key text)
    RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
    BEGIN UPDATE public.ledger_outbox_events SET status='PUBLISHED',published_at=now(),published_exchange=p_exchange,published_routing_key=p_routing_key,lease_expires_at=NULL WHERE id=p_id AND status='PENDING' AND claimed_by=p_worker_id; RETURN FOUND; END $$;
    CREATE OR REPLACE FUNCTION public.fail_ledger_outbox(p_id uuid,p_worker_id text,p_error text,p_max_retries integer DEFAULT 8)
    RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
    DECLARE next_retry integer; next_status public.ledger_outbox_status;
    BEGIN SELECT retry_count+1 INTO next_retry FROM public.ledger_outbox_events WHERE id=p_id AND status='PENDING' AND claimed_by=p_worker_id FOR UPDATE; IF NOT FOUND THEN RETURN 'NOT_CLAIMED'; END IF;
      next_status:=CASE WHEN next_retry>=p_max_retries THEN 'DEAD_LETTERED'::public.ledger_outbox_status ELSE 'PENDING'::public.ledger_outbox_status END;
      UPDATE public.ledger_outbox_events SET retry_count=next_retry,status=next_status,available_at=now()+(LEAST(300000,1000*power(2,next_retry))*(0.75+random()*0.5))*interval '1 millisecond',lease_expires_at=NULL,claimed_by=NULL,last_error=left(p_error,1000) WHERE id=p_id;
      RETURN next_status::text;
    END $$;
    REVOKE ALL ON FUNCTION public.claim_next_ledger_outbox(text,integer),public.complete_ledger_outbox(uuid,text,text,text),public.fail_ledger_outbox(uuid,text,text,integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.claim_next_ledger_outbox(text,integer),public.complete_ledger_outbox(uuid,text,text,text),public.fail_ledger_outbox(uuid,text,text,integer) TO parc_ledger_worker;

    CREATE OR REPLACE FUNCTION public.prevent_completed_integrity_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status IN ('PASSED','FAILED') AND (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) THEN
        RAISE EXCEPTION 'Completed integrity evidence is immutable';
      END IF;
      RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
    END $$;
    DROP TRIGGER IF EXISTS trg_prevent_completed_integrity_change ON public.ledger_integrity_checks;
    CREATE TRIGGER trg_prevent_completed_integrity_change BEFORE UPDATE OR DELETE ON public.ledger_integrity_checks FOR EACH ROW EXECUTE FUNCTION public.prevent_completed_integrity_evidence_change();
  `);
}

export function down(): Promise<never> {
  return Promise.reject(new Error("Release-gate remediation is forward-only"));
}
