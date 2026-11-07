import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { marked } from "marked";

export const legalPages = [
  {
    slug: "terms",
    label: "Terms",
    title: "Terms of Service",
    description: "Terms of Service for using Pebble.",
  },
  {
    slug: "privacy",
    label: "Privacy",
    title: "Privacy Policy",
    description: "How Pebble handles and protects personal information.",
  },
  {
    slug: "dpa",
    label: "DPA",
    title: "Data Processing Agreement",
    description: "Pebble’s Data Processing Agreement for customers.",
  },
] as const;

export type LegalSlug = (typeof legalPages)[number]["slug"];

export function isLegalSlug(slug: string): slug is LegalSlug {
  return legalPages.some((page) => page.slug === slug);
}

async function readLegalText(slug: LegalSlug): Promise<string | null> {
  if (!isLegalSlug(slug)) throw new Error("Unknown legal document.");
  try {
    const text = await fs.readFile(
      path.join(process.cwd(), "src/content/legal", `${slug}.md`),
      "utf8",
    );
    return text.trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Only render trusted, owner-committed Markdown; raw HTML is intentionally supported. */
export async function getLegalHtml(slug: LegalSlug): Promise<string | null> {
  const text = await readLegalText(slug);
  return text === null ? null : marked.parse(text, { async: false });
}

/** Nonempty texts, not just files. Live checkout requires terms && privacy (F21). */
export async function getLegalTextAvailability(): Promise<Record<LegalSlug, boolean>> {
  const [terms, privacy, dpa] = await Promise.all(
    legalPages.map(async ({ slug }) => Boolean(await readLegalText(slug))),
  );
  return { terms, privacy, dpa };
}
