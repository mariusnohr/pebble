import { requireOrganization } from "@/server/tenancy";
import { SettingsNavigation } from "./navigation";

export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { organization, role } = await requireOrganization((await params).org);
  return (
    <>
      <div className="mb-7">
        <h1 className="text-2xl font-semibold tracking-tight">Organization settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">{organization.name}</p>
      </div>
      <SettingsNavigation
        org={organization.slug}
        canManage={role === "owner" || role === "admin"}
      />
      {children}
    </>
  );
}
