import { listMembers } from "@/server/members";
import { TransferForm } from "./members/forms";
import { requireOrganizationSettings } from "@/server/tenancy";
import { GeneralForm, DeleteOrganization } from "./forms";

export default async function GeneralSettingsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { organization, role, actor } = await requireOrganizationSettings((await params).org);
  const admins =
    role === "owner"
      ? (await listMembers(organization.slug, actor)).members.filter(
          (person) => person.role === "admin",
        )
      : [];
  return (
    <div className="max-w-2xl space-y-6">
      <section className="panel settings-panel">
        <div className="panel-heading">
          <h2>General</h2>
        </div>
        <div className="px-6 pb-6">
          <GeneralForm organization={organization} />
        </div>
      </section>
      {role === "owner" && (
        <section className="panel p-6">
          <h2 className="mb-5 text-sm font-medium">Transfer ownership</h2>
          <TransferForm org={organization.slug} admins={admins} />
        </section>
      )}
      {role === "owner" && (
        <section className="panel p-6">
          <h2 className="mb-2 text-sm font-medium">Danger zone</h2>
          <p className="mb-5 text-xs leading-relaxed text-muted-foreground">
            Deleting this organization permanently removes all its projects, analytics, ingest keys,
            memberships, invitations, usage and audit history. This can’t be undone.
          </p>
          <DeleteOrganization key={organization.name} organization={organization} />
        </section>
      )}
    </div>
  );
}
