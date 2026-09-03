/**
 * Status / landing page. The bridge is an API first; this page orients both
 * humans and AI crawlers and points them at the canonical discovery layer.
 */

import {
  CAPABILITIES,
  GITHUB_REPOSITORY,
  discoveryLeagues,
  discoveryManagers,
} from "@/lib/discovery";

export const dynamic = "force-dynamic";

const link = { color: "#6cb6ff", textDecoration: "none" } as const;
const muted = { color: "#9aa7b2" } as const;

export default function StatusPage() {
  const leagues = discoveryLeagues();
  const managers = discoveryManagers();

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>
        Fantasy Football Intelligence Bridge
      </h1>
      <p style={{ ...muted, lineHeight: 1.6, marginTop: 0 }}>
        A read-only JSON API that turns multiple Sleeper (and, once authorized,
        Yahoo) fantasy football leagues into self-describing documents an AI can
        fetch and reason about: rosters, scoring, projections, draft help, and a
        weekly decision engine (lineup, start/sit, matchup, waivers). Every
        request operates on exactly one league — nothing is merged.
      </p>

      <div
        style={{
          border: "1px solid #1f2a37",
          borderRadius: 8,
          padding: "16px 20px",
          margin: "24px 0",
          background: "#0e141b",
        }}
      >
        <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>
          AI assistants: start here
        </h2>
        <p style={{ margin: "0 0 8px" }}>
          <a href="/api/ai" style={{ ...link, fontWeight: 700, fontSize: 16 }}>
            <code>/api/ai</code>
          </a>
          <span style={muted}>
            {" "}
            — one endpoint that describes the whole service: leagues, known
            managers, every capability, and concrete route templates. Follow the
            links it returns; don&apos;t guess URLs.
          </span>
        </p>
        <p style={{ margin: 0, ...muted }}>
          Also: <a href="/llms.txt" style={link}><code>/llms.txt</code></a>{" "}
          (plain-text guide), <a href="/sitemap.xml" style={link}><code>/sitemap.xml</code></a>,{" "}
          <a href="/robots.txt" style={link}><code>/robots.txt</code></a>.
        </p>
      </div>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Canonical routing hierarchy</h2>
      <pre
        style={{
          background: "#0e141b",
          border: "1px solid #1f2a37",
          borderRadius: 8,
          padding: 16,
          overflowX: "auto",
          lineHeight: 1.7,
        }}
      >
        {`/api/ai
  -> /api/leagues
    -> /api/leagues/{leagueSlug}
      -> /api/leagues/{leagueSlug}/managers
        -> /api/leagues/{leagueSlug}/managers/{managerSlug}
          -> specific analysis capability`}
      </pre>
      <p style={{ ...muted, lineHeight: 1.6 }}>
        <strong style={{ color: "#e6edf3" }}>
          League identity is not manager identity.
        </strong>{" "}
        The league slug selects the league; the manager slug selects a team owner
        inside it. Membership is validated live — a non-member manager returns an
        error, never a different manager.
      </p>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Known manager routes</h2>
      <ul style={{ lineHeight: 1.9, paddingLeft: 18 }}>
        {managers.map((m) => (
          <li key={m.canonical_url}>
            <a href={m.canonical_url} style={link}>
              <code>{m.canonical_url}</code>
            </a>
            <span style={muted}>
              {" "}
              — {m.manager_slug}
              {m.sleeper_username ? ` (Sleeper: ${m.sleeper_username})` : ""}, league{" "}
              <code>{m.league_slug}</code>
            </span>
          </li>
        ))}
      </ul>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Leagues</h2>
      <ul style={{ lineHeight: 1.9, paddingLeft: 18 }}>
        {leagues.map((l) => (
          <li key={l.league_slug}>
            <a href={`/api/leagues/${l.league_slug}`} style={link}>
              <code>{l.league_slug}</code>
            </a>
            <span style={muted}>
              {" "}
              — {l.league_name} · {l.provider} · {l.config_status}
              {l.is_default ? " · default" : ""}
            </span>
          </li>
        ))}
      </ul>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Analysis capabilities</h2>
      <ul style={{ lineHeight: 1.8, paddingLeft: 18 }}>
        {CAPABILITIES.map((c) => (
          <li key={c.id}>
            <code style={{ color: "#e6edf3" }}>{c.route_template}</code>
            <span style={muted}>
              {" "}
              [{c.scope}] — {c.title}
            </span>
          </li>
        ))}
      </ul>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Legacy compatibility</h2>
      <p style={{ ...muted, lineHeight: 1.6 }}>
        The older <code>?league=&lt;slug&gt;</code> query-form routes (e.g.{" "}
        <code>/api/league?league=bloodline-bowl</code>, <code>/api/draft</code>,{" "}
        <code>/api/scoring</code>, <code>/api/snapshot</code>) still work but are
        legacy. Prefer the canonical path routes above. <code>/api/ai</code> lists
        which capabilities are only available in the legacy form.
      </p>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Source &amp; methodology</h2>
      <p style={{ ...muted, lineHeight: 1.6 }}>
        Public repository:{" "}
        <a href={GITHUB_REPOSITORY} style={link}>
          {GITHUB_REPOSITORY.replace("https://", "")}
        </a>
        . GitHub is for inspecting how the numbers are produced — it is{" "}
        <strong style={{ color: "#e6edf3" }}>not required</strong> to use the live
        bridge.
      </p>

      <p style={{ marginTop: 24 }}>
        <a href="/bridge" style={{ ...link, fontWeight: 700 }}>
          → Draft Bridge
        </a>
        <span style={muted}>
          {" "}
          — interactive, league-isolated draft-night board.
        </span>
      </p>
    </main>
  );
}
