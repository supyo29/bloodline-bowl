/**
 * W2.P2 — prospective capture: build immutable Role Shadow records from the production champion forecasts and live-frozen Role forecasts.
 *
 * ISOLATION CONTRACT (pinned by test/role-shadow-isolation.test.ts):
 *   - This module OBSERVES approved production outputs (the canonical weekly forecast batch) and writes independent research records. It does not
 *     import any production decision code, does not mutate the forecasts it is given, and nothing in `lib/weekly`, `lib/lineup`, `lib/waiver*`,
 *     `lib/trades` or any route imports it.
 *   - It is OPT-IN: `ROLE_SHADOW_CAPTURE=1` (exactly). Any other value, or an unset variable, is a complete no-op (no context build, no database access).
 *   - It FAILS SAFE: every failure (database down, a league that will not build, one malformed player) is counted and reported; nothing here can
 *     throw into a caller, and no production recommendation depends on it.
 *   - It never weakens the evidence rules to succeed: a candidate whose evidence is late, un-kickoff-able, identity-conflicted or incoherent is REJECTED.
 */

import type { CanonicalWeeklyPlayerForecast } from "@/lib/weekly/forecast/schema";
import { normalizeTeamCode } from "@/lib/canonical/team-codes";
import { roleFeatures, type InjuryEvidenceRecord, type RoleFeatureSource } from "./arms";
import { buildRecord, type JoinMethod, type RoleCaptureKind, type RoleShadowRecord } from "./record";
import { preregHashOk } from "./g3";
import { SHADOW_POSITIONS, verifyFrozenIntegrity, type RoleConfidence } from "./spec";
import type { RoleShadowStore, WriteStatus } from "./store";

export const ROLE_SHADOW_FLAG = "ROLE_SHADOW_CAPTURE";
/** Strictly "1": no truthy-string guessing for a flag that gates a persistent write path. */
export const roleShadowCaptureEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env[ROLE_SHADOW_FLAG] === "1";

/** Structural subset of `RoleForecast` (lib/role-calibration/types.ts) — production-side code is not needed to describe it. */
export interface RoleForecastLike extends RoleFeatureSource {
  forecast_id: string; forecast_version: string; gsis_id: string | null; sleeper_id: string | null; nfl_team: string | null; position: string;
  nfl_game_id: string | null; kickoff_at: string | null; capture_kind: RoleCaptureKind; as_of_at: string; data_cutoff_at: string | null; confidence: RoleConfidence;
  availability: { designation: string };
}

export interface LeagueWeekInput {
  league_slug: string; provider: string; season: number; week: number;
  raw_scoring: Record<string, number> | null; scoring_fingerprint: string | null;
  league_snapshot_id: string | null; forecast_identity_id: string | null;
  forecasts: readonly CanonicalWeeklyPlayerForecast[];
}

export interface LeagueLoadFailure { league_slug: string; failure: string }
const isFailure = (x: LeagueWeekInput | LeagueLoadFailure): x is LeagueLoadFailure => "failure" in x;

export interface Counters {
  candidates: number; not_applicable_position: number; no_role_forecast: number; ambiguous_identity: number; identity_conflict: number;
  rejected_late: number; rejected_no_kickoff: number; rejected_incoherent: number; built: number;
}
export const emptyCounters = (): Counters => ({ candidates: 0, not_applicable_position: 0, no_role_forecast: 0, ambiguous_identity: 0, identity_conflict: 0, rejected_late: 0, rejected_no_kickoff: 0, rejected_incoherent: 0, built: 0 });

interface RoleIndex { byGsis: Map<string, RoleForecastLike>; bySleeper: Map<string, RoleForecastLike[]> }
function indexRole(list: readonly RoleForecastLike[]): RoleIndex {
  const byGsis = new Map<string, RoleForecastLike>();
  const bySleeper = new Map<string, RoleForecastLike[]>();
  for (const r of list) {
    if (r.gsis_id) byGsis.set(r.gsis_id, r);
    if (r.sleeper_id) { const a = bySleeper.get(r.sleeper_id); if (a) a.push(r); else bySleeper.set(r.sleeper_id, [r]); }
  }
  return { byGsis, bySleeper };
}

/** The injury evidence that reproduces this forecast's availability treatment (explicit tier / workload only; a proxy tier is re-derived by the model). */
export function injuryEvidenceOf(f: CanonicalWeeklyPlayerForecast): InjuryEvidenceRecord {
  const im = f.injury_model;
  const wl = im.workload_if_active;
  return {
    source_status: im.source_status, position: f.position, source_points: f.projection.source_points, source_semantics: im.source_projection_injury_semantics,
    practice: im.evidence.practice ?? null, official_inactive: im.evidence.official_inactive ?? null, official_active: im.evidence.official_active ?? null,
    returning_from_injury: im.evidence.returning_from_injury ?? null, role_tier: im.evidence.role_tier_basis === "EXPLICIT" ? im.evidence.role_tier : null,
    expected_workload: wl.basis.startsWith("EXPLICIT_EVIDENCE") && wl.expected_fraction != null ? { fraction: wl.expected_fraction, ...(wl.lower_bound != null ? { lower: wl.lower_bound } : {}), ...(wl.upper_bound != null ? { upper: wl.upper_bound } : {}) } : null,
    observed_at: im.evidence.observed_at ?? null, mode: im.mode,
  };
}

const earliest = (a: string | null | undefined, b: string | null | undefined): { at: string | null; basis: NonNullable<RoleShadowRecord["game"]["kickoff_basis"]> | null } => {
  const x = a ? Date.parse(a) : NaN;
  const y = b ? Date.parse(b) : NaN;
  if (Number.isFinite(x) && Number.isFinite(y)) return { at: new Date(Math.min(x, y)).toISOString(), basis: "MIN_OF_CHAMPION_AND_ROLE" };
  if (Number.isFinite(x)) return { at: new Date(x).toISOString(), basis: "CHAMPION_ONLY" };
  if (Number.isFinite(y)) return { at: new Date(y).toISOString(), basis: "ROLE_ONLY" };
  return { at: null, basis: null };
};

/** Pure: one league-week of champion forecasts + the live Role forecasts -> records (or counted rejections). Never mutates its inputs. */
export function buildLeagueWeekRecords(input: LeagueWeekInput, roleForecasts: readonly RoleForecastLike[], nowMs: number, invocation: RoleShadowRecord["provenance"]["invocation"] = "CRON"): { records: RoleShadowRecord[]; counters: Counters } {
  const idx = indexRole(roleForecasts);
  const counters = emptyCounters();
  const records: RoleShadowRecord[] = [];
  const capturedAt = new Date(nowMs).toISOString();
  for (const f of input.forecasts) {
    counters.candidates++;
    const pos = (f.position ?? "").toUpperCase();
    if (!(SHADOW_POSITIONS as readonly string[]).includes(pos)) { counters.not_applicable_position++; continue; }

    // ---- identity join: gsis first; else the Role profile's own sleeper id (unique only). The crosswalk is NOT consulted or repaired here. ----
    let rf: RoleForecastLike | undefined;
    let join: JoinMethod | null = null;
    const gsis = f.identifiers.gsis_id;
    if (gsis && idx.byGsis.has(gsis)) { rf = idx.byGsis.get(gsis); join = "GSIS"; }
    else if (f.identifiers.sleeper_id) {
      const c = idx.bySleeper.get(f.identifiers.sleeper_id);
      if (c && c.length === 1) { rf = c[0]; join = "SLEEPER_ID_VIA_PROFILE"; }
      else if (c && c.length > 1) { counters.ambiguous_identity++; continue; }
    }
    if (!rf || !join || !rf.gsis_id) { counters.no_role_forecast++; continue; }
    // temporal identity: a position or team disagreement means one side is stale; never score a conflicted identity
    const fTeam = normalizeTeamCode(f.team ?? null);
    const rTeam = normalizeTeamCode(rf.nfl_team ?? null);
    if (rf.position !== pos || (fTeam && rTeam && fTeam !== rTeam)) { counters.identity_conflict++; continue; }

    const ko = earliest(f.game_status.kickoff_at, rf.kickoff_at);
    const inj = f.injury_model;
    const r = buildRecord({
      capture_class: rf.capture_kind === "LIVE_CAPTURED" ? "LIVE_CAPTURED" : "HISTORICALLY_RECONSTRUCTED",
      captured_at: capturedAt, invocation,
      season: input.season, week: input.week, league_slug: input.league_slug, provider: input.provider,
      player: { canonical_player_id: f.canonical_player_id, gsis_id: rf.gsis_id, sleeper_id: f.identifiers.sleeper_id ?? null, name: null, position: pos, team: fTeam ?? rTeam, opponent: f.opponent ?? null, join_method: join },
      game: { game_id: f.game_status.game_id ?? rf.nfl_game_id ?? null, kickoff_at: ko.at, kickoff_basis: ko.basis },
      timing: { source_observed_at: f.freshness.source_observed_at, forecast_composed_at: f.freshness.forecast_composed_at, role_as_of_at: rf.as_of_at, role_data_cutoff_at: rf.data_cutoff_at },
      scoring_fingerprint: input.scoring_fingerprint, raw_scoring: input.raw_scoring,
      champion: {
        forecast_model_version: f.model_version, source: f.provenance.projection_provider, source_version: f.provenance.source_version,
        source_points: f.projection.source_points, conditional_active_points: f.projection.conditional_active_points, expected_points: f.projection.expected_points,
        value_state: f.value_state, certification_state: f.certification.state, basis: f.projection.expected_points_basis,
        injury: { normalized_state: inj.normalized_state, availability_state: inj.availability_state, probability_active: inj.probability_active, embedded_fraction: inj.embedded_fraction_assumed, mode: inj.mode, model_version: inj.model_version, prior_version: inj.prior_version, evidence: injuryEvidenceOf(f) },
      },
      role: { forecast_id: rf.forecast_id, forecast_version: rf.forecast_version, capture_kind: rf.capture_kind, confidence: rf.confidence, designation: rf.availability.designation, features: roleFeatures(rf) },
      lineage: { league_snapshot_id: input.league_snapshot_id, source_observation_id: f.freshness.source_observation_id, forecast_identity_id: input.forecast_identity_id, snapshot_artifact_id: f.provenance.snapshot.artifact_id },
    });
    if (!r.record) {
      const why = r.rejected.join(" | ");
      if (/^NO_KICKOFF/.test(why)) counters.rejected_no_kickoff++;
      else if (/not strictly before kickoff/.test(why)) counters.rejected_late++;
      else counters.rejected_incoherent++;
      continue;
    }
    counters.built++;
    records.push(r.record);
  }
  return { records, counters };
}

export interface RunSummary {
  status: "DISABLED" | "INTEGRITY_FAILURE" | "NOT_CONFIGURED" | "OK" | "PARTIAL";
  flag: { name: string; enabled: boolean };
  dry_run: boolean;
  integrity?: { ok: boolean; mismatches: string[]; g3_prereg_ok: boolean };
  store?: { kind: string; durable: boolean } | null;
  leagues: Array<{ league_slug: string; ok: boolean; code?: string; counters?: Counters; by_status?: Partial<Record<WriteStatus, number>> }>;
  totals: { counters: Counters; by_status: Partial<Record<WriteStatus, number>> };
  failures: number;
}

export interface RunDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** null = persistence unavailable (reported NOT_CONFIGURED; nothing is written) */
  store: RoleShadowStore | null;
  loadLeagueWeeks: () => Promise<Array<LeagueWeekInput | LeagueLoadFailure>>;
  loadRoleForecasts: (season: number, week: number, nowMs: number) => Promise<RoleForecastLike[]>;
  dryRun?: boolean;
  /** test seams: default to the real frozen-integrity and G3 pre-registration checks */
  integrity?: () => { ok: boolean; mismatches: string[] };
  preregOk?: () => boolean;
}

const addCounters = (a: Counters, b: Counters): Counters => Object.fromEntries((Object.keys(a) as Array<keyof Counters>).map((k) => [k, a[k] + b[k]])) as unknown as Counters;

/** Scheduled entry point. Safe to call with the flag off (returns DISABLED having done nothing). Never throws. */
export async function runRoleShadowCapture(deps: RunDeps): Promise<RunSummary> {
  const env = deps.env ?? process.env;
  const enabled = roleShadowCaptureEnabled(env);
  const out: RunSummary = { status: "DISABLED", flag: { name: ROLE_SHADOW_FLAG, enabled }, dry_run: !!deps.dryRun, leagues: [], totals: { counters: emptyCounters(), by_status: {} }, failures: 0 };
  if (!enabled) return out;
  try {
    const integ = (deps.integrity ?? verifyFrozenIntegrity)();
    out.integrity = { ...integ, g3_prereg_ok: (deps.preregOk ?? preregHashOk)() };
    if (!integ.ok || !out.integrity.g3_prereg_ok) { out.status = "INTEGRITY_FAILURE"; out.failures = 1; return out; }
    if (!deps.store && !deps.dryRun) { out.status = "NOT_CONFIGURED"; out.store = null; return out; }
    out.store = deps.store ? { kind: deps.store.kind, durable: deps.store.durable } : null;
    const weeks = await deps.loadLeagueWeeks();
    // The capture clock is read AFTER the league contexts are composed: a forecast composed at T0 can only be captured at T >= T0. (Reading it first
    // made every record "composed after capture time" and rejected the whole run — found by the real-source dry run, pinned by a regression test.)
    const nowMs = (deps.now ?? Date.now)();
    const roleCache = new Map<string, RoleForecastLike[]>();
    for (const lw of weeks) {
      if (isFailure(lw)) { out.leagues.push({ league_slug: lw.league_slug, ok: false, code: lw.failure.slice(0, 160) }); out.failures++; continue; }
      const leagueOut: RunSummary["leagues"][number] = { league_slug: lw.league_slug, ok: true };
      try {
        const k = `${lw.season}|${lw.week}`;
        if (!roleCache.has(k)) roleCache.set(k, await deps.loadRoleForecasts(lw.season, lw.week, nowMs));
        const built = buildLeagueWeekRecords(lw, roleCache.get(k)!, nowMs);
        leagueOut.counters = built.counters;
        out.totals.counters = addCounters(out.totals.counters, built.counters);
        const byStatus: Partial<Record<WriteStatus, number>> = {};
        if (!deps.dryRun && deps.store) {
          for (const rec of built.records) {
            let s: WriteStatus;
            try { s = (await deps.store.record(rec)).status; } catch { s = "ERROR"; }
            byStatus[s] = (byStatus[s] ?? 0) + 1;
            out.totals.by_status[s] = (out.totals.by_status[s] ?? 0) + 1;
            if (s === "ERROR") out.failures++;
          }
        }
        leagueOut.by_status = byStatus;
      } catch (e) {
        leagueOut.ok = false;
        leagueOut.code = e instanceof Error ? e.message.slice(0, 160) : "league_failed";
        out.failures++;
      }
      out.leagues.push(leagueOut);
    }
    out.status = out.failures === 0 ? "OK" : "PARTIAL";
  } catch (e) {
    out.status = "PARTIAL";
    out.failures++;
    out.leagues.push({ league_slug: "*", ok: false, code: e instanceof Error ? e.message.slice(0, 160) : "run_failed" });
  }
  return out;
}
