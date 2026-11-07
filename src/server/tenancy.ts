import "server-only";
import { and, eq, isNull, or } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import { member, organization, projects, user } from "@/db/schema";
import { requireMemberUser } from "./auth";
import { LEGACY_ORGANIZATION_ID } from "./legacy-organization";

export function projectOrganization(organizationId: string) {
  return organizationId === LEGACY_ORGANIZATION_ID
    ? or(eq(projects.organizationId, organizationId), isNull(projects.organizationId))!
    : eq(projects.organizationId, organizationId);
}
// Also accepts an authenticated actor for integration tests and route handlers.
export async function resolveOrganization(
  slug: string,
  actor: { id: string; emailVerified: boolean },
) {
  if (!actor.emailVerified) notFound();
  const [row] = await getDb()
    .select({ organization, role: member.role })
    .from(organization)
    .innerJoin(member, and(eq(member.organizationId, organization.id), eq(member.userId, actor.id)))
    .where(eq(organization.slug, slug));
  if (!row) notFound();
  return row;
}
export async function requireOrganization(slug: string) {
  const actor = await requireMemberUser();
  return { ...(await resolveOrganization(slug, actor)), actor };
}
export function assertOrganizationAdmin(role: string) {
  if (role !== "owner" && role !== "admin")
    throw new Error("Only owners and admins can change projects and ingest keys.");
}
export async function organizationProjects(slug: string) {
  const access = await requireOrganization(slug);
  return {
    ...access,
    projects: await getDb()
      .select()
      .from(projects)
      .where(projectOrganization(access.organization.id))
      .orderBy(projects.createdAt),
  };
}
export async function resolveProject(
  slug: string,
  id: string,
  actor: { id: string; emailVerified: boolean },
) {
  const access = await resolveOrganization(slug, actor);
  if (!z.uuid().safeParse(id).success) notFound();
  const [project] = await getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), projectOrganization(access.organization.id)));
  if (!project) notFound();
  return { ...access, project };
}
export async function requireProject(slug: string, id: string) {
  const actor = await requireMemberUser();
  return { ...(await resolveProject(slug, id, actor)), actor };
}
// Old URLs/API paths have no slug: derive it, then use the same membership guard.
export async function requireProjectById(id: string) {
  const actor = await requireMemberUser();
  if (!z.uuid().safeParse(id).success) notFound();
  const [row] = await getDb()
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, id));
  if (!row) notFound();
  const [org] = await getDb()
    .select()
    .from(organization)
    .where(eq(organization.id, row.organizationId ?? LEGACY_ORGANIZATION_ID));
  if (!org) notFound();
  return { ...(await resolveProject(org.slug, id, actor)), actor };
}
export async function listOrganizations(userId: string) {
  return getDb()
    .select({ id: organization.id, name: organization.name, slug: organization.slug })
    .from(organization)
    .innerJoin(member, and(eq(member.organizationId, organization.id), eq(member.userId, userId)))
    .orderBy(organization.createdAt);
}
export async function rememberOrganization(userId: string, organizationId: string) {
  await getDb().update(user).set({ lastOrganizationId: organizationId }).where(eq(user.id, userId));
}
