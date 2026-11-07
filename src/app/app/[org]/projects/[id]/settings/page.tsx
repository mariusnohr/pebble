import { requireOrganization } from "@/server/tenancy";
import { getFirstEvent, getProject, listKeys } from "@/server/queries";
import { appOrigin } from "@/server/auth";
import { DeleteProject, ProjectForm } from "@/components/project-form";
import { ApiKeys, Installation } from "@/components/installation";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ org: string; id: string }>;
}) {
  const { org, id } = await params;
  const project = await getProject(org, id);
  const { role } = await requireOrganization(org);
  const keys = await listKeys(org, project.id);
  const firstEventAt = await getFirstEvent(org, project.id);
  return (
    <>
      <div className="report-toolbar">
        <div>
          <h2>A few small details.</h2>
          <span>Connect your website and make Pebble your own.</span>
        </div>
      </div>
      <div className="max-w-4xl space-y-6">
        <Installation
          key={project.id}
          projectId={project.id}
          endpoint={appOrigin()}
          org={org}
          firstEventAt={firstEventAt}
          timezone={project.timezone}
          readOnly={role === "member"}
        />
        <ApiKeys readOnly={role === "member"} org={org} projectId={project.id} keys={keys} />
        <section className="panel settings-panel">
          <div className="panel-heading">
            <h2>Project details</h2>
          </div>
          <div className="px-6 pb-6">
            <ProjectForm readOnly={role === "member"} org={org} project={project} />
            <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
              Reducing retention takes effect on the next cleanup run and permanently removes older
              history.
            </p>
          </div>
        </section>
        {role !== "member" && (
          <section className="panel p-6">
            <h2 className="mb-2 text-sm font-medium">Danger zone</h2>
            <p className="mb-5 text-xs leading-relaxed text-muted-foreground">
              Permanently remove this website and all its analytics. This can’t be undone.
            </p>
            <DeleteProject org={org} project={project} />
          </section>
        )}
      </div>
    </>
  );
}
