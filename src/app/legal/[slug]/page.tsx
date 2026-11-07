import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { appOrigin } from "@/server/config";
import { getLegalHtml, isLegalSlug, legalPages } from "@/server/legal";

export const dynamicParams = false;

export function generateStaticParams() {
  return legalPages.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps<"/legal/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const page = legalPages.find((page) => page.slug === slug);
  if (!page) notFound();
  const url = `${appOrigin()}/legal/${slug}`;
  return {
    title: page.title,
    description: page.description,
    robots: { index: true, follow: true },
    alternates: { canonical: url },
    openGraph: {
      title: `${page.title} · Pebble`,
      description: page.description,
      url,
      siteName: "Pebble",
      type: "website",
    },
  };
}

export default async function LegalPage({ params }: PageProps<"/legal/[slug]">) {
  const { slug } = await params;
  if (!isLegalSlug(slug)) notFound();
  const page = legalPages.find((page) => page.slug === slug)!;
  const html = await getLegalHtml(slug);

  return (
    <article className="legal-page" aria-labelledby="legal-title">
      <h1 id="legal-title">{page.title}</h1>
      {html === null ? (
        <p>This page is being prepared</p>
      ) : (
        <div className="legal-prose" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </article>
  );
}
