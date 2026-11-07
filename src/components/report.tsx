import Link from "next/link";
import {
  ArrowUpRight,
  ArrowDownRight,
  Code2,
  MousePointer2,
  Users,
  Layers2,
  Zap,
} from "lucide-react";
import type { Breakdown, SeriesPoint, Totals } from "@/server/queries";

export function DateRange({ base, days }: { base: string; days: number }) {
  return (
    <div className="date-range" aria-label="Reporting range">
      {[
        [1, "Today"],
        [7, "7 days"],
        [30, "30 days"],
        [90, "90 days"],
      ].map(([value, label]) => (
        <Link
          key={value}
          href={`${base}?days=${value}`}
          aria-current={days === value ? "page" : undefined}
          className={days === value ? "selected" : ""}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}

export function Metrics({ current, prior }: { current: Totals; prior: Totals }) {
  return (
    <div className="metrics-grid">
      {(
        [
          ["Visitors", "visitors", Users],
          ["Visits", "visits", Layers2],
          ["Pageviews", "pageviews", MousePointer2],
          ["Events", "customEvents", Zap],
        ] as const
      ).map(([label, key, Icon]) => {
        const before = prior[key];
        const delta = before ? Math.round(((current[key] - before) / before) * 100) : null;
        return (
          <div className="metric" key={key}>
            <div className="metric-label">
              {label}
              <Icon size={15} />
            </div>
            <div className="metric-value">{current[key].toLocaleString()}</div>
            <div className="metric-change">
              {delta !== null ? (
                <span className={delta >= 0 ? "positive" : "negative"}>
                  {delta >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                  {Math.abs(delta)}%
                </span>
              ) : (
                <span>—</span>
              )}
              <span>vs. previous period</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TrafficChart({ series }: { series: SeriesPoint[] }) {
  const max = Math.max(4, ...series.map((p) => p.pageviews), ...series.map((p) => p.visitors));
  const x = (i: number) => 48 + (i / Math.max(1, series.length - 1)) * 900;
  const y = (n: number) => 190 - (n / max) * 160;
  const path = (key: "visitors" | "pageviews") =>
    series.map((point, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(point[key])}`).join(" ");
  const format = (date: string) =>
    new Date(`${date}T12:00:00Z`).toLocaleDateString("en", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return (
    <div className="panel chart-panel">
      <div className="panel-heading">
        <div>
          <h2>Traffic over time</h2>
          <p>The comings and goings of your website.</p>
        </div>
        <div className="chart-legend">
          <span>
            <i className="bg-primary" />
            Visitors
          </span>
          <span>
            <i className="bg-primary/30" />
            Pageviews
          </span>
        </div>
      </div>
      <svg
        viewBox="0 0 980 230"
        role="img"
        aria-label={`Daily traffic: ${series.map((p) => `${p.date}, ${p.visitors} visitors, ${p.pageviews} pageviews`).join("; ")}`}
        className="traffic-chart"
      >
        <defs>
          <linearGradient id="traffic-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity=".12" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line
              x1="48"
              x2="948"
              y1={y((max * i) / 4)}
              y2={y((max * i) / 4)}
              stroke="var(--border)"
              strokeDasharray="3 5"
            />
            <text
              x="28"
              y={y((max * i) / 4) + 4}
              fill="var(--muted-foreground)"
              fontSize="10"
              textAnchor="end"
            >
              {Math.round((max * i) / 4)}
            </text>
          </g>
        ))}
        <path
          d={`${path("visitors")} L${x(series.length - 1)},190 L48,190 Z`}
          fill="url(#traffic-fill)"
        />
        <path
          d={path("pageviews")}
          fill="none"
          stroke="var(--primary)"
          strokeOpacity=".3"
          strokeWidth="2"
        />
        <path
          d={path("visitors")}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {series.map((point, i) => (
          <g key={point.date}>
            <circle
              cx={x(i)}
              cy={y(point.visitors)}
              r={series.length === 1 ? 4 : 2.5}
              fill="var(--primary)"
            >
              <title>
                {format(point.date)}: {point.visitors} visitors · {point.pageviews} pageviews
              </title>
            </circle>
            {(i === 0 ||
              i === series.length - 1 ||
              i % Math.max(1, Math.floor(series.length / 6)) === 0) && (
              <text
                x={x(i)}
                y="219"
                textAnchor="middle"
                fill="var(--muted-foreground)"
                fontSize="10"
              >
                {format(point.date)}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

export function BreakdownCard({
  title,
  label,
  rows,
  unit = "Visits",
}: {
  title: string;
  label: string;
  rows: Breakdown[];
  unit?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="panel breakdown">
      <div className="panel-heading">
        <h2>{title}</h2>
        <span className="text-xs text-muted-foreground">Top {rows.length || "—"}</span>
      </div>
      <div className="breakdown-labels">
        <span>{label}</span>
        <span>{unit}</span>
      </div>
      <div className="breakdown-rows">
        {rows.length ? (
          rows.map((row) => (
            <div className="breakdown-row" key={row.label}>
              <span className="breakdown-bar" style={{ width: `${(row.count / max) * 82}%` }} />
              <span className="relative truncate pr-4" title={row.label}>
                {row.label}
              </span>
              <strong className="relative">{row.count.toLocaleString()}</strong>
            </div>
          ))
        ) : (
          <div className="breakdown-empty">
            A little quiet here. Data will appear as visitors arrive.
          </div>
        )}
      </div>
    </section>
  );
}

export function InstallationPrompt({ projectId, org }: { projectId: string; org: string }) {
  return (
    <div className="installation-prompt">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
        <Code2 size={19} />
      </span>
      <div>
        <h3>Ready when you are.</h3>
        <p>Connect a browser tracker or send your first server event.</p>
      </div>
      <Link
        href={`/app/${org}/projects/${projectId}/settings`}
        className="ml-auto flex shrink-0 items-center gap-2 text-xs font-medium text-primary"
      >
        Set up tracking
        <ArrowUpRight size={14} />
      </Link>
    </div>
  );
}
