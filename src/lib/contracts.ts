import { z } from "zod";

export const propertiesSchema = z
  .record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/),
    z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= 20, "At most 20 properties are allowed");

export function cleanPath(value: string) {
  if (!value.startsWith("/") || value.startsWith("//"))
    throw new Error("Path must start with a single slash");
  return value.split(/[?#]/)[0].slice(0, 1024);
}

export const messageSchema = z
  .object({
    id: z.uuid(),
    type: z.enum(["pageview", "event", "heartbeat"]),
    timestamp: z.iso.datetime({ offset: true }).optional(),
    visitorId: z.uuid().optional(),
    visitId: z.uuid().optional(),
    path: z
      .string()
      .max(2048)
      .refine((v) => v.startsWith("/") && !v.startsWith("//"), "Invalid path")
      .transform(cleanPath)
      .optional(),
    name: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/)
      .optional(),
    properties: propertiesSchema.default({}),
    referrer: z.string().max(2048).optional(),
    language: z.string().max(35).optional(),
    utm: z
      .object({
        source: z.string().max(200).optional(),
        medium: z.string().max(200).optional(),
        campaign: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (Boolean(m.visitorId) !== Boolean(m.visitId))
      ctx.addIssue({ code: "custom", message: "visitorId and visitId must be supplied together" });
    if (m.type === "event" && !m.name)
      ctx.addIssue({ code: "custom", message: "Events require a name" });
    if (m.type !== "event" && !m.path)
      ctx.addIssue({ code: "custom", message: "Pageviews and heartbeats require a path" });
    if (m.type !== "event" && m.name)
      ctx.addIssue({ code: "custom", message: "Only events have a name" });
  });

export const envelopeSchema = z
  .object({ projectId: z.uuid().optional(), events: z.array(messageSchema).min(1).max(20) })
  .strict();
export type TrackingMessage = z.infer<typeof messageSchema>;

export function normalizeOrigins(value: string): string[] {
  const entries = value
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
  if (!entries.length || entries.length > 20)
    throw new Error("Add between 1 and 20 website origins.");
  return [
    ...new Set(
      entries.map((entry) => {
        const url = new URL(entry.includes("://") ? entry : `https://${entry}`);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw new Error("Use website origins without paths, for example https://example.com.");
        return url.origin;
      }),
    ),
  ];
}

export function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export const projectSchema = z.object({
  name: z.string().trim().min(1).max(60),
  origins: z.string().min(1).max(4096),
  timezone: z.string().refine(validTimezone, "Use a valid IANA timezone, e.g. Europe/Oslo"),
  retentionDays: z.coerce.number().int().min(7).max(730),
  agentContext: z
    .string()
    .refine(
      (value) => Array.from(value).length <= 4000,
      "Agent context must be at most 4,000 characters.",
    )
    .default(""),
});
