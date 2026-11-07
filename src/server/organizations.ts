import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { member, organization, projects, user } from "@/db/schema";
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
  const [legacy] = await tx
    .select()
    .from(organization)
    .where(eq(organization.id, LEGACY_ORGANIZATION_ID))
    .for("update");
  // The sole owner may have deleted Pebble. Verification must still succeed,
  // without recreating the deleted organization or a dangling membership.
  if (!legacy) return;
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
// M2 adds subscription cancellation here. Dependent project data uses FK cascades.
export async function deleteOrganization(tx: Transaction, organizationId: string) {
  // During the rollback window, tenancy treats NULL-owned projects as Pebble's.
  // They have no organization FK to cascade, so remove them explicitly first.
  if (organizationId === LEGACY_ORGANIZATION_ID)
    await tx.delete(projects).where(isNull(projects.organizationId));
  await tx.delete(organization).where(eq(organization.id, organizationId));
}
