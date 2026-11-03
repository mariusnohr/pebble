import { verifyAdmin } from "@/server/auth";
import { getProject, getRealtime } from "@/server/queries";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await verifyAdmin())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await getProject((await params).id);
  return Response.json(
    { visits: await getRealtime(project.id) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
