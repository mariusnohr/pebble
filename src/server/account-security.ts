import "server-only";
import { APIError } from "better-auth/api";
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { member, organization, session, user, verification } from "@/db/schema";
import { queueEmail } from "./email/queue";
import { requestDimensions } from "./ingestion";
import { deleteOrganization, type Transaction } from "./organizations";

export async function passwordChanged(tx: Transaction, actor: { id: string; email: string }) {
  // Invalidate outstanding reset links and password-authenticated 2FA challenges too.
  await tx.delete(verification).where(eq(verification.value, actor.id));
  await queueEmail(tx, {
    to: actor.email,
    template: "passwordChanged",
    data: {
      subject: "Your Pebble password was changed",
      heading: "Your password was changed",
      paragraphs: [
        "Your Pebble password was changed. If this was not you, reset your password immediately and review your active sessions.",
      ],
      links: [{ label: "Reset password", path: "/forgot-password" }],
    },
  });
}

export async function deleteAccountOrganizations(tx: Transaction, userId: string) {
  // Shares the user lock with organization creation; organization locks also prevent
  // concurrent membership inserts (their foreign keys take a key-share lock).
  await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
  const memberships = await tx.select().from(member).where(eq(member.userId, userId));
  const organizations = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(
      inArray(
        organization.id,
        memberships.map((row) => row.organizationId),
      ),
    )
    .orderBy(asc(organization.id))
    .for("update");
  const sole: string[] = [];
  for (const org of organizations) {
    const members = await tx
      .select()
      .from(member)
      .where(eq(member.organizationId, org.id))
      .for("update");
    const own = members.find((row) => row.userId === userId);
    if (own?.role === "owner" && members.some((row) => row.userId !== userId))
      throw new APIError("BAD_REQUEST", { message: "Transfer ownership or remove members first" });
    if (own && members.length === 1) sole.push(org.id);
  }
  for (const id of sole) await deleteOrganization(tx, id);
  await tx.delete(verification).where(eq(verification.value, userId));
}

export async function touchSession(
  sessionId: string,
  connection: Transaction | ReturnType<typeof getDb> = getDb(),
) {
  // Do not change updatedAt: Better Auth uses it to decide when to renew the cookie.
  await connection
    .update(session)
    .set({ lastActiveAt: new Date(), updatedAt: sql`${session.updatedAt}` })
    .where(eq(session.id, sessionId));
}

export async function listAccountSessions(tx: Transaction, userId: string, currentId: string) {
  const rows = await tx
    .select()
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())))
    .orderBy(asc(session.createdAt));
  return rows.map((row) => {
    const { browser, os, device } = requestDimensions(row.userAgent ?? "");
    return {
      id: row.id,
      summary: row.userAgent ? `${browser} on ${os} · ${device}` : "Unknown device",
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt ?? row.updatedAt,
      current: row.id === currentId,
    };
  });
}

export async function revokeAccountSession(
  tx: Transaction,
  userId: string,
  currentId: string,
  id: string,
) {
  if (id === currentId)
    throw new APIError("BAD_REQUEST", { message: "Use Sign out to end your current session." });
  await tx
    .delete(session)
    .where(and(eq(session.id, id), eq(session.userId, userId), ne(session.id, currentId)));
}
