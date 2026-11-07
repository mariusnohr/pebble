import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { listOrganizations } from "@/server/tenancy";
export default async function AppPage() {
  const actor = await requireUser();
  const organizations = await listOrganizations(actor.id);
  const last = organizations.find((org) => org.id === actor.lastOrganizationId);
  redirect(last ? `/app/${last.slug}` : "/app/new");
}
