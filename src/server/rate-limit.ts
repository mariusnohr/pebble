import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rateLimits } from "@/db/schema";
import { hashToken } from "./crypto";

export async function rateLimit(key: string, limit: number, seconds = 60) {
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const [row] = await getDb()
    .insert(rateLimits)
    .values({
      key: hashToken(`${process.env.BETTER_AUTH_SECRET ?? ""}:${key}:${bucket}`),
      count: 1,
      expiresAt: new Date((bucket + 1) * seconds * 1000),
    })
    .onConflictDoUpdate({ target: rateLimits.key, set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  return row.count <= limit;
}

// Window starts with the first attempt, rather than resetting at a clock boundary.
// Called outside the auth transaction so rejected attempts cannot roll it back.
export async function accountRateLimit(key: string, limit: number, seconds: number) {
  const [row] = await getDb()
    .insert(rateLimits)
    .values({
      key: hashToken(`${process.env.BETTER_AUTH_SECRET ?? ""}:account:${key}`),
      count: 1,
      expiresAt: new Date(Date.now() + seconds * 1000),
    })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${rateLimits.expiresAt} <= now() then 1 else ${rateLimits.count} + 1 end`,
        expiresAt: sql`case when ${rateLimits.expiresAt} <= now() then now() + ${seconds} * interval '1 second' else ${rateLimits.expiresAt} end`,
      },
    })
    .returning({ count: rateLimits.count });
  return row.count <= limit;
}

// Enable only behind a trusted proxy that appends the client IP as the last entry
// and prevents direct access to the app. Earlier entries may be client-supplied.
export function clientAddress(headers: Headers) {
  return process.env.TRUST_PROXY === "true"
    ? (headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown").slice(0, 100)
    : "direct";
}
