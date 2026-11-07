import { config } from "dotenv";
import { Pool } from "pg";
import { cleanupRetention, purgeMaintenance } from "../src/server/jobs/cleanup";
config({ path: ".env.local", quiet: true });
config({ quiet: true });
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  await cleanupRetention(pool);
  await purgeMaintenance(pool);
  console.log("Retention cleanup complete.");
} finally {
  await pool.end();
}
