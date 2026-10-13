/**
 * Identity resolution for MCP tool inputs.
 *
 * A chat user says "Devoted to the Game" and "DarthMarker" or "The JSN Bourne
 * Supremacy", not slugs. This module maps such a name to the canonical slug by
 * EXACT normalized match against the league's own published directory, then
 * hands the slug to the bridge route, which performs its usual strict
 * league ≠ manager verification (lib/leagues/resolve.ts).
 *
 * Rules (same spirit as lib/leagues/resolve.ts CRITICAL MANAGER RULES):
 *  - no fuzzy matching, no "closest", no default manager, no commissioner fallback;
 *  - zero matches -> NOT_FOUND with the real candidate list;
 *  - more than one match -> AMBIGUOUS with the candidates, never a pick;
 *  - knowing a slug grants nothing beyond what the public routes already serve
 *    (this deployment is PUBLIC_READ_ONLY — see lib/mcp/contract.ts).
 */

import { listLeagueTargets } from "@/lib/leagues/registry";
import { getNflState, getPlayerIndex } from "@/lib/sleeper/client";
import { callRoute } from "./invoke";
import { num, obj, objs, str, strs, type J } from "./json";

export function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export interface ResolutionError {
  ok: false;
  code: "LEAGUE_NOT_FOUND" | "LEAGUE_AMBIGUOUS" | "MANAGER_NOT_FOUND" | "MANAGER_AMBIGUOUS" | "PLAYER_NOT_FOUND" | "PLAYER_AMBIGUOUS" | "INVALID_INPUT";
  detail: string;
  candidates?: unknown[];
}

/* -------------------------------- leagues -------------------------------- */

export interface LeagueRef {
  ok: true;
  league_slug: string;
  league_name: string;
  provider: string;
  season: number;
}

export function resolveLeagueInput(input: string): LeagueRef | ResolutionError {
  const needle = normalizeName(input ?? "");
  if (!needle) return { ok: false, code: "INVALID_INPUT", detail: "league is required (slug or league name)." };
  const leagues = listLeagueTargets().filter((t) => t.enabled);
  const hits = leagues.filter(
    (t) => normalizeName(t.key) === needle || normalizeName(t.display_name) === needle || t.league_id === input.trim() || t.external_league_id === input.trim(),
  );
  const candidates = leagues.map((t) => ({ league_slug: t.key, league_name: t.display_name, provider: t.provider }));
  if (hits.length === 1) {
    const t = hits[0]!;
    return { ok: true, league_slug: t.key, league_name: t.display_name, provider: t.provider, season: t.season };
  }
  if (hits.length > 1) return { ok: false, code: "LEAGUE_AMBIGUOUS", detail: `"${input}" matches more than one league.`, candidates: hits.map((t) => ({ league_slug: t.key, league_name: t.display_name })) };
  return { ok: false, code: "LEAGUE_NOT_FOUND", detail: `No configured league matches "${input}". Only these leagues are served.`, candidates };
}

/* ------------------------------ league directory ------------------------------ */

export interface DirectoryManager {
  manager_slug: string;
  display_name: string | null;
  provider_username: string | null;
  team_name: string | null;
  canonical_manager_id: string;
  canonical_team_id: string | null;
  is_commissioner: boolean;
  is_co_manager: boolean;
}

export interface PlayerRef {
  name: string;
  position: string | null;
  nfl_team: string | null;
  injury_status: string | null;
}

export interface LeagueDirectory {
  league_slug: string;
  /** Raw canonical state body (the /api/league/{league}/state response). */
  state_body: J;
  managers: DirectoryManager[];
  /** canonical_team_id -> team display label. */
  teams: Map<string, { team_name: string | null; manager_slugs: string[]; manager_names: string[] }>;
  /** canonical_player_id -> name/position/team, for every player the snapshot carries. */
  players: Map<string, PlayerRef>;
  /** Sleeper player id -> canonical player id (canonical ids may be gsis-keyed via the crosswalk). */
  by_sleeper_id: Map<string, string>;
  current_week: number | null;
  loaded_at: number;
}

const DIRECTORY_TTL_MS = 30_000;
const directoryCache = new Map<string, LeagueDirectory>();

export function buildDirectory(leagueSlug: string, stateBody: unknown): LeagueDirectory {
  const body = obj(stateBody);
  const state = obj(body.state);
  const teams = new Map<string, { team_name: string | null; manager_slugs: string[]; manager_names: string[] }>();
  const managerById = new Map<string, J>();
  for (const m of objs(state.managers)) managerById.set(str(m.canonical_manager_id) ?? "", m);
  const teamOfManager = new Map<string, J>();
  for (const t of objs(state.teams)) {
    const ids = strs(t.canonical_manager_ids);
    for (const id of ids) teamOfManager.set(id, t);
    const ms = ids.map((id) => managerById.get(id)).filter((m): m is J => !!m);
    teams.set(str(t.canonical_team_id) ?? "", {
      team_name: str(t.team_name),
      manager_slugs: ms.map((m) => str(m.manager_slug)).filter((s): s is string => !!s),
      manager_names: ms.map((m) => str(m.display_name) ?? str(m.provider_username)).filter((s): s is string => !!s),
    });
  }
  const managers: DirectoryManager[] = objs(state.managers).map((m) => {
    const id = str(m.canonical_manager_id) ?? "";
    const team = teamOfManager.get(id);
    return {
      manager_slug: str(m.manager_slug) ?? "",
      display_name: str(m.display_name),
      provider_username: str(m.provider_username),
      team_name: team ? str(team.team_name) : null,
      canonical_manager_id: id,
      canonical_team_id: team ? str(team.canonical_team_id) : null,
      is_commissioner: m.is_commissioner === true,
      is_co_manager: m.is_co_manager === true,
    };
  }).filter((m) => m.manager_slug);
  const players = new Map<string, PlayerRef>();
  const bySleeperId = new Map<string, string>();
  for (const p of objs(state.players)) {
    const id = str(p.canonical_player_id);
    if (!id) continue;
    const sid = str(obj(p.identifiers).sleeper_id);
    if (sid) bySleeperId.set(sid, id);
    players.set(id, { name: str(p.full_name) ?? id, position: str(p.position), nfl_team: str(p.nfl_team), injury_status: str(p.injury_status) });
  }
  return { league_slug: leagueSlug, state_body: body, managers, teams, players, by_sleeper_id: bySleeperId, current_week: num(obj(state.league).current_week) ?? num(state.week), loaded_at: Date.now() };
}

export interface DirectoryProvenance {
  route: "league_state";
  path: string;
  http_status: number | null;
  upstream_bytes: number | null;
  ms: number;
  cached: boolean;
}

export type DirectoryResult =
  | { ok: true; directory: LeagueDirectory; provenance: DirectoryProvenance }
  | { ok: false; http_status: number | null; detail: string; body: unknown; provenance: DirectoryProvenance };

/**
 * Load the league's canonical state (the same snapshot every weekly route
 * reads) once per 30 s per instance. Used for name resolution and for labelling
 * canonical ids with names — never for analytics.
 */
export async function loadDirectory(leagueSlug: string): Promise<DirectoryResult> {
  const cached = directoryCache.get(leagueSlug);
  const path = `/api/league/${encodeURIComponent(leagueSlug)}/state`;
  if (cached && Date.now() - cached.loaded_at < DIRECTORY_TTL_MS) {
    return { ok: true, directory: cached, provenance: { route: "league_state", path, http_status: 200, upstream_bytes: null, ms: 0, cached: true } };
  }
  const res = await callRoute({ route: "league_state", params: { league: leagueSlug } });
  const provenance: DirectoryProvenance = { route: "league_state", path, http_status: res.http_status, upstream_bytes: res.ok ? res.bytes : null, ms: res.ms, cached: false };
  if (!res.ok) return { ok: false, http_status: res.http_status, detail: res.detail, body: null, provenance };
  if (res.http_status !== 200 || !obj(res.body).state) {
    return { ok: false, http_status: res.http_status, detail: str(obj(res.body).detail) ?? `league state returned HTTP ${res.http_status}`, body: res.body, provenance };
  }
  const directory = buildDirectory(leagueSlug, res.body);
  directoryCache.set(leagueSlug, directory);
  return { ok: true, directory, provenance };
}

export function clearDirectoryCache(): void {
  directoryCache.clear();
}

/* -------------------------------- managers -------------------------------- */

export interface ManagerRef {
  ok: true;
  manager_slug: string;
  matched_on: "manager_slug" | "username" | "display_name" | "team_name" | "unverified_passthrough";
  display_name: string | null;
  team_name: string | null;
}

export function resolveManagerInput(input: string, directory: LeagueDirectory | null): ManagerRef | ResolutionError {
  const raw = (input ?? "").trim();
  const needle = normalizeName(raw);
  if (!needle) return { ok: false, code: "INVALID_INPUT", detail: "manager is required (slug, username, display name or team name)." };
  if (!directory) {
    // Directory unavailable (e.g. provider auth required): pass the literal value to
    // the route, which verifies membership itself and rejects a non-member.
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(raw)) return { ok: false, code: "INVALID_INPUT", detail: "manager must be a slug or username when the league directory is unavailable." };
    return { ok: true, manager_slug: raw.toLowerCase(), matched_on: "unverified_passthrough", display_name: null, team_name: null };
  }
  const fields: Array<[ManagerRef["matched_on"], (m: DirectoryManager) => string | null]> = [
    ["manager_slug", (m) => m.manager_slug],
    ["username", (m) => m.provider_username],
    ["display_name", (m) => m.display_name],
    ["team_name", (m) => m.team_name],
  ];
  for (const [field, get] of fields) {
    const hits = directory.managers.filter((m) => {
      const v = get(m);
      return v != null && normalizeName(v) === needle;
    });
    if (hits.length === 1) {
      const m = hits[0]!;
      return { ok: true, manager_slug: m.manager_slug, matched_on: field, display_name: m.display_name, team_name: m.team_name };
    }
    if (hits.length > 1) {
      return {
        ok: false,
        code: "MANAGER_AMBIGUOUS",
        detail: `"${input}" matches ${hits.length} managers by ${field.replace("_", " ")} (co-managed team or duplicate name). Pass one manager_slug.`,
        candidates: hits.map(managerCandidate),
      };
    }
  }
  return {
    ok: false,
    code: "MANAGER_NOT_FOUND",
    detail: `No manager in ${directory.league_slug} matches "${input}". No other manager is substituted.`,
    candidates: directory.managers.map(managerCandidate),
  };
}

function managerCandidate(m: DirectoryManager) {
  return { manager_slug: m.manager_slug, display_name: m.display_name, team_name: m.team_name };
}

/* -------------------------------- players -------------------------------- */

export interface ResolvedPlayer {
  ok: true;
  sleeper_id: string;
  name: string;
  position: string | null;
  nfl_team: string | null;
  injury_status: string | null;
  matched_on: "id" | "name";
}

export async function resolvePlayerInput(input: string, hints: { position?: string; nfl_team?: string } = {}): Promise<ResolvedPlayer | ResolutionError> {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, code: "INVALID_INPUT", detail: "player is required (name or Sleeper player id)." };
  let index: Awaited<ReturnType<typeof getPlayerIndex>>;
  try {
    index = await getPlayerIndex();
  } catch (error) {
    return { ok: false, code: "PLAYER_NOT_FOUND", detail: `Player directory unavailable: ${error instanceof Error ? error.message : "unknown error"}.` };
  }
  const idForm = raw.replace(/^player:sleeper:/, "");
  const direct = index.get(idForm);
  if (direct) {
    return { ok: true, sleeper_id: idForm, name: direct.full_name, position: direct.position, nfl_team: direct.team, injury_status: direct.injury_status, matched_on: "id" };
  }
  const needle = normalizeName(raw);
  const pos = hints.position?.trim().toUpperCase();
  const team = hints.nfl_team?.trim().toUpperCase();
  let hits = [...index.values()].filter((p) => p.resolved && normalizeName(p.full_name) === needle);
  if (pos) hits = hits.filter((p) => p.position === pos || p.fantasy_positions.includes(pos));
  if (team) hits = hits.filter((p) => p.team === team);
  // Prefer players currently on an NFL roster when the name is shared with a retired/inactive player.
  if (hits.length > 1) {
    const rostered = hits.filter((p) => p.team && p.active !== false);
    if (rostered.length >= 1) hits = rostered;
  }
  if (hits.length === 1) {
    const p = hits[0]!;
    return { ok: true, sleeper_id: p.player_id, name: p.full_name, position: p.position, nfl_team: p.team, injury_status: p.injury_status, matched_on: "name" };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      code: "PLAYER_AMBIGUOUS",
      detail: `"${input}" matches ${hits.length} players. Pass position or nfl_team, or a Sleeper player id.`,
      candidates: hits.slice(0, 10).map((p) => ({ sleeper_id: p.player_id, name: p.full_name, position: p.position, nfl_team: p.team })),
    };
  }
  return { ok: false, code: "PLAYER_NOT_FOUND", detail: `No player named "${input}" (exact full-name match). Check spelling or pass a Sleeper player id.` };
}

/** "player:sleeper:9228" -> "9228"; other canonical forms -> null. */
export function sleeperIdOf(canonicalId: string): string | null {
  const m = /^player:sleeper:(.+)$/.exec(canonicalId);
  return m ? m[1]! : null;
}

/* ------------------------------- current week ------------------------------- */

export interface WeekResolution {
  week: number | null;
  source: "requested" | "league_state" | "sleeper_nfl_state" | "unresolved";
}

/**
 * Week for a weekly tool. A requested week is passed through UNCHANGED (the
 * route rejects a non-current week; the connector never substitutes the current
 * week for a historical request). With no week, the league's canonical state
 * week is used, then Sleeper's NFL state — the same source the weekly engine's
 * current-week gate uses.
 */
export async function resolveWeek(requested: number | undefined, directory: LeagueDirectory | null): Promise<WeekResolution> {
  if (requested !== undefined) return { week: requested, source: "requested" };
  if (directory?.current_week) return { week: directory.current_week, source: "league_state" };
  try {
    const state = await getNflState();
    const w = Number(state?.week);
    if (Number.isInteger(w) && w >= 1) return { week: w, source: "sleeper_nfl_state" };
  } catch {
    /* fall through */
  }
  return { week: null, source: "unresolved" };
}

/** Label a canonical player id with its name for chat output. Unknown ids keep `name: null`. */
export function playerLabel(directory: LeagueDirectory | null, canonicalId: unknown): J | null {
  const id = str(canonicalId);
  if (!id) return null;
  const p = directory?.players.get(id);
  return p ? { id, name: p.name, position: p.position, nfl_team: p.nfl_team } : { id, name: null };
}

export function teamLabel(directory: LeagueDirectory | null, canonicalTeamId: unknown): J | null {
  const id = str(canonicalTeamId);
  if (!id) return null;
  const t = directory?.teams.get(id);
  return t ? { team_id: id, team_name: t.team_name, managers: t.manager_names, manager_slugs: t.manager_slugs } : { team_id: id, team_name: null };
}

