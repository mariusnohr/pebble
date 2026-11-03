import { getProject, getRealtime, getReport } from "@/server/queries";
import {
  BreakdownCard,
  DateRange,
  InstallationPrompt,
  Metrics,
  TrafficChart,
} from "@/components/report";
import { Realtime } from "@/components/realtime";

export default async function Overview({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const project = await getProject((await params).id);
  const [report, live] = await Promise.all([
    getReport(project, Number((await searchParams).days ?? 7)),
    getRealtime(project.id),
  ]);
  return (
    <>
      <div className="report-toolbar">
        <div>
          <h2>Overview</h2>
          <span>
            {project.timezone.replaceAll("_", " ")} · {project.retentionDays} days of history
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Realtime compact projectId={project.id} initial={live} />
          <DateRange base={`/projects/${project.id}`} days={report.days} />
        </div>
      </div>
      {report.current.pageviews + report.current.customEvents === 0 && (
        <InstallationPrompt projectId={project.id} />
      )}
      <Metrics current={report.current} prior={report.prior} />
      <TrafficChart series={report.series} />
      <div className="breakdown-grid">
        <BreakdownCard title="Top pages" label="Page" rows={report.pages} unit="Pageviews" />
        <BreakdownCard title="Where they came from" label="Referrer" rows={report.referrers} />
        <BreakdownCard title="Devices" label="Device" rows={report.devices} />
        <BreakdownCard title="Browsers" label="Browser" rows={report.browsers} />
        <BreakdownCard title="Entry pages" label="Page" rows={report.entryPages} />
        <BreakdownCard title="Campaign sources" label="UTM source" rows={report.campaigns} />
        <BreakdownCard title="Operating systems" label="System" rows={report.operatingSystems} />
        <BreakdownCard title="Languages" label="Language" rows={report.languages} />
      </div>
    </>
  );
}
