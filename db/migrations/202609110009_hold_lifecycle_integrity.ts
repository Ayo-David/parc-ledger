import type { Knex } from "knex";

export const config = { transaction: false };

/**
 * Approved LEDGER-DB-12 through LEDGER-DB-15. This is deliberately
 * forward-only: a captured hold is an immutable link to a posted journal.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable("ledger_hold_actions")) return;
  // PostgreSQL requires the enum value to commit before a constraint may use it.
  await knex.raw(
    "ALTER TYPE public.hold_status ADD VALUE IF NOT EXISTS 'CAPTURED'",
  );
  await knex.raw(`
    ALTER TABLE public.account_holds
      ADD COLUMN IF NOT EXISTS captured_at timestamptz,
      ADD COLUMN IF NOT EXISTS captured_by uuid,
      ADD COLUMN IF NOT EXISTS capture_transaction_id uuid;
    ALTER TABLE public.account_holds
      ADD CONSTRAINT fk_account_hold_capture_transaction
      FOREIGN KEY (capture_transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE RESTRICT;
    ALTER TABLE public.account_holds
      ADD CONSTRAINT account_hold_capture_state_chk CHECK (
        (status='CAPTURED' AND captured_at IS NOT NULL AND capture_transaction_id IS NOT NULL)
        OR (status<>'CAPTURED' AND captured_at IS NULL AND capture_transaction_id IS NULL)
      );

    CREATE TABLE public.ledger_hold_actions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      hold_id uuid NOT NULL REFERENCES public.account_holds(id) ON DELETE RESTRICT,
      action_type varchar(20) NOT NULL CHECK (action_type IN ('RELEASE','CAPTURE')),
      idempotency_key varchar(255) NOT NULL,
      request_hash char(64) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING','COMPLETED','FAILED')),
      transaction_id uuid REFERENCES public.ledger_transactions(id) ON DELETE RESTRICT,
      response_body jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_ledger_hold_action_idempotency UNIQUE (tenant_id, action_type, idempotency_key)
    );
    CREATE INDEX idx_account_holds_expiry_active ON public.account_holds(expires_at) WHERE status='ACTIVE' AND expires_at IS NOT NULL;
    CREATE INDEX idx_ledger_hold_actions_hold ON public.ledger_hold_actions(tenant_id, hold_id);

    ALTER TABLE public.account_holds FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.account_hold_releases FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.ledger_hold_actions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.ledger_hold_actions FORCE ROW LEVEL SECURITY;
    CREATE POLICY ledger_hold_actions_tenant_policy ON public.ledger_hold_actions
      USING (tenant_id=public.current_tenant_id()) WITH CHECK (tenant_id=public.current_tenant_id());

    CREATE OR REPLACE FUNCTION public.validate_account_hold_scope() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE account_tenant uuid; account_currency char(3);
    BEGIN
      SELECT tenant_id,currency_code INTO account_tenant,account_currency FROM public.ledger_accounts WHERE id=NEW.account_id;
      IF NOT FOUND OR account_tenant<>NEW.tenant_id OR account_currency<>NEW.currency_code THEN
        RAISE EXCEPTION 'Account hold must match active account tenant and currency';
      END IF;
      RETURN NEW;
    END $$;
    CREATE OR REPLACE FUNCTION public.prevent_account_hold_lifecycle_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status<>'ACTIVE' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Terminal account holds are immutable';
      END IF;
      IF OLD.status='ACTIVE' AND NEW.status NOT IN ('ACTIVE','RELEASED','EXPIRED','CANCELLED','CAPTURED') THEN
        RAISE EXCEPTION 'Invalid account hold state transition';
      END IF;
      IF NEW.status='CAPTURED' AND NEW.capture_transaction_id IS NULL THEN
        RAISE EXCEPTION 'Captured hold requires a posted transaction';
      END IF;
      RETURN NEW;
    END $$;
    CREATE OR REPLACE FUNCTION public.refresh_balance_for_account_hold() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM public.refresh_ledger_account_balance(COALESCE(NEW.account_id,OLD.account_id), COALESCE(NEW.currency_code,OLD.currency_code));
      RETURN COALESCE(NEW,OLD);
    END $$;
    CREATE TRIGGER trg_validate_account_hold_scope BEFORE INSERT OR UPDATE ON public.account_holds FOR EACH ROW EXECUTE FUNCTION public.validate_account_hold_scope();
    CREATE TRIGGER trg_prevent_account_hold_lifecycle_change BEFORE UPDATE OR DELETE ON public.account_holds FOR EACH ROW EXECUTE FUNCTION public.prevent_account_hold_lifecycle_change();
    CREATE TRIGGER trg_refresh_balance_for_account_hold AFTER INSERT OR UPDATE OF status,amount,expires_at ON public.account_holds FOR EACH ROW EXECUTE FUNCTION public.refresh_balance_for_account_hold();

    GRANT SELECT,INSERT,UPDATE ON public.account_holds,public.account_hold_releases,public.ledger_hold_actions TO parc_ledger_runtime,parc_ledger_worker;
  `);
}

export function down(): Promise<never> {
  return Promise.reject(new Error("Hold lifecycle integrity is forward-only"));
}
