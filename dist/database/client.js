import knex from "knex";
export function createDatabase(config) {
    return knex({
        client: "pg",
        connection: config.DATABASE_URL,
        pool: { min: 0, max: 10 },
    });
}
export async function withTenantTransaction(database, tenantId, work) {
    return database.transaction(async (tx) => {
        await tx.raw("SELECT set_config('app.current_tenant_id', ?, true)", [
            tenantId,
        ]);
        return work(tx);
    });
}
