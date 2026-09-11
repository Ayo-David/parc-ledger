import amqp from "amqplib";
import { loadConfig } from "./config/env.js";
import { createDatabase } from "./database/client.js";
import { EventWorker } from "./services/event-worker.js";
const config = loadConfig();
if (!config.AMQP_URL)
    throw new Error("AMQP_URL is required for the Ledger worker");
const database = createDatabase(config);
const worker = new EventWorker(database, `${config.SERVICE_NAME}-${process.pid}`);
const connection = await amqp.connect(config.AMQP_URL);
const channel = await connection.createConfirmChannel();
await channel.assertExchange("parc.events", "topic", { durable: true });
await channel.assertExchange("parc.events.dlx", "topic", { durable: true });
const queue = "parc.ledger.inbox.v1";
await channel.assertQueue(queue, {
    durable: true,
    arguments: { "x-dead-letter-exchange": "parc.events.dlx" },
});
const inboundRoutingKeys = config.LEDGER_INBOUND_ROUTING_KEYS.split(",")
    .map((key) => key.trim())
    .filter(Boolean);
for (const routingKey of inboundRoutingKeys)
    await channel.bindQueue(queue, "parc.events", routingKey);
await channel.prefetch(10);
await channel.consume(queue, (message) => {
    void handle(message);
}, { noAck: false });
async function handle(message) {
    if (!message)
        return;
    try {
        const event = JSON.parse(message.content.toString());
        await worker.receive({
            tenantId: event.tenant_id,
            sourceService: event.producer,
            eventId: event.event_id,
            eventType: event.event_type,
            eventVersion: event.event_version,
            payload: event.payload,
            idempotencyKey: event.idempotency_key,
            ...(event.correlation_id === undefined
                ? {}
                : { correlationId: event.correlation_id }),
            ...(event.causation_id === undefined
                ? {}
                : { causationId: event.causation_id }),
        });
        channel.ack(message);
    }
    catch {
        channel.nack(message, false, false);
    }
}
const timer = setInterval(() => {
    void worker.publishOne(channel);
}, 250);
process.on("SIGTERM", () => {
    clearInterval(timer);
    void channel.close();
    void connection.close();
    void database.destroy();
});
