import { requireOrganization } from "@/server/tenancy";
import Link from "next/link";
import { ArrowUpRight, Globe2, Sprout, Activity, Users, MousePointer2 } from "lucide-react";
import { listProjects, getPortfolio } from "@/server/queries";
import { ProjectDialog } from "@/components/project-form";
import { PebbleMark } from "@/components/brand";

export default async function Home({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const { role } = await requireOrganization(org);
  const [projects, stats] = await Promise.all([listProjects(org), getPortfolio(org)]);
  const total = stats.reduce(
    (a, b) => ({
      visitors: a.visitors + b.visitors,
      pageviews: a.pageviews + b.pageviews,
      online: a.online + b.online,
    }),
    { visitors: 0, pageviews: 0, online: 0 },
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow mb-3">YOUR CORNER OF THE INTERNET</p>
          <h1>Your websites, at a glance.</h1>
          <p>A little perspective on everything you’re building.</p>
        </div>
        {role !== "member" && <ProjectDialog org={org} />}
      </div>
      <div className="portfolio-stats">
        <div>
          <span>
            <Globe2 size={15} />
            Projects
          </span>
          <strong>{projects.length.toLocaleString()}</strong>
          <small>All your websites</small>
        </div>
        <div>
          <span>
            <Users size={15} />
            Visitors
          </span>
          <strong>{total.visitors.toLocaleString()}</strong>
          <small>Across projects · last 7 days</small>
        </div>
        <div>
          <span>
            <MousePointer2 size={15} />
            Pageviews
          </span>
          <strong>{total.pageviews.toLocaleString()}</strong>
          <small>Last 7 days</small>
        </div>
        <div>
          <span>
            <Activity size={15} />
            Online now
          </span>
          <strong className="flex items-center gap-3">
            {total.online}
            <i className="live-dot" />
          </strong>
          <small>Active in the last minute</small>
        </div>
      </div>
      <div className="section-label">
        <h2>
          Your projects <span>{projects.length}</span>
        </h2>
        <span>Last 7 days</span>
      </div>
      {projects.length ? (
        <div className="project-grid">
          {projects.map((project, i) => {
            const stat = stats.find((s) => s.id === project.id)!;
            return (
              <Link
                href={`/app/${org}/projects/${project.id}`}
                className="project-card group"
                key={project.id}
              >
                <div className="flex items-center justify-between">
                  <span className={`project-avatar avatar-${i % 4}`}>
                    {project.name.slice(0, 1).toUpperCase()}
                  </span>
                  <ArrowUpRight
                    size={17}
                    className="text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                  />
                </div>
                <h3>{project.name}</h3>
                <p className="truncate">{new URL(project.origins[0]).host}</p>
                <div className="project-card-numbers">
                  <div>
                    <strong>{stat.visitors.toLocaleString()}</strong>
                    <span>visitors</span>
                  </div>
                  <div>
                    <strong>{stat.pageviews.toLocaleString()}</strong>
                    <span>pageviews</span>
                  </div>
                </div>
                <div className="project-card-footer">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`size-1.5 rounded-full ${project.paused ? "bg-amber-500" : stat.lastEvent ? "bg-primary" : "bg-muted-foreground/50"}`}
                    />
                    {project.paused
                      ? "Paused"
                      : stat.lastEvent
                        ? "Receiving events"
                        : "Waiting for first event"}
                  </span>
                  <span>{stat.online} online</span>
                </div>
              </Link>
            );
          })}
          <div className="add-project-card">
            <span className="mb-4 flex size-10 items-center justify-center rounded-full bg-muted">
              <Sprout size={19} className="text-primary" />
            </span>
            <h3>Room for your next idea.</h3>
            <p>Add another website to your workspace.</p>
            {role !== "member" && <ProjectDialog org={org} />}
          </div>
        </div>
      ) : (
        <div className="empty-workspace">
          <PebbleMark className="mb-6 size-16 text-primary" />
          <h2>Every little thing starts somewhere.</h2>
          <p>
            Add your first website, install the tracker,
            <br />
            and watch the picture come together.
          </p>
          {role !== "member" && <ProjectDialog org={org} />}
          <div className="empty-steps">
            <span>
              01 <b>Add a website</b>
            </span>
            <span>
              02 <b>Connect your tracker</b>
            </span>
            <span>
              03 <b>Find your insights</b>
            </span>
          </div>
        </div>
      )}
      <div className="workspace-footnote">
        <span className="flex items-center gap-2">
          <Sprout size={14} />
          Built for a little less noise.
        </span>
        <span>Visitor totals are counted separately for each project.</span>
      </div>
    </>
  );
}
