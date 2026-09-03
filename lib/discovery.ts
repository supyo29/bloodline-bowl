/**
 * AI-discovery manifest — the single source of truth for the "one link to rule
 * them all" layer.
 *
 * Everything an external AI assistant needs to bootstrap the bridge from a
 * single URL is derived here: the service description, the canonical routing
 * hierarchy, the league + known-manager tables, and the full capability
 * catalog with concrete route templates.
 *
 * This module is PURE — it performs no network calls and reads only the static
 * league / manager registries. `/api/ai`, the homepage, `/llms.txt`, and
 * `/sitemap.xml` all render from it so they can never drift apart.
 *
 * It exposes routing + capability metadata only. No secrets, tokens, provider
 * credentials, or private account data.
 */

import {
  getLeagueRegistry,
  leagueConfigStatus,
  DEFAULT_LEAGUE_KEY,
} from "@/lib/leagues/registry";
import { findRegisteredManager } from "@/lib/leagues/managers";

/** Canonical production origin. Override only for a bespoke deployment. */
export const PRODUCTION_BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ||
  "https://bloodline-bowl-sleeper-bridge.vercel.app";

/** Public repository — methodology / implementation inspection only. */
export const GITHUB_REPOSITORY = "https://github.com/supyo29/bloodline-bowl";

/** Absolute URL for a bridge-relative path. */
export function absoluteUrl(path: string): string {
  return `${PRODUCTION_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/* -------------------------------------------------------------------------- */
/* Capability catalog                                                          */
/* -------------------------------------------------------------------------- */

export type CapabilityScope =
  | "league" // one league, shared by every manager in it
  | "manager" // one manager inside one league
  | "manager-week" // one manager, one NFL week
  | "service"; // whole-service metadata

export interface Capability {
  id: string;
  title: string;
  description: string;
  scope: CapabilityScope;
  /** Path template. `{leagueSlug}`, `{managerSlug}`, `{week}` are placeholders. */
  route_template: string;
  /** True when this is the modern path-based route (not a `?league=` legacy form). */
  canonical: boolean;
  /** Whether the data is live current-state (true) or historical (false) or both. */
  temporality: "live" | "historical" | "live+historical";
  query_params?: string[];
}

/**
 * Every public, read-only capability an AI consumer should use. Debug /
 * operational routes (`/api/cron/*`, `/api/draft/debug`, `/api/raw`,
 * `/api/auth/*`, `/api/bridge/*`) are deliberately excluded.
 */
export const CAPABILITIES: Capability[] = [
  {
    id: "league_discovery",
    title: "League discovery",
    description:
      "Every configured league with its canonical slug, provider, readiness, and the URLs to descend into it.",
    scope: "service",
    route_template: "/api/leagues",
    canonical: true,
    temporality: "live",
  },
  {
    id: "league_overview",
    title: "League overview",
    description:
      "One league: settings, teams, managers, standings, draft status, plus a live-verified roster_id → canonical manager URL table.",
    scope: "league",
    route_template: "/api/leagues/{leagueSlug}",
    canonical: true,
    temporality: "live",
  },
  {
    id: "manager_directory",
    title: "Manager directory",
    description:
      "Every manager in one league (live from the provider) with canonical manager, draft, and snapshot URLs.",
    scope: "league",
    route_template: "/api/leagues/{leagueSlug}/managers",
    canonical: true,
    temporality: "live",
  },
  {
    id: "manager_home",
    title: "Manager home + roster",
    description:
      "One manager's verified identity, full roster (starters / bench / taxi / reserve), roster composition, slot coverage, and links to every manager-specific capability.",
    scope: "manager",
    route_template: "/api/leagues/{leagueSlug}/managers/{managerSlug}",
    canonical: true,
    temporality: "live",
  },
  {
    id: "manager_context",
    title: "Manager analytical context",
    description:
      "Provider-independent canonical context for one manager: canonical ids, team, roster, record. The generic spine the weekly engine consumes.",
    scope: "manager",
    route_template: "/api/context/{leagueSlug}/{managerSlug}",
    canonical: true,
    temporality: "live",
  },
  {
    id: "league_state",
    title: "Canonical league state",
    description:
      "Provider-independent current-state snapshot for one league (the same shape the nightly capture job persists), with explicit live + persistence status.",
    scope: "league",
    route_template: "/api/league/{leagueSlug}/state",
    canonical: true,
    temporality: "live",
  },
  {
    id: "scoring",
    title: "Scoring rules + analysis",
    description:
      "League scoring settings, derived metrics, archetype examples, and sensitivity diagnostics.",
    scope: "league",
    route_template: "/api/leagues/{leagueSlug}/scoring",
    canonical: true,
    temporality: "live",
  },
  {
    id: "league_projections",
    title: "League projections",
    description:
      "Season projections translated through this league's actual scoring, with value-over-replacement, tiers, and positional scarcity. Identical for every manager in the league.",
    scope: "league",
    route_template: "/api/leagues/{leagueSlug}/projections",
    canonical: true,
    temporality: "live",
    query_params: ["position", "limit"],
  },
  {
    id: "player_projection",
    title: "Single-player projection",
    description: "One player's projection detail under this league's scoring.",
    scope: "league",
    route_template: "/api/leagues/{leagueSlug}/projections/{playerId}",
    canonical: true,
    temporality: "live",
  },
  {
    id: "manager_projections",
    title: "Need-weighted manager projections",
    description:
      "League projections re-weighted for ONE manager's roster: contextual_value, roster_fit, need_multiplier, and an RI-vs-Sleeper projection edge.",
    scope: "manager",
    route_template:
      "/api/leagues/{leagueSlug}/managers/{managerSlug}/projections",
    canonical: true,
    temporality: "live",
    query_params: ["limit"],
  },
  {
    id: "league_draft",
    title: "League draft state",
    description:
      "Shared draft board: picks made, budgets / max bids (auction) or board order (snake), and available players.",
    scope: "league",
    route_template: "/api/leagues/{leagueSlug}/draft",
    canonical: true,
    temporality: "live",
  },
  {
    id: "manager_draft",
    title: "Personalized draft context",
    description:
      "Shared draft state composed with one manager's roster, slot, picks, positional needs, and best-available candidates.",
    scope: "manager",
    route_template: "/api/leagues/{leagueSlug}/managers/{managerSlug}/draft",
    canonical: true,
    temporality: "live",
    query_params: ["available_limit", "recommendations"],
  },
  {
    id: "manager_recommendations",
    title: "Snake-draft recommendation engine",
    description:
      "Who THIS manager should draft now — turn geometry, tier cliffs, ADP survival, reach cost, roster-construction risk, two-pick optimisation. Snake drafts only.",
    scope: "manager",
    route_template:
      "/api/leagues/{leagueSlug}/managers/{managerSlug}/recommendations",
    canonical: true,
    temporality: "live",
  },
  {
    id: "league_snapshot",
    title: "League snapshot",
    description:
      "Compact, AI-friendly current-state view of the whole league in one document.",
    scope: "league",
    route_template: "/api/leagues/{leagueSlug}/snapshot",
    canonical: true,
    temporality: "live",
  },
  {
    id: "manager_snapshot",
    title: "Personalized snapshot",
    description:
      "Shared league snapshot composed with one manager's roster, slot, picks, needs, and recommendations — a single paste-once hand-off URL.",
    scope: "manager",
    route_template: "/api/leagues/{leagueSlug}/managers/{managerSlug}/snapshot",
    canonical: true,
    temporality: "live",
  },
  {
    id: "weekly_intelligence",
    title: "Weekly intelligence (combined decision layer)",
    description:
      "Lineup + start/sit + matchup + leverage + waivers for one manager and week, plus top_actions and a manager-facing summary. Missing projections degrade explicitly, never to 0.",
    scope: "manager-week",
    route_template: "/api/intelligence/{leagueSlug}/{managerSlug}/week/{week}",
    canonical: true,
    temporality: "live",
  },
  {
    id: "weekly_lineup",
    title: "Optimal lineup + start/sit",
    description:
      "Optimal legal starting lineup (slot assignment, not a points sort) for one manager and week, plus explicit start/sit comparisons for close calls.",
    scope: "manager-week",
    route_template: "/api/lineup/{leagueSlug}/{managerSlug}/week/{week}",
    canonical: true,
    temporality: "live",
  },
  {
    id: "weekly_matchup",
    title: "Matchup analysis",
    description:
      "Both teams on their best legal projected lineup: totals, margin, positional edges, leverage / swing players, bench depth, and (when coverage supports it) a seeded Monte-Carlo win probability.",
    scope: "manager-week",
    route_template: "/api/matchup/{leagueSlug}/{managerSlug}/week/{week}",
    canonical: true,
    temporality: "live",
  },
  {
    id: "weekly_waivers",
    title: "Waiver / add-drop engine",
    description:
      "League-aware acquisition engine: every candidate paired with the drop it requires, DO_NOT_ADD when the wire is not worth it. Free agency is canonical, this-league availability only.",
    scope: "manager-week",
    route_template: "/api/waivers/{leagueSlug}/{managerSlug}/week/{week}",
    canonical: true,
    temporality: "live",
    query_params: ["limit"],
  },
  {
    id: "transactions",
    title: "Transaction ledger",
    description:
      "Normalized canonical transactions for one league from the durable ledger (falls back to a live provider read before the first sync; `source` says which).",
    scope: "league",
    route_template: "/api/transactions/{leagueSlug}",
    canonical: true,
    temporality: "live+historical",
    query_params: ["season", "week", "type", "team", "limit"],
  },
  {
    id: "history",
    title: "Historical weekly snapshots",
    description:
      "Retained weekly captures from the durable snapshot store (earlier versions are never destroyed). Explicit PERSISTENCE_NOT_CONFIGURED state when history is not wired up.",
    scope: "league",
    route_template: "/api/history/{leagueSlug}/week/{week}",
    canonical: true,
    temporality: "historical",
    query_params: ["capture_type", "season", "versions"],
  },
  {
    id: "providers",
    title: "Provider + persistence readiness",
    description:
      "Live health of every fantasy provider and the persistence subsystem, from real probes.",
    scope: "service",
    route_template: "/api/providers",
    canonical: true,
    temporality: "live",
  },
];

/**
 * Legacy `?league=` query-form routes. Still supported for existing clients;
 * an AI should prefer the canonical path routes above. Some historical-analysis
 * capabilities are currently ONLY exposed in this form.
 */
export const LEGACY_ROUTES: Array<{
  id: string;
  route_template: string;
  description: string;
  canonical_equivalent: string | null;
}> = [
  {
    id: "legacy_league",
    route_template: "/api/league?league={leagueSlug}",
    description: "Consolidated normalized league snapshot (original entry point).",
    canonical_equivalent: "/api/leagues/{leagueSlug}",
  },
  {
    id: "legacy_draft",
    route_template: "/api/draft?league={leagueSlug}",
    description: "Live draft-night view.",
    canonical_equivalent: "/api/leagues/{leagueSlug}/draft",
  },
  {
    id: "legacy_scoring",
    route_template: "/api/scoring?league={leagueSlug}",
    description: "Scoring rules + analysis.",
    canonical_equivalent: "/api/leagues/{leagueSlug}/scoring",
  },
  {
    id: "legacy_snapshot",
    route_template: "/api/snapshot?league={leagueSlug}",
    description: "Compact league snapshot.",
    canonical_equivalent: "/api/leagues/{leagueSlug}/snapshot",
  },
  {
    id: "legacy_transactions",
    route_template: "/api/transactions?league={leagueSlug}",
    description: "Sleeper-native transactions.",
    canonical_equivalent: "/api/transactions/{leagueSlug}",
  },
  {
    id: "legacy_context",
    route_template: "/api/context/{leagueSlug}/{managerSlug}",
    description:
      "Canonical manager context (path form; there is no `?league=` variant).",
    canonical_equivalent: "/api/context/{leagueSlug}/{managerSlug}",
  },
  {
    id: "standings",
    route_template: "/api/standings?league={leagueSlug}&season={season}",
    description:
      "Factual standings + derived weekly score statistics. No canonical path form yet.",
    canonical_equivalent: null,
  },
  {
    id: "matchups_history",
    route_template: "/api/matchups?league={leagueSlug}&season={season}&week={week}",
    description:
      "Factual weekly matchup results with weekly score rank. No canonical path form yet.",
    canonical_equivalent: null,
  },
  {
    id: "roster_analysis",
    route_template: "/api/roster-analysis?league={leagueSlug}&season={season}",
    description:
      "Deterministic structural roster facts: composition, age, slot coverage, spend, pick ownership. No canonical path form yet.",
    canonical_equivalent: null,
  },
  {
    id: "player_weekly",
    route_template:
      "/api/player-weekly?league={leagueSlug}&season={season}&week={week}",
    description:
      "Historical weekly player fantasy scoring under the resolved season's own settings. No canonical path form yet.",
    canonical_equivalent: null,
  },
  {
    id: "weekly_stats",
    route_template:
      "/api/weekly-stats?league={leagueSlug}&season={season}&week={week}&position={position}",
    description:
      "Raw NFL weekly stats scored through this league's engine, with ranks. No canonical path form yet.",
    canonical_equivalent: null,
  },
  {
    id: "lineups_history",
    route_template: "/api/lineups?league={leagueSlug}&season={season}&week={week}",
    description:
      "Historical weekly roster ownership + starter snapshots, one row per roster-player-week. No canonical path form yet.",
    canonical_equivalent: null,
  },
  {
    id: "player_availability",
    route_template:
      "/api/player-availability?league={leagueSlug}&season={season}",
    description:
      "Weekly player availability evidence with confidence semantics. No canonical path form yet.",
    canonical_equivalent: null,
  },
  {
    id: "manager_availability",
    route_template:
      "/api/manager-availability?league={leagueSlug}&season={season}",
    description:
      "Per-manager factual availability counts. Descriptive only. No canonical path form yet.",
    canonical_equivalent: null,
  },
  {
    id: "value",
    route_template: "/api/value?league={leagueSlug}&player_id={playerId}",
    description:
      "Player values from named, timestamped sources. No fabricated consensus. No canonical path form yet.",
    canonical_equivalent: null,
  },
];

/* -------------------------------------------------------------------------- */
/* League + manager tables                                                     */
/* -------------------------------------------------------------------------- */

export interface DiscoveryLeague {
  league_slug: string;
  league_name: string;
  provider: string;
  season: number;
  config_status: string;
  is_default: boolean;
  known_manager_slugs: string[];
  canonical_urls: {
    overview: string;
    managers: string;
    state: string;
    scoring: string;
    projections: string;
    draft: string;
    snapshot: string;
    transactions: string;
  };
}

export interface DiscoveryManager {
  manager_slug: string;
  sleeper_username: string | null;
  league_slug: string;
  canonical_url: string;
  aliases: string[];
}

export function discoveryLeagues(): DiscoveryLeague[] {
  const { targets } = getLeagueRegistry();
  return targets.map((t) => ({
    league_slug: t.key,
    league_name: t.display_name,
    provider: t.provider,
    season: t.season,
    config_status: leagueConfigStatus(t),
    is_default: t.key === DEFAULT_LEAGUE_KEY,
    known_manager_slugs: t.known_managers,
    canonical_urls: {
      overview: `/api/leagues/${t.key}`,
      managers: `/api/leagues/${t.key}/managers`,
      state: `/api/league/${t.key}/state`,
      scoring: `/api/leagues/${t.key}/scoring`,
      projections: `/api/leagues/${t.key}/projections`,
      draft: `/api/leagues/${t.key}/draft`,
      snapshot: `/api/leagues/${t.key}/snapshot`,
      transactions: `/api/transactions/${t.key}`,
    },
  }));
}

export function discoveryManagers(): DiscoveryManager[] {
  const { targets } = getLeagueRegistry();
  const out: DiscoveryManager[] = [];
  for (const league of targets) {
    for (const slug of league.known_managers) {
      const identity = findRegisteredManager(slug);
      out.push({
        manager_slug: identity?.manager_slug ?? slug,
        sleeper_username: identity?.sleeper_username ?? null,
        league_slug: league.key,
        canonical_url: `/api/leagues/${league.key}/managers/${
          identity?.manager_slug ?? slug
        }`,
        aliases: identity
          ? Array.from(
              new Set([identity.manager_slug, identity.sleeper_username]),
            )
          : [slug],
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Per-manager capability URL map (used by /api/ai AND the manager endpoint)   */
/* -------------------------------------------------------------------------- */

/** Fill a route template with concrete slugs; `{week}` is left as a placeholder. */
export function fillTemplate(
  template: string,
  vars: { leagueSlug?: string; managerSlug?: string; week?: string },
): string {
  return template
    .replace(/\{leagueSlug\}/g, vars.leagueSlug ?? "{leagueSlug}")
    .replace(/\{managerSlug\}/g, vars.managerSlug ?? "{managerSlug}")
    .replace(/\{week\}/g, vars.week ?? "{week}");
}

/**
 * The concrete navigation object a model gets from a single manager URL. Weekly
 * routes keep `{week}` as a literal placeholder the caller substitutes.
 */
export function managerCapabilityUrls(
  leagueSlug: string,
  managerSlug: string,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const cap of CAPABILITIES) {
    if (cap.scope === "manager" || cap.scope === "manager-week") {
      map[cap.id] = fillTemplate(cap.route_template, { leagueSlug, managerSlug });
    }
  }
  // League-wide context this manager also needs to reason.
  map.league_overview = `/api/leagues/${leagueSlug}`;
  map.league_state = `/api/league/${leagueSlug}/state`;
  map.scoring = `/api/leagues/${leagueSlug}/scoring`;
  map.league_projections = `/api/leagues/${leagueSlug}/projections`;
  map.transactions = `/api/transactions/${leagueSlug}`;
  map.history = `/api/history/${leagueSlug}/week/{week}`;
  return map;
}

/* -------------------------------------------------------------------------- */
/* Service description + identity model                                        */
/* -------------------------------------------------------------------------- */

export const SERVICE_DESCRIPTION = {
  name: "Bloodline Bowl Fantasy Football Intelligence Bridge",
  purpose:
    "A read-only JSON bridge that turns multiple Sleeper (and, once authorized, Yahoo) fantasy football leagues into self-describing documents an AI assistant can fetch and reason about: rosters, scoring, projections, draft help, and a weekly decision engine (lineup / start-sit / matchup / waivers).",
  production_base_url: PRODUCTION_BASE_URL,
  github_repository: GITHUB_REPOSITORY,
  read_only: true,
  ai_instructions: [
    "Start at /api/ai. Every URL you need is either listed here or reachable by following links in the responses it points to.",
    "Follow the links and route_templates returned by the API. Do not guess or hand-construct URLs.",
    "Resolve identity in two steps: first the league slug, then the manager slug WITHIN that league. They are different namespaces.",
    "If you are given only a manager username, look it up in registered_managers below (or call /api/leagues/{leagueSlug}/managers) to find its league, then use the canonical manager URL.",
    "A manager who is not a member of the league you name returns an explicit 4xx error — never a different manager. Do not retry with a different league to 'make it work'.",
    "Weekly routes need a {week}. Get the current NFL week from /api/league/{leagueSlug}/state (`state.current_week`).",
    "GitHub is optional. It is for inspecting methodology only; the live bridge is fully usable without it.",
  ],
} as const;

export const IDENTITY_MODEL = {
  league_identity_is_not_manager_identity: true,
  instructions: [
    "League slug (e.g. bloodline-bowl) selects WHICH league. Manager slug (e.g. bijimac) selects WHICH team owner inside it.",
    "Canonical league route: /api/leagues/{leagueSlug}. Canonical manager route: /api/leagues/{leagueSlug}/managers/{managerSlug}.",
    "Membership is validated live on every request. bloodline-bowl + darthmarker does not resolve; devoted-to-the-game + bijimac does not resolve.",
    "There is no cross-league fallback. An unknown or non-member manager is a 4xx, never a silent substitution.",
    "Given only a manager username: find its league via registered_managers or /api/leagues/{leagueSlug}/managers, then descend league → manager → capability.",
  ],
} as const;
