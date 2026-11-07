import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { member, organization, projects, user } from "@/db/schema";
import { LEGACY_ORGANIZATION_ID } from "./legacy-organization";
import { isOperator } from "./signup-gate";
import { recordAudit } from "./audit";

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
  // Deleting Pebble must not prevent later operators from verifying their email.
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
    // Acquire the shared slug lock before row locks, as settings updates do.
    // Otherwise their audit actor FK can wait on this user while we wait on the slug lock.
    await tx.execute(sql`select pg_advisory_xact_lock(71001)`);
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

export class OrganizationSettingsError extends Error {}

type OrganizationActor = { id: string; name: string; email: string; emailVerified: boolean };

async function lockOrganization(tx: Transaction, slug: string, actor: OrganizationActor) {
  // Auth configuration also imports this module outside Next's request runtime.
  // Only the settings guard needs Next navigation, so load it when that guard runs.
  const { notFound } = await import("next/navigation");
  if (!actor.emailVerified) notFound();
  const [access] = await tx
    .select({ organization, role: member.role })
    .from(organization)
    .innerJoin(member, and(eq(member.organizationId, organization.id), eq(member.userId, actor.id)))
    .where(eq(organization.slug, slug))
    .for("update");
  if (!access) notFound();
  return access;
}

export async function updateOrganization(
  actor: OrganizationActor,
  slug: string,
  input: { name: unknown; slug: unknown },
) {
  return getDb().transaction(async (tx) => {
    // Share creation's lock so competing slug claims return a useful validation error.
    await tx.execute(sql`select pg_advisory_xact_lock(71001)`);
    const { organization: previous, role } = await lockOrganization(tx, slug, actor);
    if (role !== "owner" && role !== "admin")
      throw new OrganizationSettingsError(
        "Only owners and admins can change organization settings.",
      );
    const name = z.string().trim().min(1).max(60).safeParse(input.name);
    if (!name.success) throw new OrganizationSettingsError("Enter a name of 1–60 characters.");
    const nextSlug = z
      .string()
      .min(3)
      .max(40)
      .regex(/^[a-z0-9-]+$/)
      .safeParse(input.slug);
    if (!nextSlug.success)
      throw new OrganizationSettingsError(
        "Use a slug of 3–40 lowercase letters, numbers or hyphens.",
      );
    if (reserved.has(nextSlug.data))
      throw new OrganizationSettingsError("This slug is reserved. Choose another.");
    const [existing] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, nextSlug.data));
    if (existing && existing.id !== previous.id)
      throw new OrganizationSettingsError("This slug is already taken. Choose another.");
    const [saved] = await tx
      .update(organization)
      .set({ name: name.data, slug: nextSlug.data })
      .where(eq(organization.id, previous.id))
      .returning();
    const entry = {
      organizationId: saved.id,
      actor,
      targetType: "organization" as const,
      targetId: saved.id,
    };
    if (saved.name !== previous.name)
      await recordAudit(tx, {
        ...entry,
        action: "organization.renamed",
        details: { from: previous.name, to: saved.name },
      });
    if (saved.slug !== previous.slug)
      await recordAudit(tx, {
        ...entry,
        action: "organization.slug_changed",
        details: { from: previous.slug, to: saved.slug },
      });
    return saved;
  });
}

export async function deleteOrganizationForUser(
  actor: OrganizationActor,
  slug: string,
  confirmation: unknown,
) {
  await getDb().transaction(async (tx) => {
    const { organization: current, role } = await lockOrganization(tx, slug, actor);
    if (role !== "owner")
      throw new OrganizationSettingsError("Only the owner can delete this organization.");
    if (confirmation !== current.name)
      throw new OrganizationSettingsError(
        "Type the organization name exactly to confirm deletion.",
      );
    await deleteOrganization(tx, current.id);
  });
}

// Internal helper for organization/account deletion flows. Caller authorizes first.
// M2 adds subscription cancellation here. Dependent project data uses FK cascades.
export async function deleteOrganization(tx: Transaction, organizationId: string) {
  // During the expand migration, NULL-owned projects also belong to the legacy organization.
  if (organizationId === LEGACY_ORGANIZATION_ID)
    await tx.delete(projects).where(isNull(projects.organizationId));
  await tx.delete(organization).where(eq(organization.id, organizationId));
}
