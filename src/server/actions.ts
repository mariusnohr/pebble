"use server";

import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { apiKeys, projects, user } from "@/db/schema";
import { normalizeOrigins, projectSchema } from "@/lib/contracts";
import { assertSameOrigin, requireMemberUser, requireUser } from "./auth";
import { hashToken, randomToken } from "./crypto";
import {
  assertOrganizationAdmin,
  requireOrganization,
  requireProject,
  projectOrganization,
} from "./tenancy";
import {
  createOrganization,
  updateOrganization,
  deleteOrganizationForUser,
  OrganizationSettingsError,
} from "./organizations";
import { recordAudit } from "./audit";

export type ActionState = { error?: string; success?: string; secret?: string; projectId?: string };

export async function updateOrganizationAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  await assertSameOrigin();
  const actor = await requireMemberUser();
  const slug = String(form.get("org") ?? "");
  let saved;
  try {
    saved = await updateOrganization(actor, slug, {
      name: form.get("name"),
      slug: form.get("slug"),
    });
  } catch (error) {
    if (error instanceof OrganizationSettingsError) return { error: error.message };
    throw error;
  }
  revalidatePath("/app", "layout");
  if (saved.slug !== slug) redirect(`/app/${saved.slug}/settings`);
  return { success: "Organization updated." };
}

export async function deleteOrganizationAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  await assertSameOrigin();
  const actor = await requireMemberUser();
  try {
    await deleteOrganizationForUser(actor, String(form.get("org") ?? ""), form.get("confirmation"));
  } catch (error) {
    if (error instanceof OrganizationSettingsError) return { error: error.message };
    throw error;
  }
  revalidatePath("/app", "layout");
  redirect("/app");
}

export async function createOrganizationAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  await assertSameOrigin();
  const actor = await requireUser();
  const name = z.string().trim().min(1).max(60).safeParse(form.get("name"));
  if (!name.success) return { error: "Enter a name of 1–60 characters." };
  let slug: string;
  try {
    slug = (await createOrganization(actor.id, name.data)).slug;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not create organization." };
  }
  redirect(`/app/${slug}`);
}

export async function updateNameAction(_: ActionState, form: FormData): Promise<ActionState> {
  await assertSameOrigin();
  const actor = await requireUser();
  const name = z.string().trim().min(1).max(80).safeParse(form.get("name"));
  if (!name.success) return { error: "Enter a name of 1–80 characters." };
  await getDb().update(user).set({ name: name.data }).where(eq(user.id, actor.id));
  revalidatePath("/app", "layout");
  return { success: "Name updated." };
}

export async function saveProjectAction(_: ActionState, form: FormData): Promise<ActionState> {
  await assertSameOrigin();
  const slug = String(form.get("org") ?? "");
  const access = form.get("id")
    ? await requireProject(slug, String(form.get("id")))
    : { ...(await requireOrganization(slug)), project: undefined };
  assertOrganizationAdmin(access.role);
  const parsed = projectSchema.safeParse({
    ...Object.fromEntries(
      ["name", "origins", "timezone", "retentionDays"].map((key) => [key, form.get(key)]),
    ),
    agentContext: form.get("agentContext") ?? access.project?.agentContext ?? "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  let origins: string[];
  try {
    origins = normalizeOrigins(parsed.data.origins);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid origins." };
  }
  const { name, timezone, retentionDays, agentContext } = parsed.data;
  const id = form.get("id");
  if (id && !z.uuid().safeParse(id).success) return { error: "Invalid project." };
  const data = {
    name,
    origins,
    timezone,
    retentionDays,
    agentContext,
    paused: form.get("paused") === "on",
  };
  const project = await getDb().transaction(async (tx) => {
    const [previous] = id
      ? await tx
          .select()
          .from(projects)
          .where(and(eq(projects.id, String(id)), projectOrganization(access.organization.id)))
          .for("update")
      : [];
    const [saved] = id
      ? await tx
          .update(projects)
          .set(data)
          .where(and(eq(projects.id, String(id)), projectOrganization(access.organization.id)))
          .returning()
      : await tx
          .insert(projects)
          .values({ ...data, organizationId: access.organization.id })
          .returning();
    if (!saved) return null;
    const entry = {
      organizationId: access.organization.id,
      actor: access.actor,
      targetType: "project" as const,
      targetId: saved.id,
      details: { name: saved.name },
    };
    await recordAudit(tx, { ...entry, action: id ? "project.updated" : "project.created" });
    if (previous && previous.paused !== saved.paused)
      await recordAudit(tx, {
        ...entry,
        action: saved.paused ? "project.paused" : "project.resumed",
      });
    return saved;
  });
  if (!project) return { error: "Project no longer exists." };
  revalidatePath("/app", "layout");
  return { success: id ? "Project updated." : "Project created.", projectId: project.id };
}

export async function deleteProjectAction(_: ActionState, form: FormData): Promise<ActionState> {
  await assertSameOrigin();
  const parsed = z.uuid().safeParse(form.get("id"));
  if (!parsed.success) return { error: "Invalid project." };
  const access = await requireProject(String(form.get("org") ?? ""), parsed.data);
  assertOrganizationAdmin(access.role);
  const { project } = access;
  if (!project || form.get("confirmation") !== project.name)
    return { error: "Type the project name exactly to confirm deletion." };
  await getDb().transaction(async (tx) => {
    await tx
      .delete(projects)
      .where(and(eq(projects.id, project.id), projectOrganization(access.organization.id)));
    await recordAudit(tx, {
      organizationId: access.organization.id,
      actor: access.actor,
      action: "project.deleted",
      targetType: "project",
      targetId: project.id,
      details: { name: project.name },
    });
  });
  revalidatePath("/app", "layout");
  redirect(`/app/${access.organization.slug}`);
}

export async function createKeyAction(_: ActionState, form: FormData): Promise<ActionState> {
  await assertSameOrigin();
  const parsed = z
    .object({ projectId: z.uuid(), name: z.string().trim().min(1).max(60) })
    .safeParse({ projectId: form.get("projectId"), name: form.get("name") });
  if (!parsed.success) return { error: "Add a name for this key." };
  const access = await requireProject(String(form.get("org") ?? ""), parsed.data.projectId);
  assertOrganizationAdmin(access.role);
  const token = `pb_${randomToken()}`;
  await getDb().transaction(async (tx) => {
    const [key] = await tx
      .insert(apiKeys)
      .values({ ...parsed.data, prefix: token.slice(0, 11), tokenHash: hashToken(token) })
      .returning();
    await recordAudit(tx, {
      organizationId: access.organization.id,
      actor: access.actor,
      action: "ingest_key.created",
      targetType: "ingest_key",
      targetId: key.id,
      details: { name: key.name, projectId: key.projectId },
    });
  });
  revalidatePath(`/app/${access.organization.slug}/projects/${parsed.data.projectId}/settings`);
  return { secret: token, success: "Copy this key now. It won’t be shown again." };
}

export async function revokeKeyAction(form: FormData) {
  await assertSameOrigin();
  const id = z.uuid().parse(form.get("id"));
  const projectId = z.uuid().parse(form.get("projectId"));
  const access = await requireProject(String(form.get("org") ?? ""), projectId);
  assertOrganizationAdmin(access.role);
  await getDb().transaction(async (tx) => {
    const [key] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.projectId, projectId), isNull(apiKeys.revokedAt)))
      .returning();
    if (!key) notFound();
    await recordAudit(tx, {
      organizationId: access.organization.id,
      actor: access.actor,
      action: "ingest_key.revoked",
      targetType: "ingest_key",
      targetId: key.id,
      details: { name: key.name, projectId },
    });
  });
  revalidatePath(`/app/${access.organization.slug}/projects/${projectId}/settings`);
}
