import "dotenv/config";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Knex } from "knex";
const compiledMigrations = process.env.KNEX_MIGRATIONS_COMPILED === "true";
// The knex CLI changes into the knexfile's directory (dist/ when compiled).
const migrationsDirectory = path.resolve("db/migrations");
// Only load runnable files; the build also emits .d.ts declarations here.
const runnableExtension = compiledMigrations ? ".js" : ".ts";

// Source and compiled migrations must share one identity in knex_migrations.
// Names keep the original .ts suffix so existing history rows stay valid.
const migrationSource: Knex.MigrationSource<string> = {
  async getMigrations() {
    return (await readdir(migrationsDirectory))
      .filter(
        (file) =>
          path.extname(file) === runnableExtension && !file.endsWith(".d.ts"),
      )
      .sort();
  },
  getMigrationName(file) {
    return `${path.basename(file, runnableExtension)}.ts`;
  },
  getMigration(file) {
    return import(pathToFileURL(path.join(migrationsDirectory, file)).href);
  },
};

const config: Knex.Config = {
  client: "pg",
  connection: process.env.DATABASE_URL ?? "postgresql:///parc_ledger",
  migrations: { extension: compiledMigrations ? "js" : "ts", migrationSource },
};
export default config;
