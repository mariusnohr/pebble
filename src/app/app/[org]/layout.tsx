import { AppShell } from "@/components/shell";
import { organizationProjects, listOrganizations, rememberOrganization } from "@/server/tenancy";
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { organization, actor, role, projects } = await organizationProjects((await params).org);
  await rememberOrganization(actor.id, organization.id);
  return (
    <AppShell
      projects={projects}
      organization={organization}
      organizations={await listOrganizations(actor.id)}
      user={actor}
      canManage={role !== "member"}
    >
      {children}
    </AppShell>
  );
}
