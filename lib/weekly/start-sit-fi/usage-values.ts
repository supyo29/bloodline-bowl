/**
 * Resolves the Football-Intelligence PLAYER-USAGE model families (`usage_snap_share`, `usage_route_participation`,
 * `usage_target_share`, `usage_rush_share`) for one player.
 *
 * ROOT CAUSE this fixes (Projection Calibration Phase 2 audit): `translateFiAdjustment` documented that "the batch helper injects
 * usage values via `fiValues`" — but no such helper existed anywhere, so every usage family was `fi_value = null` in every capture
 * (RB usage_snap_share 52/52 null, TE usage_route_participation & usage_target_share 12/12 null in Week 3).
 *
 * Valid-evidence gates (never "just non-null"):
 *  - the player must resolve (gsis/sleeper id from the canonical id) to a PUBLISHED FI usage row whose position equals the request position;
 *  - the metric must carry a `modeled` value (the shrunk, prior-blended estimate the model was trained on);
 *  - confidence is passed through untouched (route participation is prior-season evidence while 2026 participation is unpublished, and the
 *    FI itself grades it LOW / INSUFFICIENT_SAMPLE — the family's conf_weight then damps or zeroes it);
 *  - the FI snapshot is the one PUBLISHED at capture time (its through_week is a completed-games cutoff), so the value is pre-kickoff by construction.
 * Missing stays missing (null): never coerced to zero.
 */
import type { FootballIntelligence } from "@/lib/football-intel";

export function fiIdsFromCanonical(canonicalPlayerId: string): { gsis_id: string | null; sleeper_id: string | null } {
  const g = /^player:gsis:(.+)$/.exec(canonicalPlayerId);
  if (g) return { gsis_id: g[1]!, sleeper_id: null };
  const s = /^player:sleeper:(.+)$/.exec(canonicalPlayerId);
  if (s) return { gsis_id: null, sleeper_id: s[1]! };
  return { gsis_id: null, sleeper_id: null };
}

export interface UsageValue { value: number | null; confidence: string | null; source: "fi_player_usage_profile" }
export function usageValueFor(fi: FootballIntelligence, canonicalPlayerId: string, position: string, valueCol: string): UsageValue | null {
  const m = /^fi_usage_(.+)_modeled$/.exec(valueCol);
  if (!m) return null;
  const ids = fiIdsFromCanonical(canonicalPlayerId);
  if (!ids.gsis_id && !ids.sleeper_id) return null;
  const profile = fi.playerUsage(ids);
  if (profile.resolution === "UNRESOLVED") return null;
  if (profile.position && profile.position !== position) return null; // an id collision across positions is never used
  const metric = profile.metrics[m[1]!];
  if (!metric || metric.modeled == null || !Number.isFinite(metric.modeled)) return null;
  return { value: metric.modeled, confidence: metric.confidence ?? null, source: "fi_player_usage_profile" };
}

/**
 * `interaction_*` model families (previously always null for the same reason as the usage families: nothing ever resolved them). The only point-in-time source is
 * the published FI contextual-matchup feature. LABELED PROXY: the trained family paired the offense's pass-EPA percentile with the defense's SUCCESS-RATE-allowed
 * percentile, while the served feature pairs it with the defense's PASS-EPA-allowed percentile (same `off_pct - (1 - def_pct)` form, different defensive metric).
 * Confidence passes through (LOW today). Never used when the FI feature is unavailable; missing stays null.
 */
export const INTERACTION_PROXY_NOTE = "fi_interaction proxy: served pass_epa_vs_pass_defense uses def pass-EPA-allowed; trained family used def success-rate-allowed";
export function interactionValueFor(fi: FootballIntelligence, team: string | null, opponent: string | null, valueCol: string): (UsageValue & { proxy: string }) | null {
  const m = /^fi_interaction_(.+)_modeled$/.exec(valueCol); if (!m || !team || !opponent) return null;
  const r = fi.contextualMatchup(m[1]!, team, opponent) as { availability?: string; interaction_signal?: number | null; confidence?: string | null };
  if (r.availability === "NOT_AVAILABLE" || r.interaction_signal == null || !Number.isFinite(r.interaction_signal)) return null;
  return { value: r.interaction_signal, confidence: r.confidence ?? null, source: "fi_player_usage_profile", proxy: INTERACTION_PROXY_NOTE };
}
