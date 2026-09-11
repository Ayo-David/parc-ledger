import type { Knex } from "knex";

/** Enforce existing tenant policies even for the owning database role. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE public.customer_ledger_accounts FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.ledger_tenant_accounts FORCE ROW LEVEL SECURITY;
  `);
}

export function down(): Promise<never> {
  return Promise.reject(
    new Error("Account mapping RLS enforcement is forward-only"),
  );
}
