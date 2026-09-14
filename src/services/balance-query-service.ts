import type { Knex } from "knex";
import { withTenantTransaction } from "../database/client.js";
import { PostingError } from "./posting-service.js";

export interface BalanceResult {
  account_id: string;
  currency: string;
  posted_balance_minor: string;
  held_balance_minor: string;
  available_balance_minor: string;
  version: number;
}
interface BalanceRow {
  account_id: string;
  currency: string;
  posted_balance_minor: string;
  held_balance_minor: string;
  available_balance_minor: string;
  version: number | string;
}

export class BalanceQueryService {
  public constructor(private readonly database: Knex) {}

  public async byAccount(input: {
    tenantId: string;
    accountId: string;
  }): Promise<BalanceResult> {
    return withTenantTransaction(this.database, input.tenantId, async (tx) => {
      const row: unknown = await tx("ledger_accounts as a")
        .leftJoin("ledger_account_balances as b", function () {
          this.on("b.tenant_id", "=", "a.tenant_id").andOn(
            "b.account_id",
            "=",
            "a.id",
          );
        })
        .where({ "a.tenant_id": input.tenantId, "a.id": input.accountId })
        .whereNull("a.deleted_at")
        .first({
          account_id: "a.id",
          currency: "a.currency_code",
          posted_balance_minor: tx.raw("coalesce(b.balance, 0)::text"),
          held_balance_minor: tx.raw("coalesce(b.held_balance, 0)::text"),
          available_balance_minor: tx.raw(
            "coalesce(b.available_balance, 0)::text",
          ),
          version: tx.raw("coalesce(b.version, 0)::integer"),
        });
      if (!row)
        throw new PostingError("ACCOUNT_NOT_FOUND", "Ledger account not found");
      return balance(row);
    });
  }

  public async customerWallet(input: {
    tenantId: string;
    customerId: string;
    currency: string;
  }): Promise<BalanceResult> {
    if (!/^[A-Z]{3}$/.test(input.currency))
      throw new PostingError("REQUEST_INVALID", "Currency is invalid");
    return withTenantTransaction(this.database, input.tenantId, async (tx) => {
      const mapping = await tx("customer_ledger_accounts as m")
        .join("ledger_accounts as a", function () {
          this.on("a.tenant_id", "=", "m.tenant_id").andOn(
            "a.id",
            "=",
            "m.ledger_account_id",
          );
        })
        .where({
          "m.tenant_id": input.tenantId,
          "m.customer_id": input.customerId,
          "m.account_purpose": "WALLET",
          "m.currency_code": input.currency,
          "a.status": "ACTIVE",
        })
        .whereNull("a.deleted_at")
        .first<{ ledger_account_id: string }>("m.ledger_account_id");
      if (!mapping)
        throw new PostingError(
          "CUSTOMER_WALLET_NOT_FOUND",
          "Customer wallet account not found",
        );
      return this.balanceWithin(tx, input.tenantId, mapping.ledger_account_id);
    });
  }

  private async balanceWithin(
    tx: Knex.Transaction,
    tenantId: string,
    accountId: string,
  ): Promise<BalanceResult> {
    const row: unknown = await tx("ledger_accounts as a")
      .leftJoin("ledger_account_balances as b", function () {
        this.on("b.tenant_id", "=", "a.tenant_id").andOn(
          "b.account_id",
          "=",
          "a.id",
        );
      })
      .where({ "a.tenant_id": tenantId, "a.id": accountId })
      .first({
        account_id: "a.id",
        currency: "a.currency_code",
        posted_balance_minor: tx.raw("coalesce(b.balance, 0)::text"),
        held_balance_minor: tx.raw("coalesce(b.held_balance, 0)::text"),
        available_balance_minor: tx.raw(
          "coalesce(b.available_balance, 0)::text",
        ),
        version: tx.raw("coalesce(b.version, 0)::integer"),
      });
    if (!row)
      throw new PostingError("ACCOUNT_NOT_FOUND", "Ledger account not found");
    return balance(row);
  }
}

function balance(value: unknown): BalanceResult {
  if (value === null || typeof value !== "object")
    throw new PostingError("BALANCE_INVALID", "Ledger balance is invalid");
  const row = value as Partial<BalanceRow>;
  if (
    typeof row.account_id !== "string" ||
    typeof row.currency !== "string" ||
    row.posted_balance_minor === undefined ||
    row.held_balance_minor === undefined ||
    row.available_balance_minor === undefined ||
    row.version === undefined
  )
    throw new PostingError("BALANCE_INVALID", "Ledger balance is invalid");
  return {
    account_id: String(row.account_id),
    currency: String(row.currency).trim(),
    posted_balance_minor: String(row.posted_balance_minor),
    held_balance_minor: String(row.held_balance_minor),
    available_balance_minor: String(row.available_balance_minor),
    version: Number(row.version),
  };
}
