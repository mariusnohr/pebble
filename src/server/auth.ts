import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { adminSessions } from "@/db/schema";
import { hashToken, randomToken } from "./crypto";

const COOKIE = "pebble_admin";
export function appOrigin() {
  return new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
}

export async function verifyAdmin() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token || !process.env.ADMIN_PASSWORD_HASH) return false;
  const [session] = await getDb()
    .select()
    .from(adminSessions)
    .where(
      and(
        eq(adminSessions.tokenHash, hashToken(token)),
        gt(adminSessions.expiresAt, new Date()),
        eq(adminSessions.passwordVersion, hashToken(process.env.ADMIN_PASSWORD_HASH)),
      ),
    )
    .limit(1);
  return Boolean(session);
}

export async function requireAdmin() {
  if (!(await verifyAdmin())) redirect("/login");
}

export async function assertSameOrigin() {
  if ((await headers()).get("origin") !== appOrigin()) throw new Error("Invalid request origin.");
}

export async function createAdminSession() {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 7 * 86400000);
  await getDb()
    .insert(adminSessions)
    .values({
      tokenHash: hashToken(token),
      expiresAt,
      passwordVersion: hashToken(process.env.ADMIN_PASSWORD_HASH!),
    });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: appOrigin().startsWith("https:"),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroyAdminSession() {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token)
    await getDb()
      .delete(adminSessions)
      .where(eq(adminSessions.tokenHash, hashToken(token)));
  store.delete(COOKIE);
}
