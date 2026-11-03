"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { apiKeys, projects } from "@/db/schema";
import { normalizeOrigins, projectSchema } from "@/lib/contracts";
import { assertSameOrigin, createAdminSession, destroyAdminSession, requireAdmin } from "./auth";
import { hashToken, randomToken, verifyPassword } from "./crypto";
import { clientAddress, rateLimit } from "./rate-limit";

export type ActionState = { error?: string; success?: string; secret?: string; projectId?: string };

export async function loginAction(_: ActionState, form: FormData): Promise<ActionState> {
  await assertSameOrigin();
  const password = String(form.get("password") ?? "");
  if (!process.env.ADMIN_PASSWORD_HASH || !process.env.DATABASE_URL)
    return { error: "Finish the environment setup in the README before signing in." };
  if (!password || password.length > 1024) return { error: "Enter your admin password." };
  try {
    if (!(await rateLimit(`login:${clientAddress(await headers())}`, 10, 300)))
      return { error: "Too many attempts. Try again in five minutes." };
    if (!(await verifyPassword(password, process.env.ADMIN_PASSWORD_HASH)))
      return { error: "That password isn’t correct." };
    await createAdminSession();
  } catch {
    return { error: "Could not connect to the database. Check your connection and migrations." };
  }
  redirect("/");
}

export async function logoutAction() {
  await assertSameOrigin();
  await destroyAdminSession();
  redirect("/login");
}

export async function saveProjectAction(_: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  await assertSameOrigin();
  const parsed = projectSchema.safeParse(
    Object.fromEntries(
      ["name", "origins", "timezone", "retentionDays"].map((key) => [key, form.get(key)]),
    ),
  );
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  let origins: string[];
  try {
    origins = normalizeOrigins(parsed.data.origins);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid origins." };
  }
  const { name, timezone, retentionDays } = parsed.data;
  const id = form.get("id");
  if (id && !z.uuid().safeParse(id).success) return { error: "Invalid project." };
  const data = { name, origins, timezone, retentionDays, paused: form.get("paused") === "on" };
  const [project] = id
    ? await getDb()
        .update(projects)
        .set(data)
        .where(eq(projects.id, String(id)))
        .returning()
    : await getDb().insert(projects).values(data).returning();
  if (!project) return { error: "Project no longer exists." };
  revalidatePath("/", "layout");
  return { success: id ? "Project updated." : "Project created.", projectId: project.id };
}

export async function deleteProjectAction(_: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  await assertSameOrigin();
  const parsed = z.uuid().safeParse(form.get("id"));
  if (!parsed.success) return { error: "Invalid project." };
  const [project] = await getDb().select().from(projects).where(eq(projects.id, parsed.data));
  if (!project || form.get("confirmation") !== project.name)
    return { error: "Type the project name exactly to confirm deletion." };
  await getDb().delete(projects).where(eq(projects.id, project.id));
  revalidatePath("/", "layout");
  redirect("/");
}

export async function createKeyAction(_: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  await assertSameOrigin();
  const parsed = z
    .object({ projectId: z.uuid(), name: z.string().trim().min(1).max(60) })
    .safeParse({ projectId: form.get("projectId"), name: form.get("name") });
  if (!parsed.success) return { error: "Add a name for this key." };
  const token = `pb_${randomToken()}`;
  await getDb()
    .insert(apiKeys)
    .values({ ...parsed.data, prefix: token.slice(0, 11), tokenHash: hashToken(token) });
  revalidatePath(`/projects/${parsed.data.projectId}/settings`);
  return { secret: token, success: "Copy this key now. It won’t be shown again." };
}

export async function revokeKeyAction(form: FormData) {
  await requireAdmin();
  await assertSameOrigin();
  const id = z.uuid().parse(form.get("id"));
  const projectId = z.uuid().parse(form.get("projectId"));
  await getDb()
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.projectId, projectId)));
  revalidatePath(`/projects/${projectId}/settings`);
}
