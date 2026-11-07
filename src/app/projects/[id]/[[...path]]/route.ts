import { requireProjectById } from "@/server/tenancy";
import { appOrigin } from "@/server/config";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; path?: string[] }> },
) {
  const { id, path = [] } = await params;
  const { organization } = await requireProjectById(id);
  const suffix = path.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const target = new URL(`/app/${organization.slug}/projects/${id}${suffix}`, appOrigin());
  target.search = new URL(request.url).search;
  return Response.redirect(target, 307);
}
