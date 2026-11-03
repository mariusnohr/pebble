import { AppShell } from "@/components/shell";
import { listProjects } from "@/server/queries";
export const dynamic = "force-dynamic";
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const projects = await listProjects();
  return <AppShell projects={projects}>{children}</AppShell>;
}
