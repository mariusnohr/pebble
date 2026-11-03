import { sql } from "drizzle-orm";
import { getDb } from "@/db";
export async function GET() {
  try {
    await getDb().execute(sql`select 1 from projects limit 1`);
    return Response.json({ status: "ready" });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
