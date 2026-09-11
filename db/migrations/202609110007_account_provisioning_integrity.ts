import type { Knex } from "knex";
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable("ledger_command_idempotency")) return;
  await knex.raw(`
    ALTER TABLE public.customer_ledger_accounts ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE public.ledger_tenant_accounts ADD COLUMN currency_code char(3) NOT NULL DEFAULT 'NGN' CHECK (currency_code ~ '^[A-Z]{3}$');
    ALTER TABLE public.ledger_tenant_accounts DROP CONSTRAINT uq_tenant_account_purpose;
    ALTER TABLE public.ledger_tenant_accounts ADD CONSTRAINT uq_tenant_account_purpose_currency UNIQUE (tenant_id,purpose,currency_code);
    CREATE TABLE public.ledger_command_idempotency (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, command_type varchar(100) NOT NULL,
      idempotency_key varchar(255) NOT NULL, request_hash char(64) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING','COMPLETED','FAILED')),
      resource_type varchar(100), resource_id uuid, response_body jsonb, expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_ledger_command_idempotency UNIQUE (tenant_id,command_type,idempotency_key)
    );
    CREATE INDEX idx_ledger_command_idempotency_expiry ON public.ledger_command_idempotency(expires_at);
    ALTER TABLE public.ledger_command_idempotency ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.ledger_command_idempotency FORCE ROW LEVEL SECURITY;
    CREATE POLICY ledger_command_idempotency_policy ON public.ledger_command_idempotency USING (tenant_id=public.current_tenant_id()) WITH CHECK (tenant_id=public.current_tenant_id());
    CREATE OR REPLACE FUNCTION public.validate_customer_ledger_account_scope() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE account_tenant uuid; account_currency char(3);
    BEGIN SELECT tenant_id,currency_code INTO account_tenant,account_currency FROM ledger_accounts WHERE id=NEW.ledger_account_id;
      IF NOT FOUND OR account_tenant<>NEW.tenant_id OR account_currency<>NEW.currency_code THEN RAISE EXCEPTION 'Customer ledger account must match tenant and currency'; END IF;
      RETURN NEW;
    END $$;
    CREATE OR REPLACE FUNCTION public.validate_tenant_ledger_account_scope() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE account_tenant uuid; account_book uuid; account_currency char(3);
    BEGIN SELECT tenant_id,book_id,currency_code INTO account_tenant,account_book,account_currency FROM ledger_accounts WHERE id=NEW.account_id;
      IF NOT FOUND OR account_tenant<>NEW.tenant_id OR account_book<>NEW.book_id OR account_currency<>NEW.currency_code THEN RAISE EXCEPTION 'Tenant ledger account must match tenant, book and currency'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER trg_validate_customer_ledger_account_scope BEFORE INSERT OR UPDATE ON public.customer_ledger_accounts FOR EACH ROW EXECUTE FUNCTION public.validate_customer_ledger_account_scope();
    CREATE TRIGGER trg_validate_tenant_ledger_account_scope BEFORE INSERT OR UPDATE ON public.ledger_tenant_accounts FOR EACH ROW EXECUTE FUNCTION public.validate_tenant_ledger_account_scope();
    GRANT SELECT,INSERT,UPDATE ON public.customer_ledger_accounts,public.ledger_tenant_accounts,public.ledger_command_idempotency TO parc_ledger_runtime,parc_ledger_worker;
  `);
}
export function down(): Promise<never> {
  return Promise.reject(
    new Error("Account provisioning integrity is forward-only"),
  );
}
