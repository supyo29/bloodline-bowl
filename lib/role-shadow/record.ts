/**
 * W2.P2 — the prospective Role Shadow capture record: what was KNOWABLE before kickoff, frozen.
 *
 * One record = one (league, season, week, player) decision at one point in time: the production champion forecast (real source projection,
 * Wave 1 injury model), the three arms (challenger / Role-free control / diagnostic full-C2), and every input needed to reproduce them.
 *
 * Evidence classes (derived from evidence, never chosen by the caller):
 *   LIVE_CAPTURED               every instant (capture, source observation, forecast composition, Role as-of, Role data cutoff) is strictly before the
 *                               player's kickoff AND the Role forecast was frozen live.
 *   HISTORICALLY_RECONSTRUCTED  rebuilt after the fact. Storable for completeness but NEVER eligible and never counted.
 * Late evidence has no class: it is REJECTED at the door (`buildRecord` returns reasons; the store refuses and, in Postgres, a trigger refuses
 * on the database clock). A late observation is never relabeled as pregame information.
 *
 * Identity is CONTENT-ADDRESSED over the decision (champion numbers, source observation, Role forecast content, scoring, model versions/hashes);
 * capture time, composition time and provenance are excluded, so re-capturing identical evidence is an idempotent no-op and a change in ANY
 * evidence — or in the model version — is a new record that never overwrites the old one.
 */

import { contentHash } from "@/lib/bridge/hash";
import { computeArms, ARM_MODEL_ID, INJURY_VERSIONS, type ArmsOutput, type InjuryEvidenceRecord } from "./arms";
import { assessScoring, type ScoringCompatibility } from "./scoring";
import {
  C2_FULL_MODEL_ID,
  CHALLENGER_MODEL_ID,
  CONTROL_MODEL_ID,
  PINNED,
  ROLE_SHADOW_MODULE_VERSION,
  ROLE_SHADOW_RECORD_SCHEMA_VERSION,
  SHADOW_POSITIONS,
  knownModelVersions,
  type RoleConfidence,
  type ShadowPosition,
} from "./spec";

export type CaptureClass = "LIVE_CAPTURED" | "HISTORICALLY_RECONSTRUCTED";
export const CAPTURE_CLASSES: readonly CaptureClass[] = ["LIVE_CAPTURED", "HISTORICALLY_RECONSTRUCTED"];
export type RoleCaptureKind = "LIVE_CAPTURED" | "AS_OF_RECONSTRUCTION";
export type JoinMethod = "GSIS" | "SLEEPER_ID_VIA_PROFILE";

/** Prereg population floor: conditional-on-active points >= 3.0 (the relevance floor, `scripts/w2p1/prereg.json` population.requires). */
export const RELEVANCE_FLOOR_POINTS = 3.0;
export const TIER_OF = (cond: number): "STARTER" | "FLEX" | "FRINGE" => (cond >= 12 ? "STARTER" : cond >= 6 ? "FLEX" : "FRINGE");

export interface RoleShadowRecord {
  schema_version: typeof ROLE_SHADOW_RECORD_SCHEMA_VERSION;
  capture_id: string;
  content_hash: string;
  capture_class: CaptureClass;
  module_version: string;
  models: Record<"challenger" | "control" | "c2_full", { id: string; config_hash: string }>;
  season: number;
  week: number;
  league_slug: string;
  provider: string;
  player: {
    canonical_player_id: string; gsis_id: string; sleeper_id: string | null; name: string | null; position: string; team: string | null; opponent: string | null;
    join_method: JoinMethod;
  };
  /** `kickoff_basis`: the cutoff is the EARLIEST kickoff known to either the champion clock or the Role forecast clock (never the later one) */
  game: { game_id: string | null; kickoff_at: string | null; kickoff_basis: "MIN_OF_CHAMPION_AND_ROLE" | "CHAMPION_ONLY" | "ROLE_ONLY" | null };
  timing: {
    /** when this capture was made (the decision clock) */
    captured_at: string;
    /** when Bloodline observed the source projection (shared upstream fetch) */
    source_observed_at: string | null;
    forecast_composed_at: string | null;
    /** when the Role forecast was frozen */
    role_as_of_at: string | null;
    /** latest completed-game instant any Role input used (+ settle allowance) */
    role_data_cutoff_at: string | null;
  };
  scoring: { fingerprint: string | null; compatibility: ScoringCompatibility; template: "HALF" | null; deviations: Array<[string, number, number]>; unmodeled_offense_keys: string[] };
  champion: {
    forecast_model_version: string;
    source: string | null;
    source_version: string | null;
    source_points: number | null;
    conditional_active_points: number | null;
    expected_points: number | null;
    value_state: string;
    certification_state: string;
    basis: string;
    injury: {
      normalized_state: string; availability_state: string; probability_active: number | null; embedded_fraction: number | null; mode: string;
      /** the injury-model versions the champion was produced under; arms are replayed at validation only when these equal the current ones */
      model_version: string; prior_version: string;
      /** everything needed to replay the champion's availability treatment (and to re-run it on an adjusted value) */
      evidence: InjuryEvidenceRecord;
    };
  };
  role: {
    forecast_id: string; forecast_version: string; capture_kind: RoleCaptureKind; confidence: RoleConfidence; designation: string;
    features: Record<string, number | null>;
  };
  arms: ArmsOutput;
  population: { eligible: boolean; headline: boolean; covered: boolean; tier: "STARTER" | "FLEX" | "FRINGE" | null; reasons: string[] };
  lineage: { league_snapshot_id: string | null; source_observation_id: string | null; forecast_identity_id: string | null; snapshot_artifact_id: string | null };
  lifecycle_state: "SHADOW_ONLY";
  may_influence_production: false;
  provenance: { invocation: "CRON" | "TEST" | "RECONSTRUCTION" };
}

export type RecordBody = Omit<RoleShadowRecord, "capture_id" | "content_hash">;

/** Everything that defines the DECISION. Excludes times that vary run-to-run and provenance. */
function identityBody(b: RecordBody): unknown {
  const { provenance: _p, ...rest } = b;
  void _p;
  return { ...rest, timing: { source_observed_at: b.timing.source_observed_at, role_data_cutoff_at: b.timing.role_data_cutoff_at } };
}
const deriveIds = (b: RecordBody) => {
  const content = contentHash(identityBody(b));
  return { content_hash: content.slice(0, 32), capture_id: `rsc:${content.slice(32, 48)}` };
};
export const withIds = (b: RecordBody): RoleShadowRecord => ({ ...deriveIds(b), ...b }) as RoleShadowRecord;

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Known unavailable / no game: no arm may contribute. Derived from stored evidence only (re-derivable at validation time). */
export function isUnavailable(champion: Pick<RoleShadowRecord["champion"], "value_state" | "injury">, role: Pick<RoleShadowRecord["role"], "designation">): boolean {
  return (
    champion.value_state === "BYE_VERIFIED" || champion.value_state === "NO_SCHEDULED_GAME" || champion.value_state === "KNOWN_UNAVAILABLE" ||
    champion.injury.availability_state === "UNAVAILABLE" || role.designation === "OUT"
  );
}

/** Pure population rules (reconstructed R-P1; see the certification report). */
export function derivePopulation(i: {
  capture_class: CaptureClass; position: string; scoring: ScoringCompatibility; join_ok: boolean;
  conditional_active_points: number | null; expected_points: number | null; value_state: string; arms_state: string;
}): RoleShadowRecord["population"] {
  const reasons: string[] = [];
  if (i.capture_class !== "LIVE_CAPTURED") reasons.push(`CLASS_${i.capture_class}_NEVER_ELIGIBLE`);
  if (!(SHADOW_POSITIONS as readonly string[]).includes(i.position)) reasons.push("POSITION_NOT_APPLICABLE_K_DST");
  if (i.scoring !== "TEMPLATE_HALF_ON_MODELED_KEYS") reasons.push(`SCORING_${i.scoring}`);
  if (!i.join_ok) reasons.push("PLAYER_IDENTITY_JOIN_NOT_PROVEN");
  if (i.value_state === "BYE_VERIFIED" || i.value_state === "NO_SCHEDULED_GAME") reasons.push("NO_GAME_THIS_WEEK_SCHEDULE_KNOWN");
  if (i.conditional_active_points == null || i.expected_points == null) reasons.push("NO_CHAMPION_BASELINE");
  else if (i.conditional_active_points < RELEVANCE_FLOOR_POINTS) reasons.push("BELOW_RELEVANCE_FLOOR");
  const eligible = reasons.length === 0;
  const headline = eligible && i.arms_state !== "NEUTRAL_UNAVAILABLE";
  const covered = eligible && i.arms_state === "APPLIED";
  return { eligible, headline, covered, tier: eligible && i.conditional_active_points != null ? TIER_OF(i.conditional_active_points) : null, reasons };
}

/** Point-in-time contract. Returns violations (empty = every instant is strictly before kickoff and the timeline is coherent). */
export function pointInTimeViolations(r: Pick<RoleShadowRecord, "game" | "timing" | "capture_class" | "role">): string[] {
  const v: string[] = [];
  const ko = ms(r.game.kickoff_at);
  if (!Number.isFinite(ko)) return ["NO_KICKOFF: a capture without a resolvable kickoff instant cannot be proven pregame"];
  const t = r.timing;
  const need = (label: string, iso: string | null, required: boolean): number => {
    const x = ms(iso);
    if (!Number.isFinite(x)) { if (required) v.push(`${label} missing or unparseable`); return NaN; }
    if (!(x < ko)) v.push(`${label} (${iso}) is not strictly before kickoff (${r.game.kickoff_at})`);
    return x;
  };
  const cap = need("captured_at", t.captured_at, true);
  const obs = need("source_observed_at", t.source_observed_at, true);
  const comp = need("forecast_composed_at", t.forecast_composed_at, true);
  const asOf = need("role_as_of_at", t.role_as_of_at, true);
  need("role_data_cutoff_at", t.role_data_cutoff_at, false);
  if (Number.isFinite(obs) && Number.isFinite(comp) && obs > comp) v.push("source observation is AFTER forecast composition (incoherent evidence timeline)");
  if (Number.isFinite(comp) && Number.isFinite(cap) && comp > cap) v.push("forecast composed after capture time");
  if (Number.isFinite(asOf) && Number.isFinite(cap) && asOf > cap) v.push("Role forecast as-of is after capture time");
  const live = r.capture_class === "LIVE_CAPTURED";
  if (live && r.role.capture_kind !== "LIVE_CAPTURED") v.push("LIVE_CAPTURED requires a live-frozen Role forecast (an AS_OF_RECONSTRUCTION is never pregame evidence)");
  if (!live && r.role.capture_kind === "LIVE_CAPTURED") v.push("a reconstructed record cannot carry a live Role forecast label");
  return v;
}

export const armsInputOf = (r: Pick<RoleShadowRecord, "player" | "role" | "champion">) => ({
  position: r.player.position as ShadowPosition,
  role: { confidence: r.role.confidence, features: r.role.features },
  conditional_active_points: r.champion.conditional_active_points,
  expected_points: r.champion.expected_points,
  probability_active: r.champion.injury.probability_active,
  embedded_fraction: r.champion.injury.embedded_fraction,
  injury: r.champion.injury.evidence,
  unavailable: isUnavailable(r.champion, r.role),
});

/** Arms can be replayed only under the injury-model versions they were produced with; otherwise they are trusted as recorded facts (hash-protected). */
export const armsReplayable = (r: Pick<RoleShadowRecord, "champion">): boolean =>
  r.champion.injury.model_version === INJURY_VERSIONS.model && r.champion.injury.prior_version === INJURY_VERSIONS.prior;

/** Full structural validation of a stored/proposed record. Empty = valid. */
export function validateRecord(r: RoleShadowRecord): string[] {
  const e: string[] = [];
  if (r.schema_version !== ROLE_SHADOW_RECORD_SCHEMA_VERSION) e.push(`unsupported schema_version ${r.schema_version}`);
  const { capture_id, content_hash, ...body } = r;
  const ids = deriveIds(body as RecordBody);
  if (ids.content_hash !== content_hash) e.push("content_hash does not match the record (tampered or malformed)");
  if (ids.capture_id !== capture_id) e.push("capture_id does not match the record");
  if (!CAPTURE_CLASSES.includes(r.capture_class)) e.push(`unknown capture class ${r.capture_class}`);
  if (r.lifecycle_state !== "SHADOW_ONLY" || r.may_influence_production !== false) e.push("a Role Shadow record must be SHADOW_ONLY and non-influencing");

  const known = knownModelVersions();
  const expect: Array<[keyof RoleShadowRecord["models"], string]> = [["challenger", CHALLENGER_MODEL_ID], ["control", CONTROL_MODEL_ID], ["c2_full", C2_FULL_MODEL_ID]];
  for (const [k, id] of expect) {
    const m = r.models?.[k];
    if (!m || m.id !== id) e.push(`models.${k}.id must be ${id}`);
    else if (known[id] !== m.config_hash) e.push(`models.${k}.config_hash ${m.config_hash} is not the pinned frozen configuration for ${id}`);
  }
  if (!(SHADOW_POSITIONS as readonly string[]).includes(r.player?.position)) e.push("position must be QB/RB/WR/TE");

  if (r.capture_class === "LIVE_CAPTURED") e.push(...pointInTimeViolations(r));
  else if (r.population.eligible) e.push("a non-live record can never be population-eligible");

  // arms must be reproducible from the stored inputs (detects tampering AND code drift) — when the injury-model versions still match
  if ((SHADOW_POSITIONS as readonly string[]).includes(r.player?.position) && armsReplayable(r)) {
    const re = computeArms(armsInputOf(r));
    if (contentHash(re) !== contentHash(r.arms)) e.push("arms are not reproducible from the stored inputs");
  }
  const pop = derivePopulation({
    capture_class: r.capture_class, position: r.player.position, scoring: r.scoring.compatibility, join_ok: r.player.join_method === "GSIS" || r.player.join_method === "SLEEPER_ID_VIA_PROFILE",
    conditional_active_points: r.champion.conditional_active_points, expected_points: r.champion.expected_points, value_state: r.champion.value_state, arms_state: r.arms.shared_state,
  });
  if (contentHash(pop) !== contentHash(r.population)) e.push("population flags are not reproducible from the stored inputs");
  return e;
}

export interface BuildRecordInput {
  capture_class: CaptureClass;
  captured_at: string;
  invocation: RoleShadowRecord["provenance"]["invocation"];
  season: number; week: number; league_slug: string; provider: string;
  player: RoleShadowRecord["player"];
  game: RoleShadowRecord["game"];
  timing: Omit<RoleShadowRecord["timing"], "captured_at">;
  scoring_fingerprint: string | null;
  raw_scoring: Record<string, number> | null;
  champion: RoleShadowRecord["champion"];
  role: RoleShadowRecord["role"];
  lineage: RoleShadowRecord["lineage"];
}

export interface BuildRecordResult { record: RoleShadowRecord | null; rejected: string[] }

/**
 * Build a record, or REJECT it. For a LIVE_CAPTURED candidate any point-in-time violation rejects (no record, no class): late evidence is
 * rejected rather than relabeled. A HISTORICALLY_RECONSTRUCTED record is built unconditionally but can never be eligible.
 */
export function buildRecord(i: BuildRecordInput): BuildRecordResult {
  const assessment = assessScoring(i.raw_scoring);
  const arms = computeArms(armsInputOf({ player: i.player, role: i.role, champion: i.champion }));
  const population = derivePopulation({
    capture_class: i.capture_class, position: i.player.position, scoring: assessment.compatibility, join_ok: true,
    conditional_active_points: i.champion.conditional_active_points, expected_points: i.champion.expected_points, value_state: i.champion.value_state, arms_state: arms.shared_state,
  });
  const h = { challenger: PINNED.challenger_config_hash, control: PINNED.control_config_hash, c2_full: PINNED.c2_full_config_hash };
  const body: RecordBody = {
    schema_version: ROLE_SHADOW_RECORD_SCHEMA_VERSION, capture_class: i.capture_class, module_version: ROLE_SHADOW_MODULE_VERSION,
    models: {
      challenger: { id: ARM_MODEL_ID.CHALLENGER, config_hash: h.challenger },
      control: { id: ARM_MODEL_ID.CONTROL, config_hash: h.control },
      c2_full: { id: ARM_MODEL_ID.C2_FULL, config_hash: h.c2_full },
    },
    season: i.season, week: i.week, league_slug: i.league_slug, provider: i.provider, player: i.player, game: i.game,
    timing: { captured_at: i.captured_at, ...i.timing },
    scoring: { fingerprint: i.scoring_fingerprint, compatibility: assessment.compatibility, template: assessment.compatibility === "TEMPLATE_HALF_ON_MODELED_KEYS" ? "HALF" : null, deviations: assessment.deviations, unmodeled_offense_keys: assessment.unmodeled_offense_keys },
    champion: i.champion, role: i.role, arms, population, lineage: i.lineage,
    lifecycle_state: "SHADOW_ONLY", may_influence_production: false, provenance: { invocation: i.invocation },
  };
  if (i.capture_class === "LIVE_CAPTURED") {
    const late = pointInTimeViolations(body);
    if (late.length) return { record: null, rejected: late };
  }
  return { record: withIds(body), rejected: [] };
}
