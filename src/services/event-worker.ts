import type { ConfirmChannel } from "amqplib";
import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { withTenantTransaction } from "../database/client.js";

type OutboxEvent = {
  id: string;
  event_type: string;
  event_version: number;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: object;
  correlation_id: string | null;
  causation_id: string | null;
  idempotency_key: string | null;
  created_at: Date | string;
};

export class EventWorker {
  public constructor(
    private readonly db: Knex,
    private readonly workerId: string,
  ) {}

  public async publishOne(
    channel: ConfirmChannel,
    exchange = "parc.events",
  ): Promise<boolean> {
    const claimed = await this.db.raw<{ rows: OutboxEvent[] }>(
      "SELECT * FROM public.claim_next_ledger_outbox(?, ?)",
      [this.workerId, 30],
    );
    const event = claimed.rows[0];
    if (!event) return false;
    try {
      await new Promise<void>((resolve, reject) => {
        channel.publish(
          exchange,
          event.event_type,
          Buffer.from(
            JSON.stringify({
              event_id: event.id,
              event_type: event.event_type,
              event_version: event.event_version,
              occurred_at: new Date(event.created_at).toISOString(),
              producer: "parc-ledger",
              tenant_id: event.tenant_id,
              correlation_id: event.correlation_id ?? event.id,
              causation_id: event.causation_id,
              idempotency_key: event.idempotency_key ?? event.id,
              aggregate_type: event.aggregate_type,
              aggregate_id: event.aggregate_id,
              aggregate_version: 1,
              data_classification: "INTERNAL",
              payload: event.payload,
            }),
          ),
          {
            persistent: true,
            messageId: event.id,
            contentType: "application/json",
          },
          (error) =>
            error
              ? reject(
                  error instanceof Error ? error : new Error(String(error)),
                )
              : resolve(),
        );
      });
      const completed = await this.db.raw<{
        rows: Array<{ completed: boolean }>;
      }>("SELECT public.complete_ledger_outbox(?, ?, ?, ?) AS completed", [
        event.id,
        this.workerId,
        exchange,
        event.event_type,
      ]);
      if (!completed.rows[0]?.completed)
        throw new Error("Outbox lease was lost before publication completion");
      return true;
    } catch (error) {
      await this.db.raw("SELECT public.fail_ledger_outbox(?, ?, ?, ?)", [
        event.id,
        this.workerId,
        error instanceof Error ? error.message : "publish_failed",
        8,
      ]);
      return false;
    }
  }

  public async receive(input: {
    tenantId: string;
    sourceService: string;
    eventId: string;
    eventType: string;
    eventVersion: number;
    payload: object;
    idempotencyKey?: string;
    correlationId?: string;
    causationId?: string;
  }): Promise<boolean> {
    return withTenantTransaction(this.db, input.tenantId, async (tx) => {
      const payloadHash = hash(input.payload);
      const existing = await tx("ledger_inbox_events")
        .where({ source_service: input.sourceService, event_id: input.eventId })
        .first<{ payload_hash: string }>();
      if (existing) {
        if (existing.payload_hash !== payloadHash)
          throw new Error(
            "Inbox event identity was reused with a different payload",
          );
        return false;
      }
      await tx("ledger_inbox_events").insert({
        tenant_id: input.tenantId,
        source_service: input.sourceService,
        event_id: input.eventId,
        event_type: input.eventType,
        event_version: input.eventVersion,
        idempotency_key: input.idempotencyKey ?? null,
        correlation_id: input.correlationId ?? null,
        causation_id: input.causationId ?? null,
        payload: input.payload,
        payload_hash: payloadHash,
        status: "RECEIVED",
      });
      return true;
    });
  }
}

function hash(value: object): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
