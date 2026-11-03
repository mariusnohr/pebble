import { Zap } from "lucide-react";
import { getProject, getReport } from "@/server/queries";
import { DateRange } from "@/components/report";
export default async function EventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const project = await getProject((await params).id);
  const report = await getReport(project, Number((await searchParams).days ?? 7));
  return (
    <>
      <div className="report-toolbar">
        <div>
          <h2>The moments that matter.</h2>
          <span>Browser interactions and server outcomes, together.</span>
        </div>
        <DateRange base={`/projects/${project.id}/events`} days={report.days} />
      </div>
      <div className="panel">
        <div className="panel-heading">
          <h2>Custom events</h2>
          <span className="text-xs text-muted-foreground">
            {report.current.customEvents.toLocaleString()} total events
          </span>
        </div>
        {report.events.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Occurrences</th>
                  <th>Visitors</th>
                  <th>Browser</th>
                  <th>Server</th>
                </tr>
              </thead>
              <tbody>
                {report.events.map((event) => (
                  <tr key={event.name}>
                    <td>
                      <span className="inline-flex items-center gap-2.5 font-mono text-xs">
                        <Zap size={13} className="text-primary" />
                        {event.name}
                      </span>
                    </td>
                    <td>{event.count.toLocaleString()}</td>
                    <td>{event.visitors.toLocaleString()}</td>
                    <td>{event.browser.toLocaleString()}</td>
                    <td>{event.server.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-20 text-center">
            <Zap size={24} className="mx-auto mb-4 text-primary/70" />
            <p className="text-sm font-medium">Give your important moments a name.</p>
            <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
              Track a button click, a completed form, or a successful payment. Your events will
              appear here automatically.
            </p>
            <code className="mt-6 inline-block rounded-lg bg-muted px-4 py-3 text-xs">
              pebble.track(&quot;newsletter_signup&quot;)
            </code>
          </div>
        )}
      </div>
      {report.properties.length > 0 && (
        <div className="panel mt-6">
          <div className="panel-heading">
            <h2>Event properties</h2>
            <span className="text-xs text-muted-foreground">Top 50 combinations</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Property</th>
                  <th>Value</th>
                  <th>Occurrences</th>
                </tr>
              </thead>
              <tbody>
                {report.properties.map((p, i) => (
                  <tr key={i}>
                    <td className="font-mono text-xs">{p.name}</td>
                    <td>{p.key}</td>
                    <td>{p.value ?? "null"}</td>
                    <td>{p.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
