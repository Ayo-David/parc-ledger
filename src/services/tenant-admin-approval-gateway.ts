import type { ParcTokenClient } from "../security/parc-service-auth.js";
import type { ApprovalGateway } from "./adjustment-service.js";

export class TenantAdminApprovalGateway implements ApprovalGateway {
  public constructor(
    private readonly url: string,
    private readonly tokens: Pick<ParcTokenClient, "authorization">,
  ) {}
  public async consume(input: {
    tenantId: string;
    approvalId: string;
    idempotencyKey: string;
    binding: Record<string, string>;
  }): Promise<void> {
    await this.call(
      `/internal/v1/approvals/${encodeURIComponent(input.approvalId)}/consume`,
      input.tenantId,
      input.idempotencyKey,
      input.binding,
    );
  }
  public async report(input: {
    tenantId: string;
    approvalId: string;
    idempotencyKey: string;
    status: "COMPLETED" | "FAILED";
    result?: Record<string, string>;
  }): Promise<void> {
    await this.call(
      `/internal/v1/approvals/${encodeURIComponent(input.approvalId)}/execution`,
      input.tenantId,
      input.idempotencyKey,
      {
        status: input.status,
        ...(input.result ? { result: input.result } : {}),
      },
    );
  }
  private async call(
    path: string,
    tenantId: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await fetch(new URL(path, this.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Delegated while serving an administrator's adjustment or reversal.
        authorization: await this.tokens.authorization({
          audience: "parc-tenant-admin",
          scopes: ["tenant.approvals.consume"],
          tenantId,
        }),
        "x-calling-service": "parc-ledger",
        "x-tenant-id": tenantId,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(
        `Tenant Admin approval request failed with ${response.status}`,
      );
  }
}
