import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Knex } from "knex";

const snapshotUrl = new URL("../schema/current.sql", import.meta.url);
const approvedExistingBaselineHash =
  "527bb8922a09f2cbc5bc340ef743ba24c781e4412c651d1732d4181826f48d41";
const canonicalSnapshotHash =
  "3c662204cf5fcd529e79f7b8fece31c9b776267cd582d863fc6e1c4e2ee3b806";
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable("ledger_transactions")) {
    if (
      process.env.APPROVED_EXISTING_BASELINE_SHA256 !==
      approvedExistingBaselineHash
    )
      throw new Error(
        "Existing Ledger schema requires the explicitly approved baseline SHA-256",
      );
    return;
  }
  await knex.raw(`DO $roles$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='parc_ledger_runtime') THEN CREATE ROLE parc_ledger_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='parc_ledger_worker') THEN CREATE ROLE parc_ledger_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='parc_ledger_readonly') THEN CREATE ROLE parc_ledger_readonly NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
  END $roles$;`);
  const sql = await readFile(fileURLToPath(snapshotUrl), "utf8");
  if (createHash("sha256").update(sql).digest("hex") !== canonicalSnapshotHash)
    throw new Error("Ledger schema snapshot hash mismatch");
  await knex.raw(sql);
  await knex.raw("SET search_path TO public");
}

export function down(): Promise<never> {
  return Promise.reject(new Error("Ledger baseline is forward-only"));
}
