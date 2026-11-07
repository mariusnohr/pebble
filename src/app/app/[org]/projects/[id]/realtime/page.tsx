import { getProject, getRealtime } from "@/server/queries";
import { Realtime } from "@/components/realtime";
export default async function RealtimePage({
  params,
}: {
  params: Promise<{ org: string; id: string }>;
}) {
  const { org, id } = await params;
  const project = await getProject(org, id);
  return <Realtime projectId={project.id} initial={await getRealtime(org, project.id)} />;
}
