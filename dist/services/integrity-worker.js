import { createHash, randomUUID } from "node:crypto";
import { withTenantTransaction } from "../database/client.js";
export class IntegrityWorker {
    db;
    workerId;
    constructor(db, workerId) {
        this.db = db;
        this.workerId = workerId;
    }
    async runBalanceDrift(tenantId, runReference) {
        const requestHash = hash({
            tenantId,
            runReference,
            check: "BALANCE_DRIFT",
        });
        return withTenantTransaction(this.db, tenantId, async (tx) => {
            await tx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", [
                `integrity:${tenantId}:${runReference}`,
            ]);
            const existing = await tx("ledger_integrity_checks")
                .where({
                tenant_id: tenantId,
                check_type: "BALANCE_DRIFT",
                run_reference: runReference,
            })
                .first();
            if (existing)
                return { discrepancies: Number(existing.records_failed) };
            const rows = await tx.raw(`SELECT b.account_id,b.currency_code,
          CASE WHEN a.normal_balance='DEBIT'
            THEN COALESCE(p.debits-p.credits,0)
            ELSE COALESCE(p.credits-p.debits,0)
          END::bigint AS expected,b.balance AS actual
        FROM ledger_account_balances b
        JOIN ledger_accounts a ON a.id=b.account_id
        LEFT JOIN (
          SELECT e.account_id,e.currency_code,
            SUM(CASE WHEN e.entry_type='DEBIT' THEN e.amount ELSE 0 END) AS debits,
            SUM(CASE WHEN e.entry_type='CREDIT' THEN e.amount ELSE 0 END) AS credits
          FROM journal_entries e
          JOIN journals j ON j.id=e.journal_id AND j.status='POSTED'
          GROUP BY e.account_id,e.currency_code
        ) p ON p.account_id=b.account_id AND p.currency_code=b.currency_code
        WHERE b.tenant_id=? AND b.balance<>CASE WHEN a.normal_balance='DEBIT'
          THEN COALESCE(p.debits-p.credits,0) ELSE COALESCE(p.credits-p.debits,0) END`, [tenantId]);
            const checked = await tx("ledger_account_balances")
                .where({ tenant_id: tenantId })
                .count("* AS count")
                .first();
            await tx("ledger_integrity_checks").insert({
                tenant_id: tenantId,
                check_type: "BALANCE_DRIFT",
                check_date: tx.raw("CURRENT_DATE"),
                status: rows.rows.length ? "FAILED" : "PASSED",
                records_checked: Number(checked?.count ?? 0),
                records_failed: rows.rows.length,
                discrepancy_amount: rows.rows
                    .reduce((sum, row) => sum + (BigInt(row.actual) - BigInt(row.expected)), 0n)
                    .toString(),
                failure_details: { discrepancies: rows.rows },
                run_reference: runReference,
                request_hash: requestHash,
                worker_id: this.workerId,
                started_at: tx.fn.now(),
            });
            return { discrepancies: rows.rows.length };
        });
    }
    async recordReconciliationItem(input) {
        await withTenantTransaction(this.db, input.tenantId, async (tx) => {
            const requestHash = hash({
                reference: input.reference,
                sourceAmount: input.sourceAmount,
                ledgerAmount: input.ledgerAmount,
                currency: input.currency,
            });
            await tx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", [
                `reconciliation:${input.runId}:${input.idempotencyKey}`,
            ]);
            const existing = await tx("reconciliation_items")
                .where({
                reconciliation_run_id: input.runId,
                idempotency_key: input.idempotencyKey,
            })
                .first();
            if (existing) {
                if (existing.source_payload_hash !== requestHash)
                    throw new Error("Reconciliation idempotency key was reused");
                return;
            }
            const difference = BigInt(input.sourceAmount) - BigInt(input.ledgerAmount);
            const [item] = await tx("reconciliation_items")
                .insert({
                id: randomUUID(),
                tenant_id: input.tenantId,
                reconciliation_run_id: input.runId,
                external_reference: input.reference,
                source_amount: input.sourceAmount,
                ledger_amount: input.ledgerAmount,
                currency_code: input.currency,
                difference_amount: difference.toString(),
                status: difference === 0n ? "MATCHED" : "EXCEPTION",
                source_payload_hash: requestHash,
                idempotency_key: input.idempotencyKey,
            })
                .returning("id");
            if (difference !== 0n && item)
                await tx("reconciliation_exceptions").insert({
                    tenant_id: input.tenantId,
                    reconciliation_item_id: item.id,
                    exception_code: "AMOUNT_MISMATCH",
                    description: "Source and Ledger amounts differ",
                });
        });
    }
}
function hash(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
