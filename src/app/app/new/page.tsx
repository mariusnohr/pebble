import Link from "next/link";
import { requireUser } from "@/server/auth";
import { listOrganizations } from "@/server/tenancy";
import { PublicShell } from "@/components/public-shell";
import { OrganizationForm, SignOut } from "@/components/account-forms";
export default async function NewOrganizationPage() {
  const actor = await requireUser();
  const organizations = await listOrganizations(actor.id);
  return (
    <PublicShell>
      <section className="mx-auto max-w-sm py-12 space-y-6">
        <h1 className="text-3xl font-medium">Create an organization</h1>
        <p className="text-sm text-muted-foreground">
          A shared home for your projects. You can own up to five organizations.
        </p>
        <OrganizationForm />
        {organizations.map((org) => (
          <p key={org.id}>
            <Link className="underline" href={`/app/${org.slug}`} prefetch={false}>
              {org.name}
            </Link>
          </p>
        ))}
        <Link className="underline" href="/app/account">
          Account
        </Link>
        <SignOut />
      </section>
    </PublicShell>
  );
}
