import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { member, organization, user } from "@/db/schema";
import { LEGACY_ORGANIZATION_ID } from "./legacy-organization";
import { isOperator } from "./signup-gate";

export type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
const reserved = new Set(["account", "new", "invitations", "operator", "api", "app"]);

export async function claimLegacyOrganization(
  tx: Transaction,
  actor: { id: string; email: string },
) {
  if (!isOperator(actor.email)) return;
  // Serializes competing operators; called in the verification transaction.
  await tx
    .select()
    .from(organization)
    .where(eq(organization.id, LEGACY_ORGANIZATION_ID))
    .for("update");
  const [owner] = await tx
    .select()
    .from(member)
    .where(and(eq(member.organizationId, LEGACY_ORGANIZATION_ID), eq(member.role, "owner")));
  if (owner) return;
  await tx
    .insert(member)
    .values({
      organizationId: LEGACY_ORGANIZATION_ID,
      userId: actor.id,
      role: "owner",
      createdAt: new Date(),
    })
    .onConflictDoUpdate({ target: [member.organizationId, member.userId], set: { role: "owner" } });
  await tx
    .update(user)
    .set({ lastOrganizationId: LEGACY_ORGANIZATION_ID })
    .where(eq(user.id, actor.id));
}

export async function createOrganization(userId: string, name: string) {
  name = z.string().trim().min(1).max(60).parse(name);
  return getDb().transaction(async (tx) => {
    const [actor] = await tx.select().from(user).where(eq(user.id, userId)).for("update");
    if (!actor?.emailVerified) throw new Error("Verify your email first.");
    const owned = await tx
      .select()
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.role, "owner")));
    if (owned.length >= 5) throw new Error("You can own at most 5 organizations.");
    let base = name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30)
      .replace(/-$/g, "");
    if (base.length < 3 || reserved.has(base)) base = `org-${base || "team"}`;
    // Serialize slug selection, including different users choosing the same name.
    await tx.execute(sql`select pg_advisory_xact_lock(71001)`);
    let slug = base;
    for (let suffix = 2; ; suffix++) {
      const [existing] = await tx
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.slug, slug));
      if (!existing) break;
      slug = `${base}-${suffix}`;
    }
    const [created] = await tx
      .insert(organization)
      .values({ name, slug, createdAt: new Date() })
      .returning();
    await tx
      .insert(member)
      .values({ organizationId: created.id, userId, role: "owner", createdAt: new Date() });
    await tx.update(user).set({ lastOrganizationId: created.id }).where(eq(user.id, userId));
    return created;
  });
}

// Internal helper for later organization/account deletion flows. Caller authorizes first.
// M2 adds subscription cancellation here. All dependent data uses FK cascades.
export async function deleteOrganization(tx: Transaction, organizationId: string) {
  await tx.delete(organization).where(eq(organization.id, organizationId));
}
