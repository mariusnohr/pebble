import { getProject, getRealtime } from "@/server/queries";
import { Realtime } from "@/components/realtime";
export default async function RealtimePage({ params }: { params: Promise<{ id: string }> }) {
  const project = await getProject((await params).id);
  return <Realtime projectId={project.id} initial={await getRealtime(project.id)} />;
}
