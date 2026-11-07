import { config } from "dotenv";
import { Pool } from "pg";
import { M1_MIGRATION, migrateThrough, migrateWithConfirmation } from "./migration-boundary";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

if (!process.env.DATABASE_URL) {
  // Local builds may run without a database. Deploys set DATABASE_URL, so the
  // same build command applies pending migrations before the app starts.
  console.log("DATABASE_URL is not set; skipping database migrations.");
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    if (process.argv.includes("--through-m1")) {
      await migrateThrough(pool, M1_MIGRATION);
    } else {
      await migrateWithConfirmation(pool, process.env.F3_CONTRACT_CONFIRMATION);
    }
    console.log("Database migrations are up to date.");
  } finally {
    await pool.end();
  }
}
