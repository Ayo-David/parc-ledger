import "dotenv/config";
import type { Knex } from "knex";
const config: Knex.Config = {
  client: "pg",
  connection: process.env.DATABASE_URL ?? "postgresql:///parc_ledger",
  migrations: { directory: "./db/migrations", extension: "ts" },
};
export default config;
