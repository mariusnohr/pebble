import "server-only";
import { asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, events, type Project } from "@/db/schema";
import { requireOrganization, requireProject, organizationProjects } from "./tenancy";
import { LEGACY_ORGANIZATION_ID } from "./legacy-organization";

export async function listProjects(slug: string) {
  return (await organizationProjects(slug)).projects;
}
export async function getProject(slug: string, id: string) {
  return (await requireProject(slug, id)).project;
}
export async function getFirstEvent(slug: string, projectId: string) {
  await requireProject(slug, projectId);
  const [event] = await getDb()
    .select({ receivedAt: events.receivedAt })
    .from(events)
    .where(eq(events.projectId, projectId))
    .orderBy(asc(events.receivedAt))
    .limit(1);
  return event?.receivedAt.toISOString() ?? null;
}
export async function listKeys(slug: string, projectId: string) {
  await requireProject(slug, projectId);
  return getDb()
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.projectId, projectId))
    .orderBy(desc(apiKeys.createdAt));
}

export type Totals = { visitors: number; visits: number; pageviews: number; customEvents: number };
export type Breakdown = { label: string; count: number };
export type SeriesPoint = { date: string; visitors: number; pageviews: number };
export type EventRow = {
  name: string;
  count: number;
  visitors: number;
  browser: number;
  server: number;
};
export type LiveVisit = {
  visitorId: string;
  path: string;
  device: string;
  browser: string;
  lastSeen: string;
};

// These internal query helpers are called only after authorization in the exported entry points.
async function totals(projectId: string, start: Date, end: Date): Promise<Totals> {
  const result = await getDb().execute(sql`
    select count(distinct visitor_id)::int as visitors, count(distinct visit_id)::int as visits,
      count(*) filter (where type = 'pageview')::int as pageviews,
      count(*) filter (where type = 'event')::int as "customEvents"
    from events where project_id = ${projectId} and occurred_at >= ${start} and occurred_at < ${end}`);
  return result.rows[0] as Totals;
}

export async function getReport(slug: string, project: Project, days: number) {
  project = await getProject(slug, project.id);
  days = [1, 7, 30, 90].includes(days) ? days : 7;
  const db = getDb();
  const bound = await db.execute(
    sql`select (date_trunc('day', now() at time zone ${project.timezone}) - (${days - 1} * interval '1 day')) at time zone ${project.timezone} as start, now() as finish`,
  );
  const start = new Date(bound.rows[0].start as string);
  const end = new Date(bound.rows[0].finish as string);
  const previous = new Date(start.getTime() - (end.getTime() - start.getTime()));
  const range = sql`e.project_id = ${project.id} and e.occurred_at >= ${start} and e.occurred_at < ${end}`;
  const visited = sql`v.project_id = ${project.id} and exists (select 1 from events e where ${range} and e.visit_id = v.id)`;
  const [
    current,
    prior,
    timeline,
    pages,
    referrers,
    devices,
    browsers,
    operatingSystems,
    languages,
    campaigns,
    entryPages,
    eventList,
    properties,
  ] = await Promise.all([
    totals(project.id, start, end),
    totals(project.id, previous, start),
    db.execute(sql`select to_char(d, 'YYYY-MM-DD') as date, coalesce(x.visitors, 0)::int as visitors, coalesce(x.pageviews, 0)::int as pageviews
      from generate_series(${start}::timestamptz at time zone ${project.timezone}, ${end}::timestamptz at time zone ${project.timezone}, interval '1 day') d
      left join (select date_trunc('day', occurred_at at time zone ${project.timezone}) as day,
        count(distinct visitor_id)::int as visitors, count(*) filter (where type = 'pageview')::int as pageviews
        from events e where ${range} group by 1) x on x.day = d order by d`),
    db.execute(
      sql`select coalesce(path, '/') as label, count(*)::int as count from events e where ${range} and type = 'pageview' group by 1 order by count desc limit 8`,
    ),
    db.execute(
      sql`select coalesce(referrer, 'Direct') as label, count(*)::int as count from visits v where ${visited} group by 1 order by count desc limit 8`,
    ),
    db.execute(
      sql`select coalesce(device, 'Unknown') as label, count(*)::int as count from visits v where ${visited} group by 1 order by count desc limit 8`,
    ),
    db.execute(
      sql`select coalesce(browser, 'Unknown') as label, count(*)::int as count from visits v where ${visited} group by 1 order by count desc limit 8`,
    ),
    db.execute(
      sql`select coalesce(os, 'Unknown') as label, count(*)::int as count from visits v where ${visited} group by 1 order by count desc limit 8`,
    ),
    db.execute(
      sql`select coalesce(language, 'Unknown') as label, count(*)::int as count from visits v where ${visited} group by 1 order by count desc limit 8`,
    ),
    db.execute(
      sql`select coalesce(utm_source, 'Direct / untagged') as label, count(*)::int as count from visits v where ${visited} group by 1 order by count desc limit 8`,
    ),
    db.execute(
      sql`select coalesce(entry_path, 'Unknown') as label, count(*)::int as count from visits v where ${visited} group by 1 order by count desc limit 8`,
    ),
    db.execute(sql`select name, count(*)::int as count, count(distinct visitor_id)::int as visitors,
      count(*) filter (where source = 'browser')::int as browser, count(*) filter (where source = 'server')::int as server
      from events e where ${range} and type = 'event' group by name order by count desc limit 100`),
    db.execute(sql`select name, p.key, p.value, count(*)::int as count from events e, lateral jsonb_each_text(e.properties) p
      where ${range} and type = 'event' group by name, p.key, p.value order by count desc limit 50`),
  ]);
  return {
    current,
    prior,
    start,
    end,
    days,
    series: timeline.rows as SeriesPoint[],
    pages: pages.rows as Breakdown[],
    referrers: referrers.rows as Breakdown[],
    devices: devices.rows as Breakdown[],
    browsers: browsers.rows as Breakdown[],
    operatingSystems: operatingSystems.rows as Breakdown[],
    languages: languages.rows as Breakdown[],
    campaigns: campaigns.rows as Breakdown[],
    entryPages: entryPages.rows as Breakdown[],
    events: eventList.rows as EventRow[],
    properties: properties.rows as { name: string; key: string; value: string; count: number }[],
  };
}

export async function getRealtime(slug: string, projectId: string) {
  await requireProject(slug, projectId);
  const result = await getDb()
    .execute(sql`select distinct on (visitor_id) visitor_id as "visitorId", coalesce(current_path, '/') as path,
    coalesce(device, 'Unknown') as device, coalesce(browser, 'Unknown') as browser, browser_seen_at as "lastSeen"
    from visits where project_id = ${projectId} and browser_seen_at > now() - interval '60 seconds'
    order by visitor_id, browser_seen_at desc`);
  return result.rows as LiveVisit[];
}

export async function getPortfolio(slug: string) {
  const { organization } = await requireOrganization(slug);
  const result = await getDb().execute(sql`select p.id,
    (select count(distinct visitor_id)::int from events e where e.project_id = p.id and occurred_at >= now() - interval '7 days') as visitors,
    (select count(*)::int from events e where e.project_id = p.id and type = 'pageview' and occurred_at >= now() - interval '7 days') as pageviews,
    (select count(distinct visitor_id)::int from visits v where v.project_id = p.id and browser_seen_at > now() - interval '60 seconds') as online,
    (select max(received_at) from events e where e.project_id = p.id) as "lastEvent"
    from projects p where (p.organization_id = ${organization.id} or (p.organization_id is null and ${organization.id} = ${LEGACY_ORGANIZATION_ID})) order by p.created_at`);
  return result.rows as {
    id: string;
    visitors: number;
    pageviews: number;
    online: number;
    lastEvent: string | null;
  }[];
}
