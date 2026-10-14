/**
 * W2.R1 S8 live "Upside likelihood — probability of a top-N positional finish" from a FROZEN pregame capture. SHADOW ONLY.
 * Never called "breakout probability". TE M1b is preserved for PROSPECTIVE evaluation only (INSUFFICIENT_FINAL_SAMPLE): its number is exposed as an evaluation output with that state, not as a calibrated probability.
 * QB/RB: DIAGNOSTIC_ONLY research output. WR: NO_RELIABLE_SIGNAL, no probability. K/DST: no spike probability.
 */
import { upsideQualification, UPSIDE_LABEL, type Qualification } from "./qualification";
export interface UpsideRow { name: string | null; gsis_id: string; team: string; opp: string; week: number; tier: string; b0: number; designation: string; tier_base_rate: number; p_frozen_rung: number; p_M1b: number; model_known: boolean; career_prior: number }
export interface UpsideCapture { meta: { schema: string; target_week: number; generated_at: string; label: string; primary_labels: string; frozen_models: Record<string, unknown> }; positions: Record<string, { frozen_rung: string; val_verdict: string; base_rate_fit: number; tier_rates_fit: Record<string, number>; n: number; rows: UpsideRow[] }> }
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");

export function upsideForPlayer(cap: UpsideCapture, pos: string, name: string, team: string | null) {
  const q: Qualification = upsideQualification(pos);
  const P = cap.positions[pos];
  const base = { label: UPSIDE_LABEL, qualification: q, position: pos, week: cap.meta.target_week, evidence_timestamp: cap.meta.generated_at, model_version: `w2r1-s6-${P?.frozen_rung ?? "NA"}-frozen-2026.0` };
  if (!P || q.state === "UNAVAILABLE") return { ...base, probability: null, display: q.reason };
  const r = P.rows.find((x) => norm(x.name) === norm(name) && (team == null || x.team === team));
  if (!r) return { ...base, probability: null, display: "no row in the frozen pregame capture for this player (not in the pregame population: bye, OUT, or no recent played game)", matched: false };
  if (q.state === "NO_RELIABLE_SIGNAL") return { ...base, probability: null, matched: true, display: "NO_RELIABLE_SIGNAL", tier_base_rate_context_only: Math.round(r.tier_base_rate * 100) / 100 };
  const p = Math.round(r.p_frozen_rung * 1000) / 1000;
  return { ...base, matched: true, probability: p, position_base_rate: Math.round(P.base_rate_fit * 1000) / 1000, tier_base_rate: Math.round(r.tier_base_rate * 1000) / 1000, model_known: r.model_known, tier: r.tier,
    display: q.state === "INSUFFICIENT_FINAL_SAMPLE" ? `${UPSIDE_LABEL}: prospective evaluation only (INSUFFICIENT_FINAL_SAMPLE) — about ${Math.round(p * 100)}% vs tier base rate ${Math.round(r.tier_base_rate * 100)}%` : `${UPSIDE_LABEL}: DIAGNOSTIC_ONLY research output (about ${Math.round(p * 100)}%)` };
}
export function upsideListing(cap: UpsideCapture, pos: string, limit = 25) {
  const q = upsideQualification(pos); const P = cap.positions[pos];
  if (!P || q.state === "UNAVAILABLE" || q.state === "NO_RELIABLE_SIGNAL") return { label: UPSIDE_LABEL, qualification: q, rows: [] as unknown[], note: q.reason };
  return { label: UPSIDE_LABEL, qualification: q, week: cap.meta.target_week, evidence_timestamp: cap.meta.generated_at, rows: [...P.rows].sort((a, b) => b.p_frozen_rung - a.p_frozen_rung).slice(0, limit).map((r) => ({ name: r.name, team: r.team, opp: r.opp, tier: r.tier, probability: Math.round(r.p_frozen_rung * 1000) / 1000, tier_base_rate: Math.round(r.tier_base_rate * 1000) / 1000 })) };
}
