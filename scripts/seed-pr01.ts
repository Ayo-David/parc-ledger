import knex from "knex";
import { z } from "zod";
import { AccountProvisioningService } from "../src/services/account-provisioning-service.js";
import { PostingService } from "../src/services/posting-service.js";

const config = z
  .object({
    NODE_ENV: z.enum(["development", "test"]),
    DATABASE_URL: z.string().url(),
    PR01_TENANT_A_ID: z.string().uuid(),
    PR01_TENANT_B_ID: z.string().uuid(),
    PR01_CUSTOMER_A_ID: z.string().uuid(),
    PR01_CUSTOMER_B_ID: z.string().uuid(),
  })
  .parse(process.env);

const database = knex({ client: "pg", connection: config.DATABASE_URL });
const fixtures = [
  {
    tenantId: config.PR01_TENANT_A_ID,
    customerId: config.PR01_CUSTOMER_A_ID,
    entityId: "11111111-1111-4111-8111-111111111121",
    bookId: "11111111-1111-4111-8111-111111111122",
    code: "PR01_TENANT_A",
  },
  {
    tenantId: config.PR01_TENANT_B_ID,
    customerId: config.PR01_CUSTOMER_B_ID,
    entityId: "22222222-2222-4222-8222-222222222221",
    bookId: "22222222-2222-4222-8222-222222222222",
    code: "PR01_TENANT_B",
  },
] as const;

try {
  await database.transaction(async (transaction) => {
    for (const fixture of fixtures) {
      await transaction("ledger_entities")
        .insert({
          id: fixture.entityId,
          tenant_id: fixture.tenantId,
          entity_code: fixture.code,
          entity_name: `${fixture.code} fixture entity`,
          entity_type: "TENANT",
          country_code: "NG",
          base_currency: "NGN",
          status: "ACTIVE",
          metadata: JSON.stringify({ fixture: "PR-01", disposable: true }),
        })
        .onConflict("id")
        .merge({
          entity_name: `${fixture.code} fixture entity`,
          status: "ACTIVE",
          updated_at: transaction.fn.now(),
        });

      await transaction("ledger_books")
        .insert({
          id: fixture.bookId,
          tenant_id: fixture.tenantId,
          entity_id: fixture.entityId,
          book_code: `${fixture.code}_NGN`,
          book_name: `${fixture.code} primary NGN book`,
          base_currency: "NGN",
          status: "ACTIVE",
          is_primary: true,
          metadata: JSON.stringify({ fixture: "PR-01", disposable: true }),
        })
        .onConflict("id")
        .merge({
          status: "ACTIVE",
          is_primary: true,
          updated_at: transaction.fn.now(),
        });
    }
  });

  const accounts = new AccountProvisioningService(database);
  const postings = new PostingService(database);
  const output = [];
  for (const fixture of fixtures) {
    const settlement = await accounts.provision({
      tenantId: fixture.tenantId,
      ownerType: "TENANT",
      ownerId: fixture.tenantId,
      purpose: "PR01_SETTLEMENT_CASH",
      accountType: "ASSET",
      currency: "NGN",
      idempotencyKey: "pr01-settlement-cash-v1",
      sourceService: "parc-pr01-fixture",
      correlationId: fixture.entityId,
    });
    const wallet = await accounts.provision({
      tenantId: fixture.tenantId,
      ownerType: "CUSTOMER",
      ownerId: fixture.customerId,
      purpose: "WALLET",
      accountType: "LIABILITY",
      currency: "NGN",
      idempotencyKey: "pr01-customer-wallet-v1",
      sourceService: "parc-pr01-fixture",
      correlationId: fixture.entityId,
    });
    const posting = await postings.post({
      tenantId: fixture.tenantId,
      reference: `${fixture.code}-OPENING-FUNDS`,
      currency: "NGN",
      entries: [
        {
          accountId: settlement.account_id,
          direction: "DEBIT",
          amountMinor: "10000000",
        },
        {
          accountId: wallet.account_id,
          direction: "CREDIT",
          amountMinor: "10000000",
        },
      ],
      idempotencyKey: "pr01-opening-funds-v1",
      sourceService: "parc-pr01-fixture",
      correlationId: fixture.entityId,
    });
    output.push({
      tenantId: fixture.tenantId,
      customerId: fixture.customerId,
      settlementAccountId: settlement.account_id,
      walletAccountId: wallet.account_id,
      openingTransactionId: posting.transaction_id,
      currency: "NGN",
      openingAmountMinor: "10000000",
    });
  }

  console.log(JSON.stringify({ fixture: "PR-01", ledger: output }));
} finally {
  await database.destroy();
}
