import type { MetadataRoute } from "next";

import {
  PRODUCTION_BASE_URL,
  discoveryLeagues,
  discoveryManagers,
} from "@/lib/discovery";

/**
 * Durable discovery roots only — not the hundreds of dynamic capability
 * endpoints. An AI or crawler that reaches any of these can discover the rest
 * by following links.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const abs = (p: string) => `${PRODUCTION_BASE_URL}${p}`;

  const roots = [
    "/",
    "/ai",
    "/api/ai",
    "/api/leagues",
    "/api/providers",
    "/llms.txt",
  ];

  const leaguePaths = discoveryLeagues().flatMap((l) => [
    `/api/leagues/${l.league_slug}`,
    `/api/leagues/${l.league_slug}/managers`,
  ]);

  const managerPaths = discoveryManagers().map((m) => m.canonical_url);

  return [...roots, ...leaguePaths, ...managerPaths].map((path) => ({
    url: abs(path),
    lastModified: now,
    changeFrequency: "daily",
    priority:
      path === "/api/ai" ? 1 : path === "/" || path === "/ai" ? 0.9 : 0.7,
  }));
}
