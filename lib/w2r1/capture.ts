/**
 * W2.R1 S8 prospective capture: format, immutability and grading contract. SHADOW ONLY.
 * A week's pregame belief is FROZEN before the first kickoff of that week and never rewritten; outcomes are graded afterwards by pure functions that read the frozen belief.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const CAPTURE_SCHEMA = "w2r1-prospective-capture-1" as const;
export const CAPTURE_KINDS = ["KDST_COMPONENTS", "TE_UPSIDE", "LEAGUE_MANAGER_STATE", "QUALIFICATION_AND_TACTICAL"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/** canonical JSON: sorted keys, no whitespace; the hash is over THIS form, so a capture is comparable regardless of formatting. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const payloadHash = (v: unknown): string => sha256(canonicalJson(v));

export interface LeagueManagerState {
  schema: typeof CAPTURE_SCHEMA; kind: "LEAGUE_MANAGER_STATE"; season: number; week: number; league: string; manager: string; provider: string;
  captured_at: string; first_kickoff_at: string;
  w1_canonical_forecast: { context_generated_at: string; projection_source: string; projection_status: string; players: Array<{ player_id: string; name: string; position: string; status: string; weeks: Record<string, { state: string; lineup: number | null; underlying: number | null }> }> };
  w1_availability_state: Array<{ player_id: string; designation: string | null; state: string }>;
  roster_state: { legal_roster_starters: string[]; bench: string[]; ir_pup: string[]; lineup_constraints: { slots: string[]; bench_size: number; ir_slots: number }; acquisition_state: unknown };
  verified_market_state: { provider: string; verified: boolean; freshness: string; observed_at: string | null; candidates: Array<{ player_id: string; name: string; position: string; method: string; success_probability: number | null }> };
  dynamic_vor: Array<{ player_id: string; weekly_roster_vor: number | null; hold_vor: number | null; streaming_adjusted_vor: number | null; ros_vor: number | null; replacement_chain: unknown }>;
  role_state: unknown; tactical_evidence_state: { tactical_signal: string; applied_to_forecast: false };
  confidence: unknown; qualification: unknown; scoring_fingerprint: string; model_artifact_hashes: Record<string, unknown>;
}

export interface Manifest { schema: typeof CAPTURE_SCHEMA; season: number; week: number; frozen_at: string; first_kickoff_at: string; status: "FROZEN_PREGAME"; files: Record<string, string>; note: string }
export const MANIFEST_NAME = "manifest.json";

export function buildManifest(dir: string, season: number, week: number, frozenAt: string, firstKickoffAt: string, files: string[]): Manifest {
  if (Date.parse(frozenAt) >= Date.parse(firstKickoffAt)) throw new Error(`capture is not pregame: frozen_at ${frozenAt} >= first kickoff ${firstKickoffAt}`);
  return { schema: CAPTURE_SCHEMA, season, week, frozen_at: frozenAt, first_kickoff_at: firstKickoffAt, status: "FROZEN_PREGAME", files: Object.fromEntries(files.sort().map((f) => [f, sha256(canonicalJson(JSON.parse(readFileSync(join(dir, f), "utf8"))))])), note: "belief frozen before kickoff; never rewrite; grade outcomes only afterwards" };
}
/** returns the list of problems; [] = the frozen belief is intact and was frozen strictly before the first kickoff */
export function verifyManifest(dir: string): string[] {
  const mp = join(dir, MANIFEST_NAME); if (!existsSync(mp)) return [`${dir}: manifest missing`];
  const m = JSON.parse(readFileSync(mp, "utf8")) as Manifest; const out: string[] = [];
  if (Date.parse(m.frozen_at) >= Date.parse(m.first_kickoff_at)) out.push("frozen at/after first kickoff");
  const onDisk = readdirSync(dir).filter((f) => f !== MANIFEST_NAME && f.endsWith(".json")).sort();
  if (JSON.stringify(onDisk) !== JSON.stringify(Object.keys(m.files).sort())) out.push("file set differs from manifest");
  for (const [f, h] of Object.entries(m.files)) { if (!existsSync(join(dir, f))) { out.push(`missing ${f}`); continue; } if (sha256(canonicalJson(JSON.parse(readFileSync(join(dir, f), "utf8")))) !== h) out.push(`hash mismatch ${f}`); }
  return out;
}

/* ------------------------------------------------------------------ grading (pure; reads only the frozen belief + realized outcomes) */
export interface RealizedWeek { points: Record<string, number>; played: Record<string, boolean> }
/** realized D/ST error vs the frozen expected points (exact league scoring supplied by the caller) */
export function gradeExpected(frozen: Array<{ id: string; expected: number }>, actual: Record<string, number>): { n: number; mae: number; bias: number; rows: Array<{ id: string; expected: number; actual: number; error: number }> } {
  const rows = frozen.filter((f) => f.id in actual).map((f) => ({ id: f.id, expected: f.expected, actual: actual[f.id]!, error: actual[f.id]! - f.expected }));
  const n = rows.length; return { n, mae: n ? rows.reduce((s, r) => s + Math.abs(r.error), 0) / n : NaN, bias: n ? rows.reduce((s, r) => s + r.error, 0) / n : NaN, rows };
}
/** Brier / log loss / calibration bins for frozen upside probabilities */
export function gradeProbabilities(frozen: Array<{ id: string; p: number }>, outcome: Record<string, 0 | 1>): { n: number; events: number; brier: number; logloss: number } {
  const rows = frozen.filter((f) => f.id in outcome); const n = rows.length; const cl = (p: number) => Math.min(1 - 1e-4, Math.max(1e-4, p));
  return { n, events: rows.reduce((s, r) => s + outcome[r.id]!, 0), brier: n ? rows.reduce((s, r) => s + (r.p - outcome[r.id]!) ** 2, 0) / n : NaN, logloss: n ? -rows.reduce((s, r) => s + outcome[r.id]! * Math.log(cl(r.p)) + (1 - outcome[r.id]!) * Math.log(1 - cl(r.p)), 0) / n : NaN };
}

/**
 * Dynamic-VOR prospective validation on a REAL roster (S8 item 7). Inputs are the FROZEN predicted weekly roster VOR, the frozen replacement chain, and realized player points.
 *  realized_marginal_lineup_value = (best legal lineup total WITH the asset) - (best legal lineup total WITHOUT it, re-optimized over the real roster + the recommended replacement), using REALIZED points.
 * decision regret = best REALIZED verified-pool alternative minus the REALIZED recommended replacement (0 when the recommendation was the best available).
 * The lineup optimizer is supplied by the caller so the same constraints that were frozen are used (no retrospective roster optimization of the belief itself).
 */
export interface VorFrozenRow { player_id: string; predicted_weekly_roster_vor: number | null; replacement_player_id: string | null; replacement_in_pool_verified: boolean; verified_pool_alternatives: string[]; is_bye: boolean; predicted_hold_vor: number | null }
export interface VorGrade { player_id: string; predicted: number | null; realized_marginal: number; error: number | null; replacement_realized: number | null; asset_realized: number; regret: number | null; bye_preserved: boolean | null; difficult_to_replace: boolean | null }
export function gradeDynamicVor(frozen: readonly VorFrozenRow[], realized: Record<string, number>, lineupTotal: (excluding: string | null, addReplacement: string | null) => number, highThreshold = 3, lowThreshold = 0.5): { rows: VorGrade[]; summary: { n: number; mean_abs_error: number; high_private_vor_n: number; high_private_vor_hard_to_replace_rate: number | null; low_vor_n: number; low_vor_replaceable_rate: number | null; mean_regret: number | null } } {
  const rows: VorGrade[] = frozen.map((f) => {
    const withAsset = lineupTotal(null, null); const without = lineupTotal(f.player_id, f.replacement_player_id);
    const marginal = withAsset - without; const rep = f.replacement_player_id != null ? realized[f.replacement_player_id] ?? null : null;
    const asset = realized[f.player_id] ?? 0;
    return { player_id: f.player_id, predicted: f.predicted_weekly_roster_vor, realized_marginal: marginal, error: f.predicted_weekly_roster_vor == null ? null : marginal - f.predicted_weekly_roster_vor, replacement_realized: rep,
      asset_realized: asset, regret: rep == null ? null : Math.max(0, Math.max(rep, ...f.verified_pool_alternatives.map((id) => realized[id] ?? -Infinity)) - rep), bye_preserved: f.is_bye ? (f.predicted_hold_vor != null && f.predicted_hold_vor >= 0) : null,
      difficult_to_replace: f.predicted_weekly_roster_vor == null ? null : marginal >= lowThreshold };
  });
  const known = rows.filter((r) => r.error != null); const high = rows.filter((r) => r.predicted != null && r.predicted >= highThreshold); const low = rows.filter((r) => r.predicted != null && r.predicted <= lowThreshold);
  const regrets = rows.map((r) => r.regret).filter((x): x is number => x != null);
  return { rows, summary: { n: known.length, mean_abs_error: known.length ? known.reduce((s, r) => s + Math.abs(r.error!), 0) / known.length : NaN, high_private_vor_n: high.length, high_private_vor_hard_to_replace_rate: high.length ? high.filter((r) => r.realized_marginal >= lowThreshold).length / high.length : null, low_vor_n: low.length, low_vor_replaceable_rate: low.length ? low.filter((r) => r.realized_marginal <= lowThreshold).length / low.length : null, mean_regret: regrets.length ? regrets.reduce((a, b) => a + b, 0) / regrets.length : null } };
}
