import Link from "next/link";
import { requireUser } from "@/server/auth";
import { PublicShell } from "@/components/public-shell";
import { AccountForm, SignOut } from "@/components/account-forms";
import {
  ActiveSessions,
  ChangePasswordForm,
  DeleteAccountForm,
  TwoFactorSettings,
} from "@/components/account-security-forms";
export default async function AccountPage() {
  const actor = await requireUser();
  return (
    <PublicShell>
      <section className="mx-auto max-w-lg py-12 space-y-10">
        <Link href="/app" className="underline">
          Back to app
        </Link>
        <h1 className="text-3xl font-medium">Account</h1>
        <div>
          <h2 className="text-sm font-medium">Email</h2>
          <p>{actor.email}</p>
        </div>
        <AccountForm name={actor.name} />
        <ChangePasswordForm />
        <ActiveSessions />
        <TwoFactorSettings initiallyEnabled={Boolean(actor.twoFactorEnabled)} />
        <SignOut />
        <DeleteAccountForm />
      </section>
    </PublicShell>
  );
}
