import { randomUUID } from "node:crypto";
import { loadConfig } from "./config/env.js";
import { createDatabase } from "./database/client.js";
import { IntegrityWorker } from "./services/integrity-worker.js";

const config = loadConfig();
const tenantIds = config.LEDGER_INTEGRITY_TENANT_IDS.split(",")
  .map((id) => id.trim())
  .filter(Boolean);
if (tenantIds.length === 0)
  throw new Error(
    "LEDGER_INTEGRITY_TENANT_IDS must contain at least one tenant UUID",
  );

const database = createDatabase(config);
const worker = new IntegrityWorker(
  database,
  `${config.SERVICE_NAME}-${process.pid}`,
);
let running = false;

async function runChecks(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const tenantId of tenantIds)
      await worker.runBalanceDrift(
        tenantId,
        `scheduled-${new Date().toISOString()}-${randomUUID()}`,
      );
  } finally {
    running = false;
  }
}

await runChecks();
const timer = setInterval(() => {
  void runChecks();
}, config.LEDGER_INTEGRITY_INTERVAL_MS);

process.on("SIGTERM", () => {
  clearInterval(timer);
  void database.destroy();
});
