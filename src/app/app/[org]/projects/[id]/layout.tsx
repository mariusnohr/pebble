import { getProject } from "@/server/queries";
import { ProjectNavigation } from "@/components/shell";
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string; id: string }>;
}) {
  const { org, id } = await params;
  const project = await getProject(org, id);
  return (
    <>
      <ProjectNavigation org={org} project={project} />
      {children}
    </>
  );
}
