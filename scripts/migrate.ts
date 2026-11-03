import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

if (!process.env.DATABASE_URL) {
  // Local builds may run without a database. Deploys set DATABASE_URL, so the
  // same build command applies pending migrations before the app starts.
  console.log("DATABASE_URL is not set; skipping database migrations.");
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
    console.log("Database migrations are up to date.");
  } finally {
    await pool.end();
  }
}
