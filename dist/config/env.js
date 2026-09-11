import { z } from "zod";
const schema = z.object({
    NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),
    PORT: z.coerce.number().int().positive().default(3003),
    HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.string().default("postgresql:///parc_ledger"),
    INTERNAL_SERVICE_TOKEN: z.string().min(24),
    TENANT_ADMIN_URL: z.string().url().default("http://127.0.0.1:3002"),
    TENANT_ADMIN_SERVICE_TOKEN: z.string().min(24).optional(),
    AMQP_URL: z.string().url().optional(),
    LEDGER_INBOUND_ROUTING_KEYS: z
        .string()
        .default("tenant.configuration-changed.v1"),
    LEDGER_INTEGRITY_TENANT_IDS: z.string().default(""),
    LEDGER_INTEGRITY_INTERVAL_MS: z.coerce
        .number()
        .int()
        .min(60_000)
        .default(86_400_000),
    SERVICE_NAME: z.string().default("parc-ledger"),
    SERVICE_VERSION: z.string().default("0.1.0"),
});
export function loadConfig(overrides = {}) {
    return schema.parse({ ...process.env, ...overrides });
}
