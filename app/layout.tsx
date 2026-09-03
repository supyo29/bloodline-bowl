import type { Metadata } from "next";
import type { ReactNode } from "react";

import { PRODUCTION_BASE_URL, SERVICE_DESCRIPTION } from "@/lib/discovery";

const description =
  "Read-only JSON API and AI-discovery bridge for fantasy football. Turns multiple Sleeper (and Yahoo) leagues into self-describing documents: rosters, scoring, projections, draft help, and a weekly decision engine (lineup, start/sit, matchup, waivers). AI assistants: start at /api/ai.";

export const metadata: Metadata = {
  metadataBase: new URL(PRODUCTION_BASE_URL),
  title: {
    default: "Fantasy Football Intelligence Bridge — AI-ready league API",
    template: "%s — Fantasy Football Intelligence Bridge",
  },
  description,
  applicationName: SERVICE_DESCRIPTION.name,
  keywords: [
    "fantasy football API",
    "Sleeper API bridge",
    "fantasy football AI",
    "fantasy football data",
    "weekly lineup optimizer API",
    "waiver wire analysis API",
    "fantasy football projections API",
    "multi-league fantasy football",
  ],
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PRODUCTION_BASE_URL,
    title: "Fantasy Football Intelligence Bridge — AI-ready league API",
    description,
    siteName: SERVICE_DESCRIPTION.name,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          margin: 0,
          background: "#0b0f14",
          color: "#e6edf3",
        }}
      >
        {children}
      </body>
    </html>
  );
}
