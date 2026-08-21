/**
 * Minimal status page. The bridge is an API first; this exists so hitting the
 * deployment root explains what the service is and links to the endpoints.
 */

import { resolveLeagueId } from "@/lib/sleeper/service";
import { listLeagueTargets } from "@/lib/leagues/registry";

export const dynamic = "force-dynamic";

const endpoints = [
  {
    path: "/api/league",
    description: "Consolidated, normalized league snapshot. The main endpoint.",
  },
  {
    path: "/api/draft",
    description:
      "Live draft-night view: acquisitions, budgets, max bids, and available players.",
  },
  {
    path: "/api/scoring",
    description:
      "Scoring rules, derived metrics, archetype examples, sensitivity, and diagnostics.",
  },
  {
    path: "/api/snapshot",
    description: "Compact, AI-friendly current-state view of the whole league.",
  },
  {
    path: "/api/standings",
    description:
      "Factual records plus weekly-score statistics. See README for the full analytics layer.",
  },
  {
    path: "/api/health",
    description: "Liveness probe and player-cache status.",
  },
  {
    path: "/api/raw?resource=rosters",
    description: "Raw Sleeper payloads for debugging (allowlisted resources).",
  },
];

export default function StatusPage() {
  const leagueId = resolveLeagueId();
  const leagues = listLeagueTargets();

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>
        Bloodline Bowl — Sleeper Data Bridge
      </h1>
      <p style={{ color: "#9aa7b2", lineHeight: 1.6, marginTop: 0 }}>
        Read-only bridge that fetches Sleeper leagues from the public Sleeper
        API, resolves player and manager IDs into readable objects, and serves
        one consolidated JSON document per league for AI analysis. Every request
        operates on exactly one league — nothing is merged across leagues.
      </p>
      <p style={{ color: "#9aa7b2", fontSize: 14 }}>
        Default league ID: <code style={{ color: "#e6edf3" }}>{leagueId}</code>
      </p>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Leagues</h2>
      <p style={{ color: "#9aa7b2", lineHeight: 1.6, marginTop: 0 }}>
        Add <code>?league=&lt;key&gt;</code> to any endpoint below to target a
        specific league. Omit it to use the default.
      </p>
      <ul style={{ lineHeight: 1.9, paddingLeft: 18 }}>
        {leagues.map((league) => (
          <li key={league.key}>
            <code style={{ color: "#e6edf3" }}>{league.key}</code>
            <span style={{ color: "#9aa7b2" }}>
              {" "}
              — {league.display_name} (Sleeper league {league.league_id}
              {league.sleeper_username ? `, ${league.sleeper_username}` : ""})
            </span>
          </li>
        ))}
      </ul>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Endpoints</h2>
      <ul style={{ lineHeight: 1.9, paddingLeft: 18 }}>
        {endpoints.map((endpoint) => (
          <li key={endpoint.path}>
            <a
              href={endpoint.path}
              style={{ color: "#6cb6ff", textDecoration: "none" }}
            >
              <code>{endpoint.path}</code>
            </a>
            <span style={{ color: "#9aa7b2" }}> — {endpoint.description}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
