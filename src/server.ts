import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { createDatabase } from "./database/client.js";
import { PostingService } from "./services/posting-service.js";
import { AccountProvisioningService } from "./services/account-provisioning-service.js";
import { HoldService } from "./services/hold-service.js";
import { ReversalService } from "./services/reversal-service.js";
import { AdjustmentService } from "./services/adjustment-service.js";
import { TenantAdminApprovalGateway } from "./services/tenant-admin-approval-gateway.js";
import { BalanceQueryService } from "./services/balance-query-service.js";
import { CustomerStatementService } from "./services/customer-statement-service.js";
const config = loadConfig();
const database = createDatabase(config);
const approvalGateway = new TenantAdminApprovalGateway(
  config.TENANT_ADMIN_URL,
  config.TENANT_ADMIN_SERVICE_TOKEN ?? config.INTERNAL_SERVICE_TOKEN,
);
const server = createServer(
  createApp({
    config,
    postings: new PostingService(database),
    accounts: new AccountProvisioningService(database),
    holds: new HoldService(database, new PostingService(database)),
    reversals: new ReversalService(
      database,
      new PostingService(database),
      approvalGateway,
    ),
    adjustments: new AdjustmentService(
      database,
      new PostingService(database),
      approvalGateway,
    ),
    balances: new BalanceQueryService(database),
    statements: new CustomerStatementService(database),
  }),
);
server.listen(config.PORT, config.HOST);
process.on("SIGTERM", () => {
  server.close(() => {
    void database.destroy();
  });
});
