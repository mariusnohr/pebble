import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const globalDb = globalThis as unknown as { pebblePool?: Pool };

export function getDb() {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not configured. Follow the README to connect Postgres.");
  globalDb.pebblePool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  return drizzle(globalDb.pebblePool, { schema });
}

export async function closeDb() {
  await globalDb.pebblePool?.end();
  globalDb.pebblePool = undefined;
}
