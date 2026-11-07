import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import { account, invitation, member, organization, user } from "@/db/schema";
import type { Transaction } from "./organizations";
import { recordAudit } from "./audit";
import { queueEmail } from "./email/queue";
import { accountRateLimit } from "./rate-limit";
import { resolveOrganization } from "./tenancy";
import { invitationUnavailable } from "@/lib/invitations";
export { invitationUnavailable } from "@/lib/invitations";

type Actor = { id: string; name: string; email: string; emailVerified: boolean };
export class MembershipError extends Error {}
const normalizedEmail = (email: string) => email.trim().toLowerCase();
const pending = (now = new Date()) =>
  and(eq(invitation.status, "pending"), gt(invitation.expiresAt, now));
function invitedRole(value: unknown) {
  const parsed = z.enum(["admin", "member"]).safeParse(value);
  if (!parsed.success) throw new MembershipError("Choose admin or member.");
  return parsed.data;
}
function requireAdmin(role: string) {
  if (role !== "owner" && role !== "admin")
    throw new MembershipError("Only owners and admins can manage members and invitations.");
}

// Serialize organization membership changes, then read permissions again after the lock.
// Using a separate query avoids relying on an old joined member snapshot after a lock wait.
async function lockAccess(tx: Transaction, slug: string, actor: Actor) {
  if (!actor.emailVerified) notFound();
  // Lock the actor before the organization, matching account deletion. KEY SHARE
  // protects audit/inviter foreign keys without blocking last-used updates.
  const [verified] = await tx
    .select({ emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, actor.id))
    .for("key share");
  if (!verified?.emailVerified) notFound();
  const [org] = await tx
    .select()
    .from(organization)
    .where(eq(organization.slug, slug))
    .for("update");
  if (!org) notFound();
  const [membership] = await tx
    .select()
    .from(member)
    .where(and(eq(member.organizationId, org.id), eq(member.userId, actor.id)));
  if (!membership) notFound();
  if (org.suspendedAt)
    throw new MembershipError("This organization is suspended. Contact support.");
  return { org, membership };
}

export async function listMembers(slug: string, actor: Actor) {
  const access = await resolveOrganization(slug, actor);
  const members = await getDb()
    .select({
      id: member.id,
      userId: member.userId,
      role: member.role,
      joined: member.createdAt,
      name: user.name,
      email: user.email,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, access.organization.id))
    .orderBy(member.createdAt);
  const invitations = await getDb()
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(and(eq(invitation.organizationId, access.organization.id), pending()))
    .orderBy(invitation.createdAt);
  return { ...access, members, invitations };
}

export async function pendingInvitations(email: string) {
  return getDb()
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      organizationName: organization.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(and(sql`lower(${invitation.email}) = ${normalizedEmail(email)}`, pending()))
    .orderBy(invitation.createdAt);
}

export async function getInvitation(token: string) {
  if (!z.uuid().safeParse(token).success) return null;
  const [row] = await getDb()
    .select({ invitation, organizationName: organization.name })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(eq(invitation.id, token));
  return row ?? null;
}

async function sendInvitation(
  tx: Transaction,
  invite: typeof invitation.$inferSelect,
  org: typeof organization.$inferSelect,
) {
  // Better Auth's random invitation ID is the token, not a token hash. Possession
  // alone never grants membership: acceptance also needs the matching verified email.
  await queueEmail(tx, {
    to: invite.email,
    template: "invitation",
    data: {
      subject: `Join ${org.name} on Pebble`,
      heading: "You're invited",
      organizationName: org.name,
      paragraphs: [
        `You have been invited as ${invite.role}. This invitation expires on ${invite.expiresAt.toISOString()}. Sign in with ${invite.email} to accept or decline.`,
      ],
      links: [{ label: "View invitation", path: `/invite/${invite.id}` }],
    },
  });
}

export async function inviteMember(actor: Actor, slug: string, email: unknown, role: unknown) {
  const parsed = z.email().safeParse(typeof email === "string" ? normalizedEmail(email) : email);
  if (!parsed.success) throw new MembershipError("Enter a valid email address.");
  const nextRole = invitedRole(role);
  return getDb().transaction(async (tx) => {
    const { org, membership } = await lockAccess(tx, slug, actor);
    requireAdmin(membership.role);
    const [existing] = await tx
      .select({ id: member.id })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(and(eq(member.organizationId, org.id), sql`lower(${user.email}) = ${parsed.data}`));
    if (existing)
      throw new MembershipError("This address is already a member of the organization.");
    const [duplicate] = await tx
      .select({ id: invitation.id })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, org.id),
          sql`lower(${invitation.email}) = ${parsed.data}`,
          pending(),
        ),
      );
    if (duplicate) throw new MembershipError("This address already has a pending invitation.");
    const [created] = await tx
      .insert(invitation)
      .values({
        organizationId: org.id,
        email: parsed.data,
        role: nextRole,
        inviterId: actor.id,
        expiresAt: new Date(Date.now() + 7 * 86400000),
      })
      .returning();
    await sendInvitation(tx, created, org);
    await recordAudit(tx, {
      organizationId: org.id,
      actor,
      action: "member.invited",
      targetType: "invitation",
      targetId: created.id,
      details: { email: created.email, role: nextRole },
    });
    return created;
  });
}

export async function manageInvitation(
  actor: Actor,
  slug: string,
  id: string,
  operation: "resend" | "revoke",
) {
  if (!z.uuid().safeParse(id).success) throw new MembershipError("Invalid invitation.");
  return getDb().transaction(async (tx) => {
    const { org, membership } = await lockAccess(tx, slug, actor);
    requireAdmin(membership.role);
    const [invite] = await tx
      .select()
      .from(invitation)
      .where(and(eq(invitation.id, id), eq(invitation.organizationId, org.id)))
      .for("update");
    const error = invitationUnavailable(invite ?? null);
    if (error) throw new MembershipError(error);
    if (operation === "revoke") {
      await tx.update(invitation).set({ status: "revoked" }).where(eq(invitation.id, id));
    } else {
      const now = new Date();
      const count =
        invite.resendAt?.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)
          ? invite.resendCount
          : 0;
      if (count >= 3)
        throw new MembershipError(
          "This invitation has already been resent 3 times today. Try again tomorrow (UTC).",
        );
      await tx
        .update(invitation)
        .set({ resendCount: count + 1, resendAt: now })
        .where(eq(invitation.id, id));
      await sendInvitation(tx, invite, org);
    }
    await recordAudit(tx, {
      organizationId: org.id,
      actor,
      action: operation === "revoke" ? "invitation.revoked" : "invitation.resent",
      targetType: "invitation",
      targetId: id,
      details: { email: invite.email },
    });
  });
}

export async function respondToInvitation(actor: Actor, id: string, accept: boolean) {
  if (!z.uuid().safeParse(id).success) throw new MembershipError("Invalid invitation.");
  return getDb().transaction(async (tx) => {
    // Same user-before-organization order as account deletion. Locking the user
    // also serializes acceptance in different organizations and last-used updates.
    const [verified] = await tx
      .select()
      .from(user)
      .where(eq(user.id, actor.id))
      .for("no key update");
    if (!verified?.emailVerified)
      throw new MembershipError("Verify your email before responding to this invitation.");
    const [candidate] = await tx.select().from(invitation).where(eq(invitation.id, id));
    if (!candidate) throw new MembershipError(invitationUnavailable(null)!);
    const [org] = await tx
      .select()
      .from(organization)
      .where(eq(organization.id, candidate.organizationId))
      .for("update");
    if (!org) throw new MembershipError(invitationUnavailable(null)!);
    const [invite] = await tx.select().from(invitation).where(eq(invitation.id, id)).for("update");
    const error = invitationUnavailable(invite ?? null);
    if (error) throw new MembershipError(error);
    if (normalizedEmail(invite.email) !== normalizedEmail(verified.email))
      throw new MembershipError(
        `Sign in with the verified address ${invite.email} to respond to this invitation.`,
      );
    if (org.suspendedAt)
      throw new MembershipError("This organization is suspended. Contact support.");
    if (accept) {
      const role = invitedRole(invite.role);
      const [existing] = await tx
        .select()
        .from(member)
        .where(and(eq(member.organizationId, org.id), eq(member.userId, actor.id)));
      if (existing) throw new MembershipError("You are already a member of this organization.");
      const [joined] = await tx
        .insert(member)
        .values({ organizationId: org.id, userId: actor.id, role, createdAt: new Date() })
        .returning();
      await tx.update(user).set({ lastOrganizationId: org.id }).where(eq(user.id, actor.id));
      await recordAudit(tx, {
        organizationId: org.id,
        actor,
        action: "member.joined",
        targetType: "member",
        targetId: joined.id,
        details: { invitationId: id, role },
      });
    } else {
      await recordAudit(tx, {
        organizationId: org.id,
        actor,
        action: "invitation.declined",
        targetType: "invitation",
        targetId: id,
      });
    }
    await tx
      .update(invitation)
      .set({ status: accept ? "accepted" : "rejected", acceptedAt: accept ? new Date() : null })
      .where(eq(invitation.id, id));
    return org.slug;
  });
}

export async function changeMembership(
  actor: Actor,
  slug: string,
  id: string,
  operation: "role" | "remove" | "leave",
  role?: unknown,
) {
  if (!z.uuid().safeParse(id).success) throw new MembershipError("Invalid member.");
  return getDb().transaction(async (tx) => {
    const { org, membership } = await lockAccess(tx, slug, actor);
    if (operation !== "leave") requireAdmin(membership.role);
    const [target] = await tx
      .select()
      .from(member)
      .where(and(eq(member.id, id), eq(member.organizationId, org.id)));
    if (!target) throw new MembershipError("This person is no longer a member.");
    if (target.role === "owner")
      throw new MembershipError(
        "The owner cannot be changed or removed. Transfer ownership first.",
      );
    if (operation === "leave" && target.userId !== actor.id)
      throw new MembershipError("You can only leave for yourself.");
    if (operation === "role") {
      const nextRole = invitedRole(role);
      if (target.role === nextRole) return;
      await tx.update(member).set({ role: nextRole }).where(eq(member.id, target.id));
      await recordAudit(tx, {
        organizationId: org.id,
        actor,
        action: "member.role_changed",
        targetType: "member",
        targetId: target.id,
        details: { userId: target.userId, from: target.role, to: nextRole },
      });
    } else {
      await tx.delete(member).where(eq(member.id, target.id));
      // Every organization request resolves current membership; sessions are not authorization caches.
      await recordAudit(tx, {
        organizationId: org.id,
        actor,
        action: operation === "leave" ? "member.left" : "member.removed",
        targetType: "member",
        targetId: target.id,
        details: { userId: target.userId, role: target.role },
      });
    }
    return { departed: operation !== "role" && target.userId === actor.id };
  });
}

export async function transferOwnership(
  actor: Actor,
  slug: string,
  adminId: string,
  password: unknown,
) {
  if (!z.uuid().safeParse(adminId).success) throw new MembershipError("Choose an existing admin.");
  if (!z.string().min(1).max(128).safeParse(password).success)
    throw new MembershipError("Enter your password.");
  const access = await resolveOrganization(slug, actor);
  if (access.role !== "owner") throw new MembershipError("Only the owner can transfer ownership.");
  if (!(await accountRateLimit(`ownership:${actor.id}`, 10, 300)))
    throw new MembershipError("Too many attempts. Try again in a few minutes.");
  return getDb().transaction(async (tx) => {
    // Match creation/settings's advisory lock and account deletion's user-before-org order.
    await tx.execute(sql`select pg_advisory_xact_lock(71001)`);
    await tx.select({ id: user.id }).from(user).where(eq(user.id, actor.id)).for("no key update");
    const { org, membership } = await lockAccess(tx, slug, actor);
    if (membership.role !== "owner")
      throw new MembershipError("Only the owner can transfer ownership.");
    const [credential] = await tx
      .select({ password: account.password })
      .from(account)
      .where(and(eq(account.userId, actor.id), eq(account.providerId, "credential")));
    if (
      !credential?.password ||
      !(await verifyPassword({ hash: credential.password, password: password as string }))
    )
      throw new MembershipError("Password is incorrect.");
    const [admin] = await tx
      .select({ member, email: user.email, name: user.name })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(
        and(eq(member.id, adminId), eq(member.organizationId, org.id), eq(member.role, "admin")),
      );
    if (!admin) throw new MembershipError("Choose an existing admin.");
    const owned = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.userId, admin.member.userId), eq(member.role, "owner")));
    if (owned.length >= 5) throw new MembershipError("This admin already owns 5 organizations.");
    await tx.update(member).set({ role: "admin" }).where(eq(member.id, membership.id));
    await tx.update(member).set({ role: "owner" }).where(eq(member.id, admin.member.id));
    await recordAudit(tx, {
      organizationId: org.id,
      actor,
      action: "ownership.transferred",
      targetType: "organization",
      targetId: org.id,
      details: { from: actor.id, to: admin.member.userId },
    });
    for (const to of [actor.email, admin.email])
      await queueEmail(tx, {
        to,
        template: "ownershipTransferred",
        data: {
          subject: `Ownership of ${org.name} was transferred`,
          heading: "Ownership transferred",
          organizationName: org.name,
          paragraphs: [
            `${admin.name} (${admin.email}) is now the owner. ${actor.name} (${actor.email}) is now an admin.`,
          ],
          links: [{ label: "Organization settings", path: `/app/${org.slug}/settings` }],
        },
      });
  });
}
