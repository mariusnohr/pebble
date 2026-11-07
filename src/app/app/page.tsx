import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { listOrganizations, rememberOrganization } from "@/server/tenancy";
export default async function AppPage() {
  const actor = await requireUser();
  const organizations = await listOrganizations(actor.id);
  const last = organizations.find((org) => org.id === actor.lastOrganizationId) ?? organizations[0];
  if ((last?.id ?? null) !== actor.lastOrganizationId)
    await rememberOrganization(actor.id, last?.id ?? null);
  redirect(last ? `/app/${last.slug}` : "/app/new");
}
