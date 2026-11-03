import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rateLimits } from "@/db/schema";
import { adminPasswordHash } from "./config";
import { hashToken } from "./crypto";

export async function rateLimit(key: string, limit: number, seconds = 60) {
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const [row] = await getDb()
    .insert(rateLimits)
    .values({
      key: hashToken(`${adminPasswordHash() ?? ""}:${key}:${bucket}`),
      count: 1,
      expiresAt: new Date((bucket + 1) * seconds * 1000),
    })
    .onConflictDoUpdate({ target: rateLimits.key, set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  return row.count <= limit;
}

// Enable only when the application's trusted reverse proxy overwrites this header.
export function clientAddress(headers: Headers) {
  return process.env.TRUST_PROXY === "true"
    ? (headers.get("x-real-ip") ?? "unknown").slice(0, 100)
    : "direct";
}
