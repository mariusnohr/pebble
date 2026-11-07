import { requireProjectById } from "@/server/tenancy";
import { getRealtime } from "@/server/queries";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { project, organization } = await requireProjectById((await params).id);
  return Response.json(
    { visits: await getRealtime(organization.slug, project.id) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
