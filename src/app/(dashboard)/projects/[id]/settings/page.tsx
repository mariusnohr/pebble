import { getProject, listKeys } from "@/server/queries";
import { appOrigin } from "@/server/auth";
import { DeleteProject, ProjectForm } from "@/components/project-form";
import { ApiKeys, Installation } from "@/components/installation";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const project = await getProject((await params).id);
  const keys = await listKeys(project.id);
  return (
    <>
      <div className="report-toolbar">
        <div>
          <h2>A few small details.</h2>
          <span>Connect your website and make Pebble your own.</span>
        </div>
      </div>
      <div className="settings-grid">
        <div className="space-y-6">
          <Installation projectId={project.id} endpoint={appOrigin()} />
          <ApiKeys projectId={project.id} keys={keys} />
        </div>
        <div className="space-y-6">
          <section className="panel settings-panel">
            <div className="panel-heading">
              <h2>Project details</h2>
            </div>
            <div className="px-6 pb-6">
              <ProjectForm project={project} />
              <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
                Reducing retention takes effect on the next cleanup run and permanently removes
                older history.
              </p>
            </div>
          </section>
          <section className="panel p-6">
            <h2 className="mb-2 text-sm font-medium">Delete this project</h2>
            <p className="mb-5 text-xs leading-relaxed text-muted-foreground">
              Permanently remove this website and all its analytics. This can’t be undone.
            </p>
            <DeleteProject project={project} />
          </section>
        </div>
      </div>
    </>
  );
}
