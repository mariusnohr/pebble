import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { events, projects, visits } from "@/db/schema";
import type { TrackingMessage } from "@/lib/contracts";

export class IngestError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function requestDimensions(agent: string) {
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /(?:Chrome|CriOS)\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Other";
  const os = /Android/.test(agent)
    ? "Android"
    : /iPhone|iPad|iPod/.test(agent)
      ? "iOS"
      : /Windows/.test(agent)
        ? "Windows"
        : /Macintosh/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : "Other";
  const device = /iPad|Tablet/.test(agent)
    ? "Tablet"
    : /Mobile|iPhone|Android/.test(agent)
      ? "Mobile"
      : "Desktop";
  return { browser, os, device };
}

function referrerHost(value?: string) {
  try {
    const url = new URL(value ?? "");
    return ["https:", "http:"].includes(url.protocol) ? url.hostname : null;
  } catch {
    return null;
  }
}

export async function ingest(
  projectId: string,
  messages: TrackingMessage[],
  source: "browser" | "server",
  context: { origin?: string; userAgent?: string } = {},
) {
  const now = new Date();
  for (const message of messages) {
    const time = message.timestamp ? new Date(message.timestamp) : now;
    if (time.getTime() < now.getTime() - 7 * 86400000 || time.getTime() > now.getTime() + 300000)
      throw new IngestError(
        "Timestamp must be within the last 7 days and no more than 5 minutes ahead.",
      );
    if (source === "browser" && (!message.visitorId || !message.visitId))
      throw new IngestError("Browser messages require visitor and visit identifiers.");
    if (source === "server" && message.type === "heartbeat")
      throw new IngestError("Heartbeats are browser-only.");
  }

  return getDb().transaction(async (tx) => {
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("share");
    if (!project) throw new IngestError("Project not found.", 404);
    if (source === "browser" && !project.origins.includes(context.origin ?? ""))
      throw new IngestError("Origin is not allowed for this project.", 403);
    if (project.paused) throw new IngestError("Collection is paused.", 403);
    // Ignore common crawlers without letting them create visits or presence.
    if (
      source === "browser" &&
      /bot|crawler|spider|headless|preview|lighthouse/i.test(context.userAgent ?? "")
    )
      return { accepted: 0, duplicates: 0, ignored: messages.length };
    let accepted = 0;
    let duplicates = 0;
    for (const m of messages) {
      const occurredAt = source === "browser" ? now : m.timestamp ? new Date(m.timestamp) : now;
      if (m.type === "heartbeat") {
        await tx
          .update(visits)
          .set({ browserSeenAt: now, lastSeenAt: now, currentPath: m.path })
          .where(
            and(
              eq(visits.projectId, projectId),
              eq(visits.id, m.visitId!),
              eq(visits.visitorId, m.visitorId!),
            ),
          );
        accepted++;
        continue;
      }
      const inserted = await tx
        .insert(events)
        .values({
          projectId,
          id: m.id,
          type: m.type,
          source,
          occurredAt,
          receivedAt: now,
          visitorId: m.visitorId,
          visitId: m.visitId,
          path: m.path,
          name: m.name,
          properties: m.properties,
        })
        .onConflictDoNothing()
        .returning({ id: events.id });
      if (!inserted.length) {
        duplicates++;
        continue;
      }
      if (m.visitorId && m.visitId) {
        const dimensions: Partial<ReturnType<typeof requestDimensions>> =
          source === "browser" ? requestDimensions(context.userAgent ?? "") : {};
        const isPresence = source === "browser" && m.type === "pageview";
        const referrer = referrerHost(m.referrer);
        const ownHost = context.origin ? new URL(context.origin).hostname : null;
        const values = {
          projectId,
          id: m.visitId,
          visitorId: m.visitorId,
          startedAt: occurredAt,
          lastSeenAt: occurredAt,
          browserSeenAt: isPresence ? now : null,
          entryPath: m.path ?? null,
          currentPath: m.path ?? null,
          ...dimensions,
          language: source === "browser" ? m.language : undefined,
          referrer: referrer === ownHost ? null : referrer,
          utmSource: m.utm?.source,
          utmMedium: m.utm?.medium,
          utmCampaign: m.utm?.campaign,
        };
        const [visit] = await tx
          .insert(visits)
          .values(values)
          .onConflictDoUpdate({
            target: [visits.projectId, visits.id],
            set: {
              startedAt: sql`least(${visits.startedAt}, ${occurredAt})`,
              lastSeenAt: sql`greatest(${visits.lastSeenAt}, ${occurredAt})`,
              ...(isPresence ? { browserSeenAt: now, currentPath: m.path } : {}),
              ...(source === "browser"
                ? {
                    // A server outcome can arrive before the browser's first batch.
                    // Fill first-browser attribution once, then keep it stable for the visit.
                    entryPath: sql`case when ${visits.browser} is null then coalesce(${m.path ?? null}, ${visits.entryPath}) else ${visits.entryPath} end`,
                    referrer: sql`case when ${visits.browser} is null then ${values.referrer} else ${visits.referrer} end`,
                    utmSource: sql`case when ${visits.browser} is null then ${m.utm?.source ?? null} else ${visits.utmSource} end`,
                    utmMedium: sql`case when ${visits.browser} is null then ${m.utm?.medium ?? null} else ${visits.utmMedium} end`,
                    utmCampaign: sql`case when ${visits.browser} is null then ${m.utm?.campaign ?? null} else ${visits.utmCampaign} end`,
                    browser: sql`coalesce(${visits.browser}, ${dimensions.browser ?? null})`,
                    os: sql`coalesce(${visits.os}, ${dimensions.os ?? null})`,
                    device: sql`coalesce(${visits.device}, ${dimensions.device ?? null})`,
                    language: sql`coalesce(${visits.language}, ${m.language ?? null})`,
                  }
                : {}),
            },
          })
          .returning({ visitorId: visits.visitorId });
        if (visit.visitorId !== m.visitorId)
          throw new IngestError("Visit belongs to a different visitor.");
      }
      accepted++;
    }
    return { accepted, duplicates, ignored: 0 };
  });
}
