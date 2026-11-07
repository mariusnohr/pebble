import Link from "next/link";
import { requireUser } from "@/server/auth";
import { pendingInvitations } from "@/server/members";
import { PublicShell } from "@/components/public-shell";
import { RespondForm } from "./respond-form";
export default async function InvitationsPage() {
  const actor = await requireUser();
  const invitations = await pendingInvitations(actor.email);
  return (
    <PublicShell>
      <section className="mx-auto max-w-xl py-12 space-y-6">
        <h1 className="text-3xl font-medium">Your invitations</h1>
        {!invitations.length && <p>No pending invitations.</p>}
        {invitations.map((invite) => (
          <section key={invite.id} className="panel p-6 space-y-4">
            <h2 className="font-medium">{invite.organizationName}</h2>
            <p className="text-sm text-muted-foreground">
              Invited as {invite.role} · Expires {invite.expiresAt.toISOString().slice(0, 10)} (UTC)
            </p>
            <RespondForm id={invite.id} />
          </section>
        ))}
        <Link href="/app/new" className="block underline">
          Create an organization instead
        </Link>
        <Link href="/app" className="block underline">
          Back to app
        </Link>
      </section>
    </PublicShell>
  );
}
