import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

export const EXPAND_MIGRATION = "0002_magenta_prodigy";
export const M1_MIGRATION = "0004_invitation_lifecycle";

// Use the real Drizzle migrator and original SQL/hashes with a bounded journal.
// Historical compatibility fixtures and local M1 bootstrap must never contract.
export async function migrateThrough(pool: Pool, boundary: string) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const source = join(root, "drizzle");
  const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
  const index = journal.entries.findIndex((entry: { tag: string }) => entry.tag === boundary);
  if (index < 0) throw new Error("Unknown migration boundary");
  journal.entries = journal.entries.slice(0, index + 1);
  await mkdir(join(root, ".nohr"), { recursive: true });
  const folder = await mkdtemp(join(root, ".nohr/migration-boundary-"));
  try {
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export async function migrateWithConfirmation(pool: Pool, confirmation = "") {
  // Bind the setting to the same connection used for the migration transaction.
  const client = await pool.connect();
  try {
    await client.query("select set_config('pebble.f3_contract_confirmation', $1, false)", [
      confirmation.trim(),
    ]);
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  } finally {
    // Do not leak an approval to a subsequent caller of this pooled connection.
    try {
      await client.query("reset pebble.f3_contract_confirmation");
    } finally {
      client.release();
    }
  }
}
