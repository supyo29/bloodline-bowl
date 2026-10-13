/**
 * `search` / `fetch` — the retrieval pair ChatGPT deep research and read-only
 * connector modes call (OpenAI requires exactly these names and shapes).
 *
 * They add no new analytics: `search` maps a free-text question onto document
 * ids for existing tools (league, manager and topic recognised by EXACT
 * normalized name containment), and `fetch` runs that tool and returns its
 * envelope as the document text. Unrecognised names return league-level
 * documents, never a guessed manager.
 */

import { listLeagueTargets } from "@/lib/leagues/registry";
import { absoluteUrl } from "@/lib/discovery";
import { loadDirectory, normalizeName } from "./identity";

export type DocKind = "league" | "managers" | "scoring" | "team" | "weekly" | "start_sit" | "matchup" | "waivers" | "roster" | "trades";

/** Document kind -> the tool that renders it and the public route a citation points at. */
export const DOC_KINDS: Record<DocKind, { tool: string; title: string; needsManager: boolean; route: (l: string, m?: string) => string }> = {
  league: { tool: "bloodline_get_league", title: "League overview and standings", needsManager: false, route: (l) => `/api/league/${l}/state` },
  managers: { tool: "bloodline_list_managers", title: "Managers", needsManager: false, route: (l) => `/api/leagues/${l}/managers` },
  scoring: { tool: "bloodline_get_scoring", title: "Scoring rules", needsManager: false, route: (l) => `/api/leagues/${l}/scoring` },
  team: { tool: "bloodline_get_team", title: "Team, roster and record", needsManager: true, route: (l, m) => `/api/context/${l}/${m}` },
  weekly: { tool: "bloodline_weekly_analysis", title: "Weekly team analysis", needsManager: true, route: (l, m) => `/api/leagues/${l}/managers/${m}` },
  start_sit: { tool: "bloodline_start_sit", title: "Start/sit and lineup", needsManager: true, route: (l, m) => `/api/leagues/${l}/managers/${m}` },
  matchup: { tool: "bloodline_matchup_analysis", title: "Matchup analysis", needsManager: true, route: (l, m) => `/api/leagues/${l}/managers/${m}` },
  waivers: { tool: "bloodline_waiver_analysis", title: "Waiver wire", needsManager: true, route: (l, m) => `/api/leagues/${l}/managers/${m}` },
  roster: { tool: "bloodline_analyze_roster", title: "Roster health and season outlook", needsManager: true, route: (l, m) => `/api/leagues/${l}/managers/${m}/roster-health` },
  trades: { tool: "bloodline_trade_discovery", title: "Trade opportunities", needsManager: true, route: (l, m) => `/api/leagues/${l}/managers/${m}` },
};

const TOPIC_WORDS: Array<[DocKind, RegExp]> = [
  ["waivers", /\b(waivers?|free agents?|pick ?ups?|faab|add|drop)\b/i],
  ["start_sit", /\b(start|sit|bench|lineup)\b/i],
  ["matchup", /\b(matchup|opponent|versus|vs\.?|win prob\w*)\b/i],
  ["trades", /\btrad(e|es|ing)\b/i],
  ["scoring", /\b(scoring|scored?|ppr|points per)\b/i],
  ["roster", /\b(roster|depth|byes?|playoffs?|outlook|strength|weak\w*)\b/i],
  ["league", /\b(standings?|rank\w*)\b/i],
];

export interface SearchResult {
  id: string;
  title: string;
  url: string;
}

export function docId(kind: DocKind, league: string, manager?: string): string {
  return ["bb", kind, league, ...(manager ? [manager] : [])].join(":");
}

export function parseDocId(id: string): { kind: DocKind; league: string; manager?: string } | null {
  const parts = id.split(":");
  if (parts[0] !== "bb" || parts.length < 3 || parts.length > 4) return null;
  const kind = parts[1] as DocKind;
  if (!(kind in DOC_KINDS)) return null;
  const spec = DOC_KINDS[kind];
  if (spec.needsManager !== (parts.length === 4)) return null;
  return { kind, league: parts[2]!, ...(parts[3] ? { manager: parts[3] } : {}) };
}

function topicsOf(query: string): DocKind[] {
  return TOPIC_WORDS.filter(([, re]) => re.test(query)).map(([k]) => k);
}

/** The normalized name occurs in the normalized query (names of 3+ chars only). A hit only proposes a document id; fetch still resolves identity strictly. */
function mentions(queryNorm: string, name: string | null): boolean {
  if (!name) return false;
  const n = normalizeName(name);
  return n.length >= 3 && queryNorm.includes(n);
}

export async function searchDocuments(query: string): Promise<SearchResult[]> {
  const q = normalizeName(query);
  const topics = topicsOf(query);
  const leagues = listLeagueTargets().filter((t) => t.enabled);
  const named = leagues.filter((t) => mentions(q, t.key) || mentions(q, t.display_name));
  const dirs = await Promise.all((named.length ? named : leagues).map(async (t) => ({ t, dir: await loadDirectory(t.key) })));
  const results: SearchResult[] = [];
  const push = (kind: DocKind, league: string, leagueName: string, manager?: { slug: string; label: string }) => {
    const spec = DOC_KINDS[kind];
    results.push({
      id: docId(kind, league, manager?.slug),
      title: `${spec.title} — ${manager ? `${manager.label}, ` : ""}${leagueName}`,
      url: absoluteUrl(spec.route(league, manager?.slug)),
    });
  };
  for (const { t, dir } of dirs) {
    const managers = dir.ok
      ? dir.directory.managers.filter((m) => mentions(q, m.manager_slug) || mentions(q, m.display_name) || mentions(q, m.provider_username) || mentions(q, m.team_name))
      : [];
    if (managers.length) {
      for (const m of managers) {
        const label = m.team_name ? `${m.display_name ?? m.manager_slug} (${m.team_name})` : m.display_name ?? m.manager_slug;
        const kinds: DocKind[] = topics.filter((k) => DOC_KINDS[k].needsManager);
        for (const k of kinds.length ? kinds : (["weekly", "team", "roster"] as DocKind[])) push(k, t.key, t.display_name, { slug: m.manager_slug, label });
      }
      if (topics.includes("scoring")) push("scoring", t.key, t.display_name);
    } else if (named.length) {
      const kinds = topics.filter((k) => !DOC_KINDS[k].needsManager);
      for (const k of kinds.length ? kinds : (["league", "managers", "scoring"] as DocKind[])) push(k, t.key, t.display_name);
    }
  }
  if (!results.length) for (const t of leagues) push("league", t.key, t.display_name);
  return results.slice(0, 20);
}
