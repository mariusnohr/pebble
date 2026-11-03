import { getProject } from "@/server/queries";
import { ProjectNavigation } from "@/components/shell";
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const project = await getProject((await params).id);
  return (
    <>
      <ProjectNavigation project={project} />
      {children}
    </>
  );
}
