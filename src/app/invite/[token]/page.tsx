import Link from "next/link";
import { currentUser } from "@/server/auth";
import { getInvitation, invitationUnavailable } from "@/server/members";
import { PublicShell } from "@/components/public-shell";
import { SignOut } from "@/components/account-forms";
import { RespondForm } from "@/app/app/invitations/respond-form";
export const dynamic = "force-dynamic";
export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const row = await getInvitation(token);
  const unavailable = invitationUnavailable(row?.invitation ?? null);
  const actor = await currentUser();
  const matches = actor && row && actor.email.toLowerCase() === row.invitation.email.toLowerCase();
  return (
    <PublicShell>
      <section className="mx-auto max-w-lg py-12 space-y-6">
        <h1 className="text-3xl font-medium">{unavailable ?? `Join ${row!.organizationName}`}</h1>
        {!unavailable && row && (
          <>
            <p>
              This invitation is for <strong>{row.invitation.email}</strong>, as{" "}
              {row.invitation.role}.
            </p>
            {matches ? (
              <RespondForm id={token} />
            ) : (
              <>
                <p>Sign in with this address and verify your email to accept or decline.</p>
                <div className="flex gap-4">
                  <Link className="underline" href="/login">
                    Sign in
                  </Link>
                  <Link className="underline" href="/signup">
                    Sign up
                  </Link>
                </div>
                {actor && <SignOut />}
              </>
            )}
          </>
        )}
      </section>
    </PublicShell>
  );
}
