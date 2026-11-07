import "server-only";
import { z } from "zod";

const messageData = z.object({
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/),
  heading: z.string().min(1).max(300),
  paragraphs: z.array(z.string().max(10_000)).max(20),
  organizationName: z.string().max(200).optional(),
  projectName: z.string().max(200).optional(),
  links: z
    .array(z.object({ label: z.string().min(1).max(200), path: z.string().max(4000) }))
    .max(10),
});

// Foundation only; feature-specific templates belong here as their features arrive.
export const emailTemplates = { message: messageData };
export type EmailTemplate = keyof typeof emailTemplates;
export type EmailData<T extends EmailTemplate> = z.infer<(typeof emailTemplates)[T]>;

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
  links: string[];
};

export function parseEmailData<T extends EmailTemplate>(template: T, data: EmailData<T>) {
  if (!Object.hasOwn(emailTemplates, template)) throw new Error("invalid_template");
  return emailTemplates[template].parse(data);
}

export function renderEmail(template: string, payload: unknown, appUrl: string): RenderedEmail {
  if (!Object.hasOwn(emailTemplates, template)) throw new Error("invalid_template");
  const data = emailTemplates[template as EmailTemplate].parse(payload);
  const base = new URL(appUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password)
    throw new Error("invalid_app_url");
  const links = data.links.map((link) => {
    const url = new URL(link.path, base);
    if (!link.path.startsWith("/") || link.path.startsWith("//") || url.origin !== base.origin)
      throw new Error("invalid_link");
    return { label: link.label, url: url.href };
  });
  const context = [
    data.organizationName && `Organization: ${data.organizationName}`,
    data.projectName && `Project: ${data.projectName}`,
  ].filter((line): line is string => Boolean(line));
  const paragraphs = [...context, ...data.paragraphs];
  const text = [
    "Pebble",
    data.heading,
    ...paragraphs,
    ...links.map((link) => `${link.label}: ${link.url}`),
  ].join("\n\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(data.subject)}</title></head><body style="font-family:Arial,sans-serif;line-height:1.6;color:#222;background:#fff"><main style="max-width:600px;margin:32px auto;padding:0 20px"><p>Pebble</p><h1>${escapeHtml(data.heading)}</h1>${paragraphs.map((p) => `<p>${escapeHtml(p).replaceAll("\n", "<br>")}</p>`).join("")}${links.map((link) => `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`).join("")}</main></body></html>`;
  return { subject: data.subject, html, text, links: links.map((link) => link.url) };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!;
  });
}
