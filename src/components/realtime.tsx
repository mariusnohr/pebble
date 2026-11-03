"use client";
import { useEffect, useState } from "react";
import { Monitor, Radio, Smartphone } from "lucide-react";
import type { LiveVisit } from "@/server/queries";

export function Realtime({
  projectId,
  initial,
  compact = false,
}: {
  projectId: string;
  initial: LiveVisit[];
  compact?: boolean;
}) {
  const [visits, setVisits] = useState(initial);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || running) return;
      running = true;
      try {
        const response = await fetch(`/api/projects/${projectId}/realtime`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error();
        const data = await response.json();
        setVisits(data.visits);
        setFailed(false);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(refresh, 10000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      controller.abort();
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [projectId]);
  if (compact)
    return (
      <span
        className="live-chip"
        title={
          failed
            ? "Could not refresh. Showing last known count."
            : "Visible pages active in the last 60 seconds"
        }
      >
        <span className={failed ? "size-1.5 rounded-full bg-amber-500" : "live-dot"} />
        {visits.length} online{failed && " · stale"}
      </span>
    );
  return (
    <>
      <div className="realtime-hero">
        <div className="realtime-orbit">
          <Radio size={27} />
        </div>
        <p className="eyebrow mt-6">RIGHT HERE, RIGHT NOW</p>
        <div className="realtime-count">{visits.length}</div>
        <h2>{visits.length === 1 ? "visitor is" : "visitors are"} on your website</h2>
        <p>
          {failed
            ? "Connection interrupted. Showing the last known activity."
            : "Visible pages active in the last minute. Refreshes every 10 seconds."}
        </p>
      </div>
      <div className="panel">
        <div className="panel-heading">
          <h2>Active visitors</h2>
          <span className="live-chip">
            <span className="live-dot" />
            Live activity
          </span>
        </div>
        {visits.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Current page</th>
                  <th>Device</th>
                  <th>Browser</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visits.map((visit) => (
                  <tr key={visit.visitorId}>
                    <td className="font-mono text-xs">{visit.path}</td>
                    <td>
                      <span className="inline-flex items-center gap-2">
                        {visit.device === "Mobile" ? (
                          <Smartphone size={14} />
                        ) : (
                          <Monitor size={14} />
                        )}
                        {visit.device}
                      </span>
                    </td>
                    <td>{visit.browser}</td>
                    <td>
                      <span className="text-primary">Active</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-16 text-center">
            <p className="text-sm font-medium">A quiet moment.</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Visitors will appear here while they browse your website.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
