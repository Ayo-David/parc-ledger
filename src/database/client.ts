import knex, { type Knex } from "knex";
import type { AppConfig } from "../config/env.js";
export function createDatabase(config: AppConfig): Knex {
  return knex({
    client: "pg",
    connection: config.DATABASE_URL,
    pool: { min: 0, max: 10 },
  });
}
export async function withTenantTransaction<T>(
  database: Knex,
  tenantId: string,
  work: (tx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.raw("SELECT set_config('app.current_tenant_id', ?, true)", [
      tenantId,
    ]);
    return work(tx);
  });
}
