export class TenantAdminApprovalGateway {
    url;
    token;
    constructor(url, token) {
        this.url = url;
        this.token = token;
    }
    async consume(input) {
        await this.call(`/internal/v1/approvals/${encodeURIComponent(input.approvalId)}/consume`, input.tenantId, input.idempotencyKey, input.binding);
    }
    async report(input) {
        await this.call(`/internal/v1/approvals/${encodeURIComponent(input.approvalId)}/execution`, input.tenantId, input.idempotencyKey, {
            status: input.status,
            ...(input.result ? { result: input.result } : {}),
        });
    }
    async call(path, tenantId, idempotencyKey, body) {
        const response = await fetch(new URL(path, this.url), {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-service-token": this.token,
                "x-service-name": "parc-ledger",
                "x-tenant-id": tenantId,
                "idempotency-key": idempotencyKey,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
            throw new Error(`Tenant Admin approval request failed with ${response.status}`);
    }
}
