/* eslint-disable @next/next/no-html-link-for-pages --
 * This page deliberately uses plain <a> tags: most targets are JSON API route
 * handlers (not pages), and for the few real page links we want a full document
 * navigation with no client-side prefetch — this is a static, crawler-facing
 * page, not an app shell.
 */
/**
 * /ai — human- and crawler-readable landing page for AI/web-search discovery.
 *
 * `/api/ai` stays the machine-readable contract; this page exists so search
 * engines and AI web-search retrieval have real HTML headings, prose, and
 * anchor text to index. Server-rendered, no client JS, no UI library.
 */

import type { Metadata } from "next";

import {
  GITHUB_REPOSITORY,
  PRODUCTION_BASE_URL,
  discoveryLeagues,
  discoveryManagers,
} from "@/lib/discovery";

const TITLE =
  "Bloodline Bowl Fantasy Football Intelligence Bridge — AI-ready analysis API";
const DESCRIPTION =
  "Public, read-only fantasy football intelligence API and analysis bridge. Roster and current-state analysis, projections, weekly intelligence, waiver / add-drop analysis, lineup and start/sit optimization, matchup analysis, transactions and history — for multiple Sleeper leagues including Bloodline Bowl and Devoted to the Game. AI assistants start at /api/ai.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/ai" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "article",
    url: `${PRODUCTION_BASE_URL}/ai`,
    title: TITLE,
    description: DESCRIPTION,
  },
};

const link = { color: "#6cb6ff", textDecoration: "none" } as const;
const muted = { color: "#9aa7b2" } as const;

export default function AiLandingPage() {
  const leagues = discoveryLeagues();
  const managers = discoveryManagers();

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "48px 24px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>
        Bloodline Bowl Fantasy Football Intelligence Bridge
      </h1>
      <p style={muted}>
        A <strong style={{ color: "#e6edf3" }}>public, read-only</strong> fantasy
        football intelligence API. It turns multiple Sleeper fantasy football
        leagues into self-describing JSON documents an AI assistant can fetch and
        reason about — no screenshots, no manual exports, no authentication for
        public leagues.
      </p>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>
        <a id="start" />
        AI assistants: start at the machine-readable contract
      </h2>
      <p>
        <a href="/api/ai" style={{ ...link, fontWeight: 700 }}>
          Open the AI discovery contract (/api/ai)
        </a>{" "}
        <span style={muted}>
          — a single JSON document listing every league, every known manager, and
          every analysis capability with concrete route templates. Follow the
          links it returns rather than guessing URLs. This <code>/ai</code> page
          is the human-readable companion; <code>/api/ai</code> is authoritative.
        </span>
      </p>
      <p style={muted}>
        Also:{" "}
        <a href="/llms.txt" style={link}>plain-text guide for LLMs (/llms.txt)</a>,{" "}
        <a href="/api/leagues" style={link}>league discovery (/api/leagues)</a>,{" "}
        <a href="/" style={link}>service homepage</a>.
      </p>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>
        <a id="identity" />
        League identity is not manager identity
      </h2>
      <p style={muted}>
        A <strong style={{ color: "#e6edf3" }}>league</strong> (for example{" "}
        <em>Bloodline Bowl</em>) is selected by its slug. A{" "}
        <strong style={{ color: "#e6edf3" }}>manager</strong> (a team owner such
        as <em>BijiMac</em>) is selected by a separate manager slug{" "}
        <em>within</em> that league. Membership is validated live on every
        request. A manager who is not in the named league returns an explicit
        error — never a different manager, and never a cross-league fallback. If
        you only know a manager username, look up their league below (or in{" "}
        <a href="/api/ai" style={link}>/api/ai</a>) first.
      </p>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>
        <a id="leagues" />
        Leagues covered
      </h2>
      <ul>
        {leagues.map((l) => (
          <li key={l.league_slug} style={{ marginBottom: 4 }}>
            <a href={`/api/leagues/${l.league_slug}`} style={link}>
              {l.league_name}
            </a>{" "}
            <span style={muted}>
              — provider {l.provider}, status {l.config_status}
              {l.is_default ? ", default league" : ""}
            </span>
          </li>
        ))}
      </ul>
      <p style={muted}>
        <strong style={{ color: "#e6edf3" }}>Bloodline Bowl</strong> and{" "}
        <strong style={{ color: "#e6edf3" }}>Devoted to the Game</strong> are the
        two fully active Sleeper leagues.
      </p>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>
        <a id="managers" />
        Managers
      </h2>
      <ul>
        {managers.map((m) => (
          <li key={m.canonical_url} style={{ marginBottom: 6 }}>
            <a href={m.canonical_url} style={link}>
              {m.sleeper_username ?? m.manager_slug}&apos;s team home
            </a>{" "}
            <span style={muted}>
              — manager <code>{m.manager_slug}</code> in{" "}
              {m.league_slug === "bloodline-bowl"
                ? "Bloodline Bowl"
                : m.league_slug === "devoted-to-the-game"
                  ? "Devoted to the Game"
                  : m.league_slug}
            </span>
          </li>
        ))}
      </ul>
      <p style={muted}>
        <strong style={{ color: "#e6edf3" }}>Supyo29</strong> and{" "}
        <strong style={{ color: "#e6edf3" }}>BijiMac</strong> manage teams in
        Bloodline Bowl. <strong style={{ color: "#e6edf3" }}>DarthMarker</strong>{" "}
        manages a team in Devoted to the Game.
      </p>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>
        <a id="capabilities" />
        Analysis capabilities
      </h2>
      <p style={muted}>
        Each manager&apos;s team home links to every capability below, pre-filled
        for that manager. Weekly routes take the current NFL week.
      </p>
      <h3 style={{ fontSize: 16, marginTop: 20 }}>Roster and current-state analysis</h3>
      <p style={muted}>
        Verified roster (starters, bench, taxi, reserve), roster composition, slot
        coverage, and canonical league current-state. See each{" "}
        <a href="#managers" style={link}>manager team home</a> and{" "}
        <a href="/api/leagues" style={link}>league discovery</a>.
      </p>
      <h3 style={{ fontSize: 16, marginTop: 20 }}>Projections</h3>
      <p style={muted}>
        Season projections translated through each league&apos;s actual scoring
        rules, plus need-weighted per-roster projection value.
      </p>
      <h3 style={{ fontSize: 16, marginTop: 20 }}>Weekly intelligence</h3>
      <p style={muted}>
        The combined weekly decision layer: lineup, start/sit, matchup, leverage,
        and waivers with the few moves that actually matter and a manager-facing
        summary.
      </p>
      <h3 style={{ fontSize: 16, marginTop: 20 }}>Waiver / add-drop analysis</h3>
      <p style={muted}>
        A league-aware acquisition engine — every candidate paired with the drop
        it requires, and an explicit &ldquo;do not add&rdquo; when the wire is not
        worth it.
      </p>
      <h3 style={{ fontSize: 16, marginTop: 20 }}>Lineup and start/sit optimization</h3>
      <p style={muted}>
        The optimal legal starting lineup for each league&apos;s real roster rules
        (slot assignment, not a naive points sort), plus explicit start/sit
        comparisons for close calls.
      </p>
      <h3 style={{ fontSize: 16, marginTop: 20 }}>Matchup analysis</h3>
      <p style={muted}>
        Both teams evaluated on their best legal projected lineup: projected
        totals, margin, positional edges, swing players, and — when coverage
        supports it — a seeded win probability with explicit low confidence.
      </p>
      <h3 style={{ fontSize: 16, marginTop: 20 }}>Transactions and history</h3>
      <p style={muted}>
        A normalized transaction ledger per league and retained weekly historical
        snapshots (earlier captures are never destroyed).
      </p>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>
        <a id="direct-links" />
        Direct manager links
      </h2>
      <ul>
        <li>
          <a href="/api/leagues/bloodline-bowl/managers/supyo29" style={link}>
            Supyo29 — Bloodline Bowl team home
          </a>
        </li>
        <li>
          <a href="/api/leagues/bloodline-bowl/managers/bijimac" style={link}>
            BijiMac — Bloodline Bowl team home
          </a>
        </li>
        <li>
          <a
            href="/api/leagues/devoted-to-the-game/managers/darthmarker"
            style={link}
          >
            DarthMarker — Devoted to the Game team home
          </a>
        </li>
      </ul>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>
        <a id="status" />
        Reading endpoint status
      </h2>
      <p style={muted}>
        An HTTP 200 means the route resolved — not that a recommendation is
        available. Every capability response carries its own{" "}
        <code>status</code> / <code>warnings</code> / <code>data_quality</code> /{" "}
        <code>snake_engine_status</code> (or equivalent) field. A capability can
        succeed and still legitimately be <code>BLOCKED</code>,{" "}
        <code>DEGRADED</code>, <code>AUTH_REQUIRED</code>, or{" "}
        <code>PERSISTENCE_NOT_CONFIGURED</code>. Inspect those before acting.
      </p>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>
        <a id="source" />
        Source and methodology
      </h2>
      <p style={muted}>
        Public repository:{" "}
        <a href={GITHUB_REPOSITORY} style={link}>
          {GITHUB_REPOSITORY.replace("https://", "")}
        </a>
        . GitHub is for inspecting how the numbers are produced and is not
        required to use the live bridge.
      </p>
    </main>
  );
}
