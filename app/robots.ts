import type { MetadataRoute } from "next";

import { PRODUCTION_BASE_URL } from "@/lib/discovery";

/**
 * The bridge is intentionally public and read-only. Public discovery + docs
 * surfaces are crawlable; operational / debug routes are disallowed so they are
 * not indexed or presented as consumer APIs.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/cron/",
          "/api/auth/",
          "/api/draft/debug",
          "/api/raw",
          "/api/bridge/",
        ],
      },
    ],
    sitemap: `${PRODUCTION_BASE_URL}/sitemap.xml`,
    host: PRODUCTION_BASE_URL,
  };
}
