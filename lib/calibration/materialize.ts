/**
 * Calibration ledger materializer. Reads durable evidence (projection snapshots, Start/Sit captures, weather), the NFL
 * schedule/kickoffs and final provider stats; assembles cases with the PURE builder; writes insert-only, idempotently.
 *
 * Gate: a case materializes only for a game whose schedule status is "complete" (per-game — a partially played week
 * still materializes its finished games). A re-run over unchanged evidence writes nothing; changed evidence writes a
 * new REVISION (never an update, never a duplicate).
 */
import { getPlayerIndex } from "@/lib/sleeper/client";
import { loadWeekActuals } from "@/lib/weekly-audit/scoring-actuals";
import { defaultWeeklyAuditRest, readStartSitCaptures } from "@/lib/persistence/supabase/weekly-audit-store";
import type { SupabaseRest } from "@/lib/persistence/supabase/rest";
import { normalizeTeamCode } from "@/lib/canonical/team-codes";
import { buildWeekCases, type BuildWeekInput, type BuildWeekResult, type LeagueScoringInput, type PlayerIdentity, type WeekActualsLike } from "./case-builder";
import { loadNflGames } from "./games";
import { scoringExactness } from "./outcome";
import { readCaseHeads, writeCases, writeFootballOutcomes, writeGames, type WriteCounts } from "./store";
import type { WeatherSnapshotRow } from "./weather";
import type { NflGame, ProjectionCandidate } from "./types";

interface SnapshotMeta { artifact_id: string; content_hash: string; league_slug: string; scoring_fingerprint: string; request_fingerprint: string; source: string; model_version: string; recorded_at: string; warnings: string[] }
interface SnapshotPlayer { canonical_player_id: string; projection: Record<string, unknown>; resolved_player: Record<string, unknown> | null }
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function readSnapshotMetas(rest: SupabaseRest, league: string, season: number, week: number): Promise<SnapshotMeta[]> {
  return rest.select<SnapshotMeta>("bridge_projection_snapshots", { filter: { league_slug: `eq.${league}`, season: `eq.${season}`, week: `eq.${week}` }, select: "artifact_id,content_hash,league_slug,scoring_fingerprint,request_fingerprint,source,model_version,recorded_at,warnings", order: "recorded_at.asc", limit: 500 });
}
export async function readSnapshotPlayers(rest: SupabaseRest, artifactId: string): Promise<SnapshotPlayer[]> {
  const all: SnapshotPlayer[] = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await rest.select<SnapshotPlayer>("bridge_projection_snapshot_players", { filter: { artifact_id: `eq.${artifactId}` }, select: "canonical_player_id,projection,resolved_player", order: "canonical_player_id.asc", limit: 1000, offset });
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

export function identityFromSnapshotRow(p: SnapshotPlayer): PlayerIdentity {
  const rp = p.resolved_player ?? {};
  const ids = (rp.identifiers ?? {}) as Record<string, unknown>;
  const provider_ids: Record<string, string> = {};
  for (const [k, v] of Object.entries(ids)) if (k.endsWith("_id") && (typeof v === "string" || typeof v === "number")) provider_ids[k] = String(v);
  return {
    canonical_player_id: p.canonical_player_id, sleeper_id: provider_ids.sleeper_id ?? null, provider_ids,
    name: str(rp.full_name), position: str(rp.position) ?? str(p.projection.position), nfl_team: normalizeTeamCode(str(rp.nfl_team) ?? str(p.projection.nfl_team)),
    resolved: !p.canonical_player_id.startsWith("unresolved:"),
  };
}

export function candidateFromSnapshotRow(meta: SnapshotMeta, p: SnapshotPlayer, rawScoring: Record<string, number> | null): ProjectionCandidate {
  const pr = p.projection;
  const warnings = Array.isArray(pr.warnings) ? (pr.warnings as unknown[]).filter((w): w is string => typeof w === "string") : [];
  const position = str(pr.position);
  return {
    kind: "PROJECTION_SNAPSHOT", artifact_id: meta.artifact_id, content_hash: meta.content_hash, request_fingerprint: meta.request_fingerprint, recorded_at: meta.recorded_at,
    league_slug: meta.league_slug, scoring_fingerprint: meta.scoring_fingerprint, source: str(pr.source) ?? meta.source, model_version: str(pr.model_version) ?? meta.model_version,
    projected_points: numOrNull(pr.projected_points), floor_points: numOrNull(pr.floor_points), ceiling_points: numOrNull(pr.ceiling_points), std_dev: numOrNull(pr.std_dev),
    expected_availability: numOrNull(pr.expected_availability), injury_status: str(pr.injury_status), warnings,
    nfl_team: normalizeTeamCode(str(pr.nfl_team)), opponent: normalizeTeamCode(str(pr.opponent)), position,
    scoring_exactness: scoringExactness(position, rawScoring, warnings),
    detail: { projection_status: str(pr.projection_status), uncertainty_source: str(pr.uncertainty_source) },
  };
}

export function candidatesFromCapture(cap: { capture_id: string; content_hash: string | null; captured_at: string; league_slug: string; scoring_fingerprint: string | null; baseline_projection_version: string | null; capture_kind: string; lock_verdict: string | null; record: { adjustments?: unknown } }, rawScoring: Record<string, number> | null): Array<{ canonical: string; c: ProjectionCandidate }> {
  const adjustments = (Array.isArray(cap.record.adjustments) ? cap.record.adjustments : []) as Array<{ canonical_player_id?: string; position?: string; nfl_team?: string; opponent?: string; baseline_projection?: number | null }>;
  const out: Array<{ canonical: string; c: ProjectionCandidate }> = [];
  for (const a of adjustments) {
    if (!a.canonical_player_id || a.baseline_projection == null || !cap.scoring_fingerprint) continue;
    const position = a.position ?? null;
    out.push({ canonical: a.canonical_player_id, c: {
      kind: "STARTSIT_CAPTURE", artifact_id: cap.capture_id, content_hash: cap.content_hash, request_fingerprint: null, recorded_at: cap.captured_at,
      league_slug: cap.league_slug, scoring_fingerprint: cap.scoring_fingerprint, source: "startsit_capture_baseline", model_version: cap.baseline_projection_version ?? "unknown",
      projected_points: a.baseline_projection, floor_points: null, ceiling_points: null, std_dev: null, expected_availability: null, injury_status: null,
      warnings: ["capture_baseline_has_no_floor_ceiling_or_availability"], nfl_team: normalizeTeamCode(a.nfl_team), opponent: normalizeTeamCode(a.opponent), position,
      scoring_exactness: scoringExactness(position, rawScoring),
      detail: { capture_kind: cap.capture_kind, lock_verdict: cap.lock_verdict },
    } });
  }
  return out;
}

/** Fallback identities never override this week's own snapshot identities. Pure. */
export function mergeFallbackIdentities(primary: Map<string, PlayerIdentity>, fallback: ReadonlyMap<string, PlayerIdentity>, source: string): number {
  let added = 0;
  for (const [id, i] of fallback) if (!primary.has(id)) { primary.set(id, { ...i, identity_source: source }); added++; }
  return added;
}

/**
 * Identity precedence (pure): this week's snapshot rows > crosswalk fallback from another week (ONLY when this week has no
 * snapshot identities of its own) > capture-only identities (sparse: they never carry a crosswalk sleeper id).
 * The fallback decision depends on SNAPSHOT identities alone — capture identities must never suppress it.
 */
export function resolveWeekIdentities(args: { snapshot: ReadonlyMap<string, PlayerIdentity>; captureOnly: ReadonlyMap<string, PlayerIdentity>; fallback: ReadonlyMap<string, PlayerIdentity> | null; fallbackSource: string | null }): { identities: Map<string, PlayerIdentity>; fallback_used: boolean } {
  const identities = new Map(args.snapshot);
  let used = false;
  if (identities.size === 0 && args.fallback && args.fallbackSource) { mergeFallbackIdentities(identities, args.fallback, args.fallbackSource); used = identities.size > 0; }
  for (const [id, i] of args.captureOnly) if (!identities.has(id)) identities.set(id, i);
  return { identities, fallback_used: used };
}

/** Provider stat rows for offensive players that NO crosswalk identity (this week's or fallback) covers -> explicit unresolved identities. Pure. */
export function unresolvedIdentitiesFromStats(
  rawByPlayer: ReadonlyMap<string, Record<string, number>>, identities: ReadonlyMap<string, PlayerIdentity>,
  index: ReadonlyMap<string, { position?: string | null; team?: string | null; full_name?: string | null }>,
): PlayerIdentity[] {
  const known = new Set([...identities.values()].map((i) => i.sleeper_id?.toUpperCase()).filter(Boolean) as string[]);
  const out: PlayerIdentity[] = [];
  for (const [sid, row] of rawByPlayer) {
    if (known.has(sid) || !/^\d+$/.test(sid)) continue;
    const pl = index.get(sid) ?? index.get(sid.toLowerCase());
    const pos = pl?.position ?? null;
    if (!pl || !pos || !["QB", "RB", "WR", "TE", "K"].includes(pos)) continue;
    if (!Object.keys(row).some((k) => /^(pass_att|rush_att|rec_tgt|rec|fga|xpa)$/.test(k))) continue;
    out.push({ canonical_player_id: `unresolved:sleeper:${sid}`, sleeper_id: sid, provider_ids: { sleeper_id: sid }, name: pl.full_name ?? null, position: pos, nfl_team: normalizeTeamCode(pl.team ?? null), resolved: false });
  }
  return out;
}

export interface MaterializeArgs { season: number; week: number; leagues: LeagueScoringInput[]; rest: SupabaseRest | null; write: boolean; now?: string }
export interface MaterializeSummary extends Omit<BuildWeekResult, "cases" | "football_outcomes"> {
  season: number; week: number; games_total: number; games_final: number; games_missing_kickoff: number;
  cases_built: number; football_outcomes_built: number; wrote: boolean;
  writes: { games: WriteCounts | null; football_outcomes: WriteCounts | null; cases: WriteCounts | null };
  artifacts_read: Record<string, number>; identity_fallback: string | null; captures_read: number; stats_available: boolean; identities: number;
}

export async function materializeCalibrationWeek(args: MaterializeArgs): Promise<{ summary: MaterializeSummary; built: BuildWeekResult; games: NflGame[] }> {
  const now = args.now ?? new Date().toISOString();
  const rest = args.rest ?? defaultWeeklyAuditRest();
  if (!rest) throw new Error("calibration materializer requires Supabase (service role) configuration");
  const { games, missing_kickoff } = await loadNflGames(args.season, args.week);
  const finalGames = games.filter((g) => g.status === "complete" || /^(postponed|cancel+ed)$/.test(g.status));
  const latestFinalKickoff = finalGames.reduce((m, g) => Math.max(m, Date.parse(g.kickoff_at)), 0);

  const snapshotIdentities = new Map<string, PlayerIdentity>();
  const captureIdentities = new Map<string, PlayerIdentity>();
  const candidates = new Map<string, ProjectionCandidate[]>();
  const push = (league: string, canonical: string, c: ProjectionCandidate) => { const k = `${league}|${canonical}`; (candidates.get(k) ?? candidates.set(k, []).get(k)!).push(c); };
  const artifactsRead: Record<string, number> = {};
  let capturesRead = 0;

  for (const league of args.leagues) {
    // only artifacts recorded before the latest finished kickoff can ever be evidence
    const metas = (await readSnapshotMetas(rest, league.league_slug, args.season, args.week)).filter((m) => Date.parse(m.recorded_at) < latestFinalKickoff);
    artifactsRead[league.league_slug] = metas.length;
    for (const meta of metas) {
      for (const p of await readSnapshotPlayers(rest, meta.artifact_id)) {
        if (!snapshotIdentities.has(p.canonical_player_id)) snapshotIdentities.set(p.canonical_player_id, identityFromSnapshotRow(p));
        push(league.league_slug, p.canonical_player_id, candidateFromSnapshotRow(meta, p, league.raw_scoring));
      }
    }
    const caps = (await readStartSitCaptures(rest, args.season, args.week)).filter((r) => r.league_slug === league.league_slug) as unknown as Array<Parameters<typeof candidatesFromCapture>[0]>;
    capturesRead += caps.length;
    for (const cap of caps) for (const { canonical, c } of candidatesFromCapture(cap, league.raw_scoring)) {
      push(league.league_slug, canonical, c);
      if (!captureIdentities.has(canonical)) captureIdentities.set(canonical, { canonical_player_id: canonical, sleeper_id: /^player:sleeper:(.+)$/.exec(canonical)?.[1]?.toUpperCase() ?? null, provider_ids: {}, name: null, position: c.position, nfl_team: c.nfl_team, resolved: true });
    }
  }

  const actualsRaw = await loadWeekActuals(args.season, args.week).catch(() => null);
  const actuals: WeekActualsLike | null = actualsRaw && actualsRaw.raw.size ? actualsRaw : null;

  // A week with no snapshot rows of its own (e.g. before the durable snapshot tables existed) still has stable crosswalk ids:
  // borrow identities from the nearest other-week snapshot of any league. Never used for projection evidence.
  let fallbackMap: Map<string, PlayerIdentity> | null = null, fallbackSource: string | null = null;
  if (snapshotIdentities.size === 0) {
    const others = await rest.select<SnapshotMeta & { week: number }>("bridge_projection_snapshots", { filter: { season: `eq.${args.season}`, week: `neq.${args.week}` }, select: "artifact_id,week,recorded_at,league_slug,scoring_fingerprint,request_fingerprint,source,model_version,content_hash,warnings", order: "recorded_at.desc", limit: 1 });
    if (others[0]) {
      fallbackMap = new Map();
      for (const p of await readSnapshotPlayers(rest, others[0].artifact_id)) fallbackMap.set(p.canonical_player_id, identityFromSnapshotRow(p));
      fallbackSource = `crosswalk_fallback:${others[0].artifact_id}(week ${others[0].week})`;
    }
  }
  const resolved = resolveWeekIdentities({ snapshot: snapshotIdentities, captureOnly: captureIdentities, fallback: fallbackMap, fallbackSource });
  const identities = resolved.identities;
  const identityFallback = resolved.fallback_used ? fallbackSource : null;

  // Provider stat rows for offensive players NO crosswalk identity covers: explicit UNRESOLVED_IDENTITY cases.
  if (actuals) {
    const index = await getPlayerIndex().catch(() => null);
    if (index) for (const i of unresolvedIdentitiesFromStats(actuals.raw, identities, index)) identities.set(i.canonical_player_id, i);
  }

  const weather = await rest.select<WeatherSnapshotRow>("nfl_game_weather_snapshots", { filter: { season: `eq.${args.season}`, week: `eq.${args.week}` }, select: "id,season,week,game_id,home_team,away_team,source_name,source_timestamp,retrieved_at,roof,temp,wind,weather_status,weather_risk_score", limit: 1000 });
  const existing = await readCaseHeads(rest, args.season, args.week);

  const input: BuildWeekInput = { season: args.season, week: args.week, now, stats_source: "sleeper_weekly_stats", games, leagues: args.leagues, identities, candidates, actuals, weather, existing };
  const built = buildWeekCases(input);

  const writes: MaterializeSummary["writes"] = { games: null, football_outcomes: null, cases: null };
  if (args.write) {
    writes.games = await writeGames(rest, finalGames);
    writes.football_outcomes = await writeFootballOutcomes(rest, built.football_outcomes);
    writes.cases = await writeCases(rest, built.cases);
  }
  const { cases, football_outcomes, ...counts } = built;
  return {
    built, games,
    summary: { ...counts, season: args.season, week: args.week, games_total: games.length + missing_kickoff.length, games_final: finalGames.length, games_missing_kickoff: missing_kickoff.length,
      cases_built: cases.length, football_outcomes_built: football_outcomes.length, wrote: args.write, writes, artifacts_read: artifactsRead, identity_fallback: identityFallback, captures_read: capturesRead, stats_available: !!actuals, identities: identities.size },
  };
}
