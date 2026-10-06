import { z } from "zod";
const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(3003),
    HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.string().optional(),
    AUTH_JWKS_URL: z
      .string()
      .url()
      .default("http://127.0.0.1:3001/.well-known/jwks.json"),
    AUTH_JWT_ISSUER: z.string().url().default("https://auth.parc.invalid"),
    AUTH_TOKEN_URL: z
      .string()
      .url()
      .default("http://127.0.0.1:3001/internal/v1/oauth/token"),
    SERVICE_CLIENT_KEY_ID: z.string().min(1),
    SERVICE_CLIENT_PRIVATE_KEY_BASE64: z.string().min(1),
    TENANT_ADMIN_URL: z.string().url().default("http://127.0.0.1:3002"),
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
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && !value.DATABASE_URL)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required in production",
      });
  })
  .transform((value) => ({
    ...value,
    DATABASE_URL: value.DATABASE_URL ?? "postgresql:///parc_ledger",
  }));
export type AppConfig = z.infer<typeof schema>;
export function loadConfig(
  overrides: Partial<
    Record<keyof z.input<typeof schema>, string | number>
  > = {},
): AppConfig {
  return schema.parse({ ...process.env, ...overrides });
}
