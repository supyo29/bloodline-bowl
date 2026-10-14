/**
 * W2.R1 S8 qualification registry: the AUTHORITATIVE per-component qualification state after the S7 final evaluation (2026 weeks 1-5, permanently spent).
 * SHADOW ONLY. A state is a property of (component, league scoring regime), never of "W2.R1" as a whole. Nothing here is read by a production decision path.
 * Frozen S7 evidence (scripts/w2r1/results/final/*) is historical confirmatory evidence and is never edited; this file only INTERPRETS it.
 */
export const W2R1_RESEARCH_VERDICT = "W2.R1 CERTIFIED WITH DOCUMENTED LIMITATIONS — SHADOW ONLY" as const;

export const QUAL_STATES = ["QUALIFIED_SHADOW", "DIAGNOSTIC_ONLY", "EXPLORATORY_POST_DEFECT", "INSUFFICIENT_FINAL_SAMPLE", "NO_RELIABLE_SIGNAL", "UNAVAILABLE"] as const;
export type QualState = (typeof QUAL_STATES)[number];
export type ForecastSource = "W2R1_COMPONENT_MODEL" | "INHERITED_GENERIC" | "NONE";

export interface Qualification { state: QualState; label: string; reason: string; caveats: string[]; evidence: string }

/** Permanent audit trail of the post-open defects (see scripts/w2r1/results/final/post_open_defects.json). Never remove. */
export const POST_OPEN_DEFECTS = {
  "PO-1": { summary: "Rogers Park D/ST confirmatory result invalid: the new K/DST gate code clustered the T2 bootstrap by season-week instead of by game / team-week. Any new Rogers qualification must come from Week 6+ prospective evidence.", affects: ["S4.rogers-park.DST"], status: "CONFIRMATORY_RESULT_INVALIDATED" },
  "PO-2": { summary: "Final-harness defect: the T9 oracle control was missing for 6 of 9 K/DST slots and a not-computed string was accepted as a pass. Computing it for every slot changed no final outcome.", affects: ["S4.* T9"], status: "NO_OUTCOME_CHANGE_RETAINED_AS_HARNESS_DEFECT" },
} as const;

export type LeagueSlug = "bloodline-bowl" | "devoted-to-the-game" | "sportys-alumni" | "maclin-on-chicks-xvi" | "rogers-park";
export const SHARED_SCORING_NOTE = "Devoted to the Game and Sporty's Alumni use the same D/ST scoring formulation: one formulation observed in two leagues, i.e. one independent piece of S7 evidence, not two.";

const DST: Record<LeagueSlug, Qualification> = {
  "devoted-to-the-game": { state: "QUALIFIED_SHADOW", label: "D/ST expected points — qualified for shadow use", reason: "passed every preregistered S7 gate on the final set (n=158 team-games, dMAE +0.73 [+0.26, +1.21] vs the prior-4-game control)", caveats: [SHARED_SCORING_NOTE], evidence: "scripts/w2r1/results/final/s4_final.json#S4.devoted-to-the-game.DST" },
  "sportys-alumni": { state: "QUALIFIED_SHADOW", label: "D/ST expected points — qualified for shadow use", reason: "identical scoring formulation to Devoted to the Game; passed every preregistered S7 gate", caveats: [SHARED_SCORING_NOTE], evidence: "scripts/w2r1/results/final/s4_final.json#S4.sportys-alumni.DST" },
  "maclin-on-chicks-xvi": { state: "QUALIFIED_SHADOW", label: "D/ST expected points — qualified for shadow use", reason: "passed every preregistered S7 gate (dMAE +0.68 [+0.17, +1.19], bias +0.02)", caveats: ["Yahoo scoring semantics (one Fumble Recovery for defense+special teams, 'Touchdown' includes blocked-kick TDs)"], evidence: "scripts/w2r1/results/final/s4_final.json#S4.maclin-on-chicks-xvi.DST" },
  "rogers-park": { state: "EXPLORATORY_POST_DEFECT", label: "D/ST expected points — EXPLORATORY (not S7-qualified)", reason: "post-open defect PO-1 invalidated the confirmatory T2 result; the model continues prospectively but must not be described as S7-qualified", caveats: [POST_OPEN_DEFECTS["PO-1"].summary, "May only be re-evaluated on Week 6+ prospective evidence"], evidence: "scripts/w2r1/results/final/post_open_defects.json#PO-1" },
  "bloodline-bowl": { state: "DIAGNOSTIC_ONLY", label: "D/ST expected points — unqualified", reason: "failed the S7 bias gate (bias +0.73 > 0.5)", caveats: ["scoring-residual caveat: blk_kick_ret_yd and fg_ret_yd (0.04/yd) cannot be reconstructed (bounded 0.0157 pts/team-game); never scored as zero", "end-to-end reconstruction error 0.103 pts/team-game"], evidence: "scripts/w2r1/results/final/s4_final.json#S4.bloodline-bowl.DST" },
};

export const isLeagueSlug = (s: string): s is LeagueSlug => s in DST;
export function dstQualification(league: string): Qualification {
  return isLeagueSlug(league) ? DST[league] : { state: "UNAVAILABLE", label: "D/ST expected points — no W2.R1 scoring regime for this league", reason: "league has no registered W2.R1 K/DST scoring regime", caveats: [], evidence: "scripts/w2r1/s4_regimes.json" };
}
export function kQualification(league: string): Qualification {
  const base = { state: "DIAGNOSTIC_ONLY" as const, label: "K forecast quality — DIAGNOSTIC_ONLY (not W2.R1-qualified)", evidence: "scripts/w2r1/results/final/s4_final.json#*.K" };
  if (league === "maclin-on-chicks-xvi") return { ...base, reason: "failed the S7 gates; Yahoo kicker stat-line parity is unverified", caveats: ["Verify Yahoo kicker stat-line parity before any future Maclin promotion attempt", "K Dynamic VOR mechanics remain available"] };
  if (league === "rogers-park") return { state: "UNAVAILABLE", label: "no kicker slot in this league", reason: "league has no K slot", caveats: [], evidence: "scripts/w2r1/s4_regimes.json" };
  return { ...base, reason: "failed S7 gates T2/T5/T6 (CIs span zero)", caveats: ["K Dynamic VOR mechanics remain available", "prospective K component predictions continue to be collected"] };
}
export const TACTICAL = { state: "NO_RELIABLE_SIGNAL" as QualState, tactical_signal: "NO_RELIABLE_INCREMENTAL_SIGNAL" as const, applied_to_forecast: false as const, reason: "S7: G2 never beats G1/Role-lite (TE significantly worse); S5 evidence machinery is retained for research/provenance only", evidence: "scripts/w2r1/results/final/s5_final.json" };

export const UPSIDE_LABEL = "Upside likelihood — probability of a top-N positional finish" as const;
export type UpsidePos = "QB" | "RB" | "WR" | "TE" | "K" | "DEF";
export function upsideQualification(pos: string): Qualification {
  const label = UPSIDE_LABEL;
  if (pos === "TE") return { state: "INSUFFICIENT_FINAL_SAMPLE", label, reason: "frozen TE M1b: only 21 final-set events (< 40; structurally ≤ 30 in five weeks) — evaluated prospectively only, never refit on Weeks 1-5", caveats: ["shown only as a prospective-evaluation output, not as a calibrated probability"], evidence: "scripts/w2r1/results/final/s6_final_raw.json#TE" };
  if (pos === "QB" || pos === "RB") return { state: "DIAGNOSTIC_ONLY", label, reason: "S7: no reliable signal at the final gates; research output only", caveats: [], evidence: "scripts/w2r1/results/final/s6_final_raw.json" };
  if (pos === "WR") return { state: "NO_RELIABLE_SIGNAL", label, reason: "no signal over the tier base rate on validation or final", caveats: [], evidence: "scripts/w2r1/results/final/s6_final_raw.json#WR" };
  return { state: "UNAVAILABLE", label, reason: "no K/DST spike probability is displayed (no candidate was eligible)", caveats: [], evidence: "scripts/w2r1/results/final/s4_final.json" };
}

/** A forecast may be labelled QUALIFIED_SHADOW only if it really came from the W2.R1 component model for that regime. A generic provider forecast can never carry a W2.R1 qualified label. */
export function labelForecast(source: ForecastSource, q: Qualification): { source: ForecastSource; state: QualState; w2r1_qualified: boolean; note: string } {
  if (q.state === "QUALIFIED_SHADOW" && source !== "W2R1_COMPONENT_MODEL") {
    return { source, state: source === "NONE" ? "UNAVAILABLE" : "DIAGNOSTIC_ONLY", w2r1_qualified: false, note: "NO SILENT FALLBACK: the W2.R1 qualified model was not used for this value; it is an inherited generic forecast and is not W2.R1-qualified" };
  }
  if (source === "INHERITED_GENERIC") return { source, state: "DIAGNOSTIC_ONLY", w2r1_qualified: false, note: "inherited generic provider forecast; not a W2.R1 model output" };
  return { source, state: q.state, w2r1_qualified: q.state === "QUALIFIED_SHADOW" && source === "W2R1_COMPONENT_MODEL", note: q.reason };
}

export function qualificationSummary(league: string) {
  return {
    research_verdict: W2R1_RESEARCH_VERDICT,
    dst_expected_points: dstQualification(league), k_forecast: kQualification(league), tactical_game_plan: TACTICAL,
    upside_likelihood: { TE: upsideQualification("TE"), QB: upsideQualification("QB"), RB: upsideQualification("RB"), WR: upsideQualification("WR"), K: upsideQualification("K"), DEF: upsideQualification("DEF") },
    post_open_defects: POST_OPEN_DEFECTS,
  };
}
