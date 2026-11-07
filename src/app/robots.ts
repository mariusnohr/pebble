import type { MetadataRoute } from "next";
import { appOrigin } from "@/server/config";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/app", "/api", "/operator", "/invite"],
    },
    sitemap: `${appOrigin()}/sitemap.xml`,
  };
}
