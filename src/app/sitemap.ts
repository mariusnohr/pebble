import type { MetadataRoute } from "next";
import { appOrigin } from "@/server/config";
import { legalPages } from "@/server/legal";

export default function sitemap(): MetadataRoute.Sitemap {
  return legalPages.map(({ slug }) => ({ url: `${appOrigin()}/legal/${slug}` }));
}
