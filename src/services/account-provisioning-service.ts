import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { withTenantTransaction } from "../database/client.js";
import { PostingError } from "./posting-service.js";

type OwnerType = "CUSTOMER" | "TENANT";
type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
export interface AccountProvisionCommand {
  tenantId: string;
  ownerType: OwnerType;
  ownerId: string;
  purpose: string;
  accountType: AccountType;
  currency: string;
  idempotencyKey: string;
  sourceService: string;
  correlationId: string;
}
export class AccountProvisioningService {
  public constructor(private readonly database: Knex) {}
  public async provision(input: AccountProvisionCommand): Promise<{
    account_id: string;
    owner_id: string;
    currency: string;
    replayed: boolean;
  }> {
    validate(input);
    const requestHash = hash(input);
    return withTenantTransaction(this.database, input.tenantId, async (tx) => {
      await tx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", [
        `account-provision:${input.tenantId}:${input.idempotencyKey}`,
      ]);
      const existing = await tx("ledger_command_idempotency")
        .where({
          tenant_id: input.tenantId,
          command_type: "ACCOUNT_PROVISION",
          idempotency_key: input.idempotencyKey,
        })
        .first<{
          request_hash: string;
          status: string;
          response_body: {
            account_id: string;
            owner_id: string;
            currency: string;
          } | null;
        }>();
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new PostingError(
            "IDEMPOTENCY_MISMATCH",
            "Idempotency key was previously used for a different account request",
          );
        if (existing.status !== "COMPLETED" || !existing.response_body)
          throw new PostingError(
            "REQUEST_IN_PROGRESS",
            "Account provisioning is in progress",
          );
        return { ...existing.response_body, replayed: true };
      }
      const [claim] = await tx("ledger_command_idempotency")
        .insert({
          tenant_id: input.tenantId,
          command_type: "ACCOUNT_PROVISION",
          idempotency_key: input.idempotencyKey,
          request_hash: requestHash,
          expires_at: new Date(Date.now() + 86_400_000),
        })
        .returning<{ id: string }[]>("id");
      if (!claim) throw new Error("Account idempotency claim was not created");
      await tx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", [
        `account-owner:${input.tenantId}:${input.ownerType}:${input.ownerId}:${input.purpose}:${input.currency}`,
      ]);
      const mapped =
        input.ownerType === "CUSTOMER"
          ? await tx("customer_ledger_accounts")
              .where({
                tenant_id: input.tenantId,
                customer_id: input.ownerId,
                account_purpose: input.purpose,
                currency_code: input.currency,
              })
              .first<{ ledger_account_id: string }>("ledger_account_id")
          : await tx("ledger_tenant_accounts")
              .where({
                tenant_id: input.tenantId,
                purpose: input.purpose,
                currency_code: input.currency,
              })
              .first<{ account_id: string }>("account_id");
      const mappedAccountId =
        mapped === undefined
          ? undefined
          : "ledger_account_id" in mapped
            ? mapped.ledger_account_id
            : mapped.account_id;
      if (mappedAccountId !== undefined) {
        const result = {
          account_id: mappedAccountId,
          owner_id: input.ownerId,
          currency: input.currency,
        };
        await tx("ledger_command_idempotency").where({ id: claim.id }).update({
          status: "COMPLETED",
          resource_type: "ledger_account",
          resource_id: mappedAccountId,
          response_body: result,
          updated_at: tx.fn.now(),
        });
        return { ...result, replayed: true };
      }
      const book = await tx("ledger_books")
        .where({
          tenant_id: input.tenantId,
          status: "ACTIVE",
          is_primary: true,
        })
        .whereNull("deleted_at")
        .first<{ id: string }>();
      if (!book)
        throw new PostingError(
          "PRIMARY_BOOK_NOT_FOUND",
          "Tenant has no active primary ledger book",
        );
      const accountId = randomUUID();
      const accountCode = `${input.ownerType.slice(0, 3)}-${input.ownerId.slice(0, 8)}-${createHash("sha256").update(input.purpose).digest("hex").slice(0, 8)}-${input.currency}`;
      await tx("ledger_accounts").insert({
        id: accountId,
        tenant_id: input.tenantId,
        book_id: book.id,
        account_code: accountCode,
        account_name: `${input.purpose} ${input.currency}`,
        account_type: input.accountType,
        currency_code: input.currency,
        normal_balance: normal(input.accountType),
        is_customer_account: input.ownerType === "CUSTOMER",
        external_reference: input.ownerId,
        metadata: { purpose: input.purpose, owner_type: input.ownerType },
      });
      if (input.ownerType === "CUSTOMER")
        await tx("customer_ledger_accounts").insert({
          tenant_id: input.tenantId,
          customer_id: input.ownerId,
          ledger_account_id: accountId,
          account_purpose: input.purpose,
          currency_code: input.currency,
        });
      else
        await tx("ledger_tenant_accounts").insert({
          tenant_id: input.tenantId,
          book_id: book.id,
          account_id: accountId,
          purpose: input.purpose,
          currency_code: input.currency,
        });
      const result = {
        account_id: accountId,
        owner_id: input.ownerId,
        currency: input.currency,
      };
      await tx("ledger_command_idempotency").where({ id: claim.id }).update({
        status: "COMPLETED",
        resource_type: "ledger_account",
        resource_id: accountId,
        response_body: result,
        updated_at: tx.fn.now(),
      });
      await tx("ledger_audit_logs").insert({
        tenant_id: input.tenantId,
        entity_type: "ledger_account",
        entity_id: accountId,
        action: "CREATE",
        service_name: input.sourceService,
        after_data: {
          ...result,
          purpose: input.purpose,
          account_type: input.accountType,
        },
        metadata: { idempotency_key: input.idempotencyKey },
      });
      await tx("ledger_outbox_events").insert({
        tenant_id: input.tenantId,
        aggregate_type: "ledger_account",
        aggregate_id: accountId,
        event_type: "ledger.account-created.v1",
        payload: result,
        idempotency_key: `account:${input.idempotencyKey}`,
        correlation_id: input.correlationId,
      });
      return { ...result, replayed: false };
    });
  }
}
function validate(input: AccountProvisionCommand): void {
  if (!["CUSTOMER", "TENANT"].includes(input.ownerType))
    throw new PostingError("REQUEST_INVALID", "Owner type is invalid");
  if (
    !["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"].includes(
      input.accountType,
    )
  )
    throw new PostingError("REQUEST_INVALID", "Account type is invalid");
  if (!input.ownerId.trim() || !input.idempotencyKey.trim())
    throw new PostingError(
      "REQUEST_INVALID",
      "Owner and idempotency key are required",
    );
  if (input.currency !== "NGN")
    throw new PostingError(
      "CURRENCY_NOT_ENABLED",
      "Only NGN is enabled for account provisioning",
    );
  if (
    !/^[A-Z]{3}$/.test(input.currency) ||
    !input.purpose.trim() ||
    input.purpose.length > 100
  )
    throw new PostingError(
      "REQUEST_INVALID",
      "Currency and purpose are invalid",
    );
}
function normal(type: AccountType): "DEBIT" | "CREDIT" {
  return type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT";
}
function hash(input: AccountProvisionCommand): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        owner_type: input.ownerType,
        owner_id: input.ownerId,
        purpose: input.purpose,
        account_type: input.accountType,
        currency: input.currency,
      }),
    )
    .digest("hex");
}
