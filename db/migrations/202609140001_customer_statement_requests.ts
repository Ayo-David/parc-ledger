import type { Knex } from "knex";

/** Approved EDGE-DB-01: durable, tenant-isolated asynchronous statements. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE public.customer_statement_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      customer_id uuid NOT NULL,
      currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
      date_from date NOT NULL,
      date_to date NOT NULL,
      format varchar(10) NOT NULL DEFAULT 'PDF' CHECK (format = 'PDF'),
      status varchar(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','READY','FAILED','EXPIRED')),
      idempotency_key varchar(255) NOT NULL,
      request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      object_reference varchar(1000),
      download_expires_at timestamptz,
      processing_started_at timestamptz,
      completed_at timestamptz,
      failure_code varchar(100),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_statement_period CHECK (date_to >= date_from),
      CONSTRAINT chk_statement_ready_evidence CHECK (
        (status = 'READY' AND object_reference IS NOT NULL AND download_expires_at IS NOT NULL AND completed_at IS NOT NULL)
        OR status <> 'READY'
      ),
      CONSTRAINT uq_customer_statement_idempotency UNIQUE (tenant_id, idempotency_key)
    );
    CREATE INDEX idx_customer_statements_owner ON public.customer_statement_requests(tenant_id, customer_id, created_at DESC);
    CREATE INDEX idx_customer_statements_work ON public.customer_statement_requests(status, created_at) WHERE status IN ('PENDING','PROCESSING');
    ALTER TABLE public.customer_statement_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.customer_statement_requests FORCE ROW LEVEL SECURITY;
    CREATE POLICY customer_statement_isolation ON public.customer_statement_requests
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id());
    GRANT SELECT,INSERT ON public.customer_statement_requests TO parc_ledger_runtime;
    GRANT SELECT,INSERT,UPDATE ON public.customer_statement_requests TO parc_ledger_worker;
    GRANT SELECT ON public.customer_statement_requests TO parc_ledger_readonly;
  `);
}

export function down(): Promise<never> {
  return Promise.reject(
    new Error("Customer statement storage is forward-only"),
  );
}
