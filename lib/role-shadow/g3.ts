/**
 * W2.P2 — G3: incremental value of the frozen Role challenger over the REAL source-backed production forecast, on PROSPECTIVELY captured evidence.
 *
 * Pure and deterministic: `evaluateG3(bundle)` depends only on the bundle (captured records + outcome rows), never on a clock or a network, and the
 * bootstrap is seeded — so a report is reproducible byte-for-byte from the logged input bundle.
 *
 * Evidence discipline (enforced here, not just documented):
 *   - every record is re-validated; invalid / late / tampered records are excluded and counted (never silently scored);
 *   - only LIVE_CAPTURED, population-eligible records count; HISTORICALLY_RECONSTRUCTED never does;
 *   - models are never pooled across versions: the evaluation is for ONE challenger config hash;
 *   - one decision per (player, season, week, scoring fingerprint): the latest valid pre-kickoff capture (outcome-blind rule, see g3-prereg.json);
 *   - thresholds come from `scripts/w2p2/g3-prereg.json` (content-pinned); a sample below sufficiency yields G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE and
 *     evaluates NO gate — a valid scientific outcome, never manufactured into a pass or a fail.
 */

import { contentHash } from "@/lib/bridge/hash";
import prereg from "../../scripts/w2p2/g3-prereg.json";
import { computeArms } from "./arms";
import { armsInputOf, validateRecord, type RoleShadowRecord } from "./record";
import { PINNED, SHADOW_POSITIONS, type ShadowPosition } from "./spec";
import { binomUpper, decisions, errStats, lcg, paired, type Paired } from "./stats";

export const G3_REPORT_VERSION = "role-shadow-g3-report-2026.1" as const;
/** Canonical-JSON hash (32 hex) of `scripts/w2p2/g3-prereg.json`; a silent threshold edit makes the evaluator refuse to run. */
export const G3_PREREG_CONTENT_HASH = "b083470af606e521878bb366affce9d5";

export type G3Verdict = "G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE" | "G3_FAIL" | "G3_QUALIFIED_FOR_HUMAN_REVIEW";
export type GateStatus = "PASS" | "FAIL" | "INSUFFICIENT_EVIDENCE" | "NOT_EVALUABLE";

export interface OutcomeRow {
  league_slug: string; season: number; week: number; canonical_player_id: string;
  actual_fantasy_points: number | null; participation_state: string; evidence_status: string; scoring_exactness: string | null;
  /** identity of the ledger row used (case id + evidence digest) so the report is traceable to its outcome evidence */
  case_ref: string;
}
export interface G3Bundle { records: RoleShadowRecord[]; outcomes: OutcomeRow[] }
export interface G3Options { challenger_config_hash?: string; bootstrap_reps?: number; permutations?: number }

export const preregHashOk = (): boolean => contentHash(prereg).slice(0, 32) === G3_PREREG_CONTENT_HASH;

const T = prereg as unknown as {
  sufficiency: {
    S1_min_completed_weeks_with_outcomes: { value: number };
    S2_min_covered_decisions_with_outcomes: { value: Record<ShadowPosition, number> };
    S2_min_coverage_fraction: { value: number };
  };
  gates: {
    Q1_champion_vs_challenger: { min_dMAE: number };
    Q2_control_vs_challenger: { min_dMAE: number };
    Q3_rmse: { max_rmse_excess: number };
    Q4_relative_bias: { max_abs_bias_excess_over_champion: number };
    Q5_week_consistency: { min_fraction_of_weeks_positive: number };
    Q6_decisions: { min_decided_pairs: number; max_p_one_sided: number };
    Q7_tiers: { min_tier_n: number; min_tier_dMAE: number };
    Q8_injury_and_cap: { min_questionable_doubtful_dMAE: number; max_cap_hit_rate: number };
    Q9_leakage: { permutation: { shuffles: number; max_dMAE: number } };
  };
};

const r4 = (v: number): number | null => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 + 0 : null);

interface EvalRow {
  key: string; position: ShadowPosition; team: string; week: number; gsis: string; tier: "STARTER" | "FLEX" | "FRINGE";
  designation: "NONE" | "QUESTIONABLE" | "DOUBTFUL"; covered: boolean; capped: boolean; cond: number;
  champion: number; challenger: number; control: number; c2_full: number; delta: number; actual: number; rec: RoleShadowRecord;
}

export interface PositionReport {
  position: ShadowPosition;
  sufficiency: { weeks_with_outcomes: number; covered_with_outcomes: number; headline_with_outcomes: number; coverage_fraction: number | null; required_weeks: number; required_covered: number; required_coverage: number; met: boolean; unmet: string[] };
  metrics: Record<string, unknown> | null;
  gates: Record<string, { status: GateStatus; detail: Record<string, unknown> }>;
  verdict: G3Verdict;
}
export interface G3Report {
  report_version: typeof G3_REPORT_VERSION;
  prereg: { version: string; content_hash: string; ok: boolean };
  challenger: { model_id: string; config_hash: string };
  look: "INTERIM_DESCRIPTIVE" | "DECISION";
  input: Record<string, unknown>;
  missing_evidence: Record<string, unknown>;
  positions: Record<ShadowPosition, PositionReport>;
  verdict: G3Verdict;
  positions_qualified: ShadowPosition[]; positions_failed: ShadowPosition[]; positions_insufficient: ShadowPosition[];
  auto_promotion: false;
  notes: string[];
  report_digest: string;
}

const DNP_STATES = new Set(["DID_NOT_PLAY", "INACTIVE"]);

function pairedLight(rows: EvalRow[], a: (r: EvalRow) => number, b: (r: EvalRow) => number): Paired { return paired(rows, a, b, 0); }

export function evaluateG3(bundle: G3Bundle, opts: G3Options = {}): G3Report {
  const hash = opts.challenger_config_hash ?? PINNED.challenger_config_hash;
  const reps = opts.bootstrap_reps ?? 2000;
  const shuffles = opts.permutations ?? T.gates.Q9_leakage.permutation.shuffles;
  const notes: string[] = [];

  // ---- 1. validate + select the model version (never pooled across versions) ----------------------------------------------------------
  const versions: Record<string, number> = {};
  for (const r of bundle.records) versions[r.models?.challenger?.config_hash ?? "unknown"] = (versions[r.models?.challenger?.config_hash ?? "unknown"] ?? 0) + 1;
  const ofVersion = bundle.records.filter((r) => r.models?.challenger?.config_hash === hash);
  const invalid: Array<{ capture_id: string; reasons: string[] }> = [];
  const valid: RoleShadowRecord[] = [];
  for (const r of ofVersion) {
    const errs = validateRecord(r);
    if (errs.length) invalid.push({ capture_id: r.capture_id, reasons: errs.slice(0, 3) }); else valid.push(r);
  }
  const byClass: Record<string, number> = {};
  for (const r of valid) byClass[r.capture_class] = (byClass[r.capture_class] ?? 0) + 1;

  // ---- 2. eligible live decisions: one per (player, season, week, scoring fingerprint) = latest pre-kickoff capture -------------------
  const live = valid.filter((r) => r.capture_class === "LIVE_CAPTURED" && r.population.eligible);
  const chosen = new Map<string, RoleShadowRecord>();
  for (const r of [...live].sort((a, b) => (a.timing.captured_at < b.timing.captured_at ? -1 : a.timing.captured_at > b.timing.captured_at ? 1 : a.capture_id < b.capture_id ? -1 : 1))) {
    chosen.set(`${r.player.gsis_id}|${r.season}|${r.week}|${r.scoring.fingerprint}`, r); // ascending order: the last write is the latest capture
  }
  const decisionsList = [...chosen.values()];

  // ---- 3. join outcomes --------------------------------------------------------------------------------------------------------------------------
  const outIdx = new Map<string, OutcomeRow>();
  for (const o of [...bundle.outcomes].sort((a, b) => (a.case_ref < b.case_ref ? -1 : 1))) {
    const k = `${o.league_slug}|${o.season}|${o.week}|${o.canonical_player_id}`;
    const cur = outIdx.get(k);
    if (!cur || (cur.evidence_status !== "CERTIFIED" && o.evidence_status === "CERTIFIED")) outIdx.set(k, o);
  }
  let awaiting = 0, notEvaluable = 0, dnpImputed = 0;
  const rows: EvalRow[] = [];
  for (const r of decisionsList) {
    const o = outIdx.get(`${r.league_slug}|${r.season}|${r.week}|${r.player.canonical_player_id}`);
    if (!o) { awaiting++; continue; }
    let actual = o.actual_fantasy_points;
    if (o.evidence_status !== "CERTIFIED") { notEvaluable++; continue; }
    if (actual == null && DNP_STATES.has(o.participation_state)) { actual = 0; dnpImputed++; }
    if (actual == null || !Number.isFinite(actual)) { notEvaluable++; continue; }
    const pos = r.player.position as ShadowPosition;
    const nd = r.champion.injury.normalized_state;
    rows.push({
      key: `${r.player.gsis_id}|${r.season}|${r.week}`, position: pos, team: r.player.team ?? "?", week: r.week, gsis: r.player.gsis_id,
      tier: r.population.tier ?? "FRINGE", designation: nd === "QUESTIONABLE" ? "QUESTIONABLE" : nd === "DOUBTFUL" ? "DOUBTFUL" : "NONE",
      covered: r.population.covered, capped: r.arms.challenger.capped, cond: r.champion.conditional_active_points ?? 0,
      champion: r.champion.expected_points ?? 0, challenger: r.arms.challenger.expected_points ?? 0, control: r.arms.control.expected_points ?? 0, c2_full: r.arms.c2_full.expected_points ?? 0,
      delta: r.arms.challenger.delta, actual, rec: r,
    } as EvalRow);
  }
  const headline = rows.filter((x) => x.rec.population.headline);
  const unavailableRows = rows.filter((x) => !x.rec.population.headline);

  // ---- 4. per-position evaluation ----------------------------------------------------------------------------------------------------------
  const positions = {} as Record<ShadowPosition, PositionReport>;
  const S = T.sufficiency, G = T.gates;
  for (const pos of SHADOW_POSITIONS) {
    const hp = headline.filter((x) => x.position === pos);
    const covered = hp.filter((x) => x.covered);
    const weeks = new Set(hp.map((x) => x.week));
    const cov = hp.length ? covered.length / hp.length : null;
    const unmet: string[] = [];
    if (weeks.size < S.S1_min_completed_weeks_with_outcomes.value) unmet.push(`completed weeks with outcomes: ${weeks.size}/${S.S1_min_completed_weeks_with_outcomes.value}`);
    if (covered.length < S.S2_min_covered_decisions_with_outcomes.value[pos]) unmet.push(`covered decisions with outcomes: ${covered.length}/${S.S2_min_covered_decisions_with_outcomes.value[pos]}`);
    if (cov == null || cov < S.S2_min_coverage_fraction.value) unmet.push(`coverage ${cov == null ? "n/a" : r4(cov)} < ${S.S2_min_coverage_fraction.value}`);
    const met = unmet.length === 0;
    const sufficiency = { weeks_with_outcomes: weeks.size, covered_with_outcomes: covered.length, headline_with_outcomes: hp.length, coverage_fraction: cov == null ? null : r4(cov), required_weeks: S.S1_min_completed_weeks_with_outcomes.value, required_covered: S.S2_min_covered_decisions_with_outcomes.value[pos], required_coverage: S.S2_min_coverage_fraction.value, met, unmet };

    // descriptive metrics are always reported (clearly labeled interim when insufficient); GATES are evaluated only when sufficient
    let metrics: PositionReport["metrics"] = null;
    const gates: PositionReport["gates"] = {};
    if (hp.length > 0) {
      const ci = hp.length ? paired(hp, (x) => x.champion, (x) => x.challenger, reps) : null;
      const inc = paired(hp, (x) => x.control, (x) => x.challenger, reps);
      const drift = paired(hp, (x) => x.champion, (x) => x.control, 0);
      const full = paired(hp, (x) => x.control, (x) => x.c2_full, reps); // diagnostic: the offline T2b contrast (C2 vs C0)
      const dec = decisions(hp, (x) => x.champion, (x) => x.challenger);
      const tiers = Object.fromEntries((["STARTER", "FLEX", "FRINGE"] as const).map((t) => {
        const rs = hp.filter((x) => x.tier === t);
        return [t, { n: rs.length, dMAE: rs.length ? r4(pairedLight(rs, (x) => x.champion, (x) => x.challenger).dMAE) : null }];
      }));
      const qd = hp.filter((x) => x.designation !== "NONE");
      const qdD = qd.length ? pairedLight(qd, (x) => x.champion, (x) => x.challenger).dMAE : null;
      const unavail = unavailableRows.filter((x) => x.position === pos);
      const outNonZero = unavail.filter((x) => x.rec.arms.challenger.delta !== 0 || x.rec.arms.control.delta !== 0 || x.rec.arms.c2_full.delta !== 0).length;
      const capHit = covered.length ? covered.filter((x) => x.capped).length / covered.length : 0;
      // calibration stability: does the challenger's delta carry real signal about the champion's residual? (slope 1 = well calibrated, 0 = none)
      const resid = covered.map((x) => x.actual - x.champion);
      const den = covered.reduce((s, x) => s + x.delta * x.delta, 0);
      const slope = den > 0 ? covered.reduce((s, x, i) => s + resid[i]! * x.delta, 0) / den : null;
      const weekBias = (f: (x: EvalRow) => number) => Object.fromEntries([...weeks].sort((a, b) => a - b).map((w) => [w, r4(errStats(hp.filter((x) => x.week === w).map((x) => x.actual - f(x))).bias)]));

      // permutation control (Q9): shuffle the Role feature vectors among headline rows within (week, position); the real structure must matter
      const rnd = lcg(20261013);
      const permD: number[] = [];
      for (let s = 0; s < shuffles; s++) {
        const permuted = new Map<EvalRow, number>();
        const byWeek = new Map<number, EvalRow[]>();
        for (const x of hp) { const g = byWeek.get(x.week); if (g) g.push(x); else byWeek.set(x.week, [x]); }
        for (const g of byWeek.values()) {
          const idx = g.map((_, i) => i);
          for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j]!, idx[i]!]; }
          g.forEach((x, i) => {
            const src = g[idx[i]!]!.rec;
            const a = computeArms({ ...armsInputOf(x.rec), role: { confidence: x.rec.role.confidence, features: src.role.features }, unavailable: false });
            permuted.set(x, a.challenger.expected_points ?? x.champion);
          });
        }
        permD.push(pairedLight(hp, (x) => x.champion, (x) => permuted.get(x) ?? x.champion).dMAE);
      }
      const permMean = permD.length ? permD.reduce((a, b) => a + b, 0) / permD.length : NaN;

      metrics = {
        n_headline: hp.length, n_covered: covered.length, n_unavailable_checked: unavail.length,
        champion: { mae: r4(ci!.first.mae), rmse: r4(ci!.first.rmse), bias: r4(ci!.first.bias) },
        challenger: { mae: r4(ci!.second.mae), rmse: r4(ci!.second.rmse), bias: r4(ci!.second.bias) },
        control: { mae: r4(inc.first.mae), rmse: r4(inc.first.rmse), bias: r4(inc.first.bias) },
        champion_to_challenger: { dMAE: r4(ci!.dMAE), ci95: ci!.dMAE_ci.map((v) => r4(v)), dRMSE: r4(ci!.dRMSE), by_week: Object.fromEntries(Object.entries(ci!.weeks).map(([w, v]) => [w, r4(v)])) },
        control_to_challenger: { dMAE: r4(inc.dMAE), ci95: inc.dMAE_ci.map((v) => r4(v)) },
        champion_to_control_drift: { dMAE: r4(drift.dMAE) },
        diagnostic_c0_to_c2_full_offline_t2b_contrast: { dMAE: r4(full.dMAE), ci95: full.dMAE_ci.map((v) => r4(v)) },
        decisions: { pairs: dec.pairs, disagreements: dec.disagreements, decided: dec.decided, challenger_wins: dec.second_wins, champion_wins: dec.first_wins, ambiguous: dec.ambiguous, p_one_sided: r4(dec.p_one_sided) },
        by_tier: tiers,
        questionable_doubtful: { n: qd.length, dMAE: qdD == null ? null : r4(qdD) },
        out_rows: { n: unavail.length, nonzero_arm_deltas: outNonZero },
        cap_hit_rate: r4(capHit),
        calibration_stability: { delta_slope_on_champion_residual: slope == null ? null : r4(slope), champion_bias_by_week: weekBias((x) => x.champion), challenger_bias_by_week: weekBias((x) => x.challenger) },
        permutation_control: { shuffles: permD.length, mean_dMAE: r4(permMean) },
      };

      if (met) {
        const weeksPos = Object.values(ci!.weeks).filter((d) => d > 0).length;
        const nW = Object.keys(ci!.weeks).length;
        const g = (status: boolean, detail: Record<string, unknown>) => ({ status: (status ? "PASS" : "FAIL") as GateStatus, detail });
        gates.Q1_champion_vs_challenger = g(ci!.dMAE >= G.Q1_champion_vs_challenger.min_dMAE && ci!.dMAE_ci[0] > 0, { dMAE: r4(ci!.dMAE), ci_lower: r4(ci!.dMAE_ci[0]) });
        // The frozen control carries a baseline-drift term fitted on the PROXY baseline; on a real-source baseline it can be WORSE than doing nothing,
        // which makes "beats the control" easy. Q2 is therefore only INFORMATIVE when the control is not itself worse than the champion; it never
        // qualifies anything alone (Q1, against the champion, binds), and the flag is reported so a reader cannot mistake an easy win for Role evidence.
        const controlWorse = drift.dMAE < -G.Q3_rmse.max_rmse_excess;
        gates.Q2_control_vs_challenger = g(inc.dMAE >= G.Q2_control_vs_challenger.min_dMAE && inc.dMAE_ci[0] > 0, { dMAE: r4(inc.dMAE), ci_lower: r4(inc.dMAE_ci[0]), control_vs_champion_dMAE: r4(drift.dMAE), informative: !controlWorse });
        gates.Q3_rmse = g(ci!.second.rmse <= ci!.first.rmse + G.Q3_rmse.max_rmse_excess, { champion: r4(ci!.first.rmse), challenger: r4(ci!.second.rmse) });
        gates.Q4_relative_bias = g(Math.abs(ci!.second.bias) <= Math.abs(ci!.first.bias) + G.Q4_relative_bias.max_abs_bias_excess_over_champion, { champion: r4(ci!.first.bias), challenger: r4(ci!.second.bias) });
        gates.Q5_week_consistency = g(nW > 0 && weeksPos / nW >= G.Q5_week_consistency.min_fraction_of_weeks_positive, { positive_weeks: weeksPos, weeks: nW });
        gates.Q6_decisions = dec.decided < G.Q6_decisions.min_decided_pairs
          ? { status: "INSUFFICIENT_EVIDENCE", detail: { decided: dec.decided, required: G.Q6_decisions.min_decided_pairs } }
          : g(dec.second_wins >= dec.first_wins && dec.p_one_sided < G.Q6_decisions.max_p_one_sided, { decided: dec.decided, challenger_wins: dec.second_wins, champion_wins: dec.first_wins, p: r4(dec.p_one_sided) });
        const badTier = Object.entries(tiers).filter(([, v]) => v.n >= G.Q7_tiers.min_tier_n && v.dMAE != null && v.dMAE < G.Q7_tiers.min_tier_dMAE);
        gates.Q7_tiers = g(badTier.length === 0, { tiers });
        gates.Q8_injury_and_cap = g((qdD == null || qdD >= G.Q8_injury_and_cap.min_questionable_doubtful_dMAE) && outNonZero === 0 && capHit <= G.Q8_injury_and_cap.max_cap_hit_rate, { qd_dMAE: qdD == null ? null : r4(qdD), out_nonzero: outNonZero, cap_hit_rate: r4(capHit) });
        gates.Q9_leakage = g(permMean <= G.Q9_leakage.permutation.max_dMAE, { permutation_mean_dMAE: r4(permMean), all_records_revalidated: invalid.length === 0 });
        gates.Q10_robustness_std_ppr = { status: "NOT_EVALUABLE", detail: { reason: "needs STD/PPR leagues with their own frozen fits (g3-prereg.json)" } };
      }
    }
    // a failed gate is a FAIL; a gate that lacks the data to be judged (Q6 below the pair minimum) is INSUFFICIENT — never a fail, never a pass
    const anyFail = Object.values(gates).some((x) => x.status === "FAIL");
    const anyInsufficient = Object.values(gates).some((x) => x.status === "INSUFFICIENT_EVIDENCE");
    const verdict: G3Verdict = !met ? "G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE" : anyFail ? "G3_FAIL" : anyInsufficient ? "G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE" : "G3_QUALIFIED_FOR_HUMAN_REVIEW";
    positions[pos] = { position: pos, sufficiency, metrics, gates, verdict };
  }
  void binomUpper;

  // ---- 5. missing-evidence patterns (over every validated record of this version, undeduplicated) ---------------------------------------------
  const tally = (f: (r: RoleShadowRecord) => string): Record<string, number> => { const m: Record<string, number> = {}; for (const r of valid) { const k = f(r); m[k] = (m[k] ?? 0) + 1; } return Object.fromEntries(Object.entries(m).sort()); };
  const reasons: Record<string, number> = {};
  for (const r of valid) for (const x of r.population.reasons) reasons[x] = (reasons[x] ?? 0) + 1;
  const missing_evidence = {
    by_arm_state: tally((r) => r.arms.shared_state), by_role_confidence: tally((r) => r.role.confidence), by_scoring_compatibility: tally((r) => r.scoring.compatibility),
    by_join_method: tally((r) => r.player.join_method), by_position: tally((r) => r.player.position), by_league: tally((r) => r.league_slug), ineligibility_reasons: Object.fromEntries(Object.entries(reasons).sort()),
    note: "late / invalid-at-capture candidates are REJECTED at the door (never stored) and are counted in each capture run's summary, not here",
  };
  const weeksAll = new Set(rows.map((x) => x.week));
  const perPos = SHADOW_POSITIONS.map((p) => positions[p]);
  const qualified = SHADOW_POSITIONS.filter((p) => positions[p].verdict === "G3_QUALIFIED_FOR_HUMAN_REVIEW");
  const failed = SHADOW_POSITIONS.filter((p) => positions[p].verdict === "G3_FAIL");
  const insufficient = SHADOW_POSITIONS.filter((p) => positions[p].verdict === "G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE");
  const anySufficient = perPos.some((p) => p.sufficiency.met);
  const verdict: G3Verdict = qualified.length ? "G3_QUALIFIED_FOR_HUMAN_REVIEW" : failed.length ? "G3_FAIL" : "G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE";
  if (!preregHashOk()) notes.push("g3-prereg.json content hash differs from the pinned value: thresholds may have been edited after freeze — treat this report as invalid");
  if (!anySufficient) notes.push("Descriptive only (INTERIM): no position has met prospective sufficiency, so no gate was evaluated and nothing here is qualification evidence.");
  if (Object.keys(versions).length > 1) notes.push(`records of ${Object.keys(versions).length} model config hashes exist; only ${hash} was evaluated (versions are never pooled)`);

  const body = {
    report_version: G3_REPORT_VERSION,
    prereg: { version: (prereg as { g3_prereg_version: string }).g3_prereg_version, content_hash: contentHash(prereg).slice(0, 32), ok: preregHashOk() },
    challenger: { model_id: "role-opportunity-challenger-2026.0", config_hash: hash },
    look: (anySufficient ? "DECISION" : "INTERIM_DESCRIPTIVE") as G3Report["look"],
    input: {
      records_total: bundle.records.length, versions_present: versions, records_of_version: ofVersion.length, invalid_excluded: invalid.length, invalid_examples: invalid.slice(0, 5), by_class: byClass,
      live_eligible: live.length, decisions_after_dedupe: decisionsList.length, outcomes_joined: rows.length, awaiting_outcome: awaiting, outcome_not_evaluable: notEvaluable, dnp_zero_imputed: dnpImputed,
      weeks_with_outcomes: [...weeksAll].sort((a, b) => a - b), outcome_refs_digest: contentHash(rows.map((x) => x.rec.capture_id).sort()).slice(0, 16),
    },
    missing_evidence, positions, verdict, positions_qualified: qualified, positions_failed: failed, positions_insufficient: insufficient, auto_promotion: false as const, notes,
  };
  return { ...body, report_digest: contentHash(body).slice(0, 32) } as G3Report;
}
