import { randomUUID } from "node:crypto";
import { loadConfig } from "./config/env.js";
import { createDatabase } from "./database/client.js";
import { IntegrityWorker } from "./services/integrity-worker.js";
const config = loadConfig();
const tenantIds = config.LEDGER_INTEGRITY_TENANT_IDS.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
if (tenantIds.length === 0)
    throw new Error("LEDGER_INTEGRITY_TENANT_IDS must contain at least one tenant UUID");
const database = createDatabase(config);
const worker = new IntegrityWorker(database, `${config.SERVICE_NAME}-${process.pid}`);
let running = false;
async function runChecks() {
    if (running)
        return;
    running = true;
    try {
        for (const tenantId of tenantIds) {
            try {
                await worker.runBalanceDrift(tenantId, `scheduled-${new Date().toISOString()}-${randomUUID()}`);
            }
            catch (error) {
                console.error(`Integrity check failed for tenant ${tenantId}`, error);
            }
        }
    }
    finally {
        running = false;
    }
}
await runChecks();
const timer = setInterval(() => {
    void runChecks().catch((error) => console.error("Integrity cycle failed", error));
}, config.LEDGER_INTEGRITY_INTERVAL_MS);
process.on("SIGTERM", () => {
    clearInterval(timer);
    void database.destroy();
});
