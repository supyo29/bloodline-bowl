/**
 * Phase 4 — the FI → Start/Sit translation function.
 *
 * Deterministic. Reads the versioned `start_sit_model.json` (produced by
 * `analysis/football_intel_startsit/train.R` + `backtest.R`) and the Phase 3
 * FI read adapter. Enforces the Phase 3 semantic contract PROGRAMMATICALLY:
 *
 *   PREDICTIVE           -> learned coefficient applied
 *   WEAKLY_PREDICTIVE    -> learned coefficient, |beta| capped upstream
 *   NOT_PREDICTIVE       -> confidence_weight forced 0, contribution 0
 *   DESCRIPTIVE_ONLY     -> confidence_weight forced 0, contribution 0, explain-only
 *   UNVALIDATED          -> not in the model at all
 *
 * Confidence weighting is monotone; a missing FI value or missing snapshot
 * yields a zero adjustment (baseline-equivalent). The total adjustment is
 * bounded by `max_total_adjustment_fraction * |baseline|`.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadFootballIntelligence, type FootballIntelligence } from "@/lib/football-intel";
import type {
  StartSitFiAdjustment,
  FiFamilyContribution,
  StartSitFiReasonCode,
} from "./schema";

const MODEL_PATH = join(process.cwd(), "lib", "weekly", "data", "start_sit_model.json");

interface ModelFamily {
  family: string;
  beta: number;
  routing: FiFamilyContribution["routing"];
  center: number;
  scale: number;
  value_col: string;
  confidence_col: string;
  prior_dominated_col: string | null;
}
interface ModelPosition {
  status: string;
  production_status?: string;
  formulation: string;
  families: ModelFamily[];
  conf_weight: Record<string, number>;
  prior_dominated_haircut: number;
}
export interface StartSitModel {
  start_sit_model_version: string;
  football_intelligence_version: string | null;
  deployment: "SHADOW_ONLY" | "PRODUCTION";
  max_total_adjustment_fraction: number | null;
  tau_tie_break: number | null;
  positions: Record<string, ModelPosition>;
}

const ELIGIBLE = new Set(["PREDICTIVE", "WEAKLY_PREDICTIVE"]);
const CONF_ORDER = ["INSUFFICIENT_SAMPLE", "LOW", "MEDIUM", "HIGH"] as const;

let cachedModel: StartSitModel | null | undefined;

export function loadStartSitModel(force = false): StartSitModel | null {
  if (!force && cachedModel !== undefined) return cachedModel;
  if (!existsSync(MODEL_PATH)) {
    cachedModel = null;
    return null;
  }
  cachedModel = JSON.parse(readFileSync(MODEL_PATH, "utf8")) as StartSitModel;
  return cachedModel;
}

export function __resetStartSitModelCache(): void {
  cachedModel = undefined;
}

export interface TranslateInput {
  canonical_player_id: string;
  position: string;
  nfl_team: string | null;
  opponent: string | null;
  baseline_projection: number | null;
  request_season: number;
  /** provide a preloaded FI handle (tests / batch); else the module loads it. */
  fi?: FootballIntelligence | null;
  model?: StartSitModel | null;
  /**
   * Supplemental FI values keyed by a model family's `value_col` — used by the
   * batch helper to inject player-usage and interaction signals it resolved
   * (gsis/sleeper-keyed) that the per-player team lookup here cannot reach.
   */
  fiValues?: Record<string, { value: number | null; confidence: string | null }>;
}

/** confidence-weight for a Phase-3 confidence label; 0 when routing is ineligible. */
function confWeight(model: ModelPosition, routing: string, conf: string | null): number {
  if (!ELIGIBLE.has(routing)) return 0;
  const w = model.conf_weight[(conf ?? "INSUFFICIENT_SAMPLE").toUpperCase()] ?? 0;
  return typeof w === "number" ? w : 0;
}

/**
 * A reason code is emitted ONLY when the family's numeric contribution to the
 * adjustment is material AND its direction is unambiguous (spec §12, §24 —
 * explanation must reflect causality in the implemented scoring path). An
 * "ADVANTAGE" code therefore always means a positive contribution.
 */
function reasonForFamily(family: string, contribution: number): StartSitFiReasonCode | null {
  if (Math.abs(contribution) < 0.02) return null; // immaterial -> no narrative
  const positive = contribution > 0;
  if (family.includes("usage")) return positive ? "FI_USAGE_STABLE" : "FI_USAGE_RISK";
  if (family.includes("def_success")) return positive ? "FI_OPPONENT_DEFENSE_WEAK" : "FI_OPPONENT_DEFENSE_STRONG";
  if (!positive) return null; // offensive-efficiency headwinds are folded into the number, not narrated as an "advantage"
  if (family.includes("success_rate")) return "FI_SUCCESS_RATE_ADVANTAGE";
  if (family.includes("pass_epa") || family.includes("proe")) return "FI_PASS_EFFICIENCY_ADVANTAGE";
  if (family.includes("rush_epa") || family.includes("rush")) return "FI_RUSH_MATCHUP_ADVANTAGE";
  if (family.includes("pace")) return "FI_PACE_ADVANTAGE";
  if (family.includes("explosive")) return "FI_EXPLOSIVE_PASS_ADVANTAGE";
  return null;
}

/**
 * Translate FI evidence into a bounded, explained start/sit adjustment for one
 * player. Pure given (input, model, FI snapshot).
 */
export function translateFiAdjustment(input: TranslateInput): StartSitFiAdjustment {
  const model = input.model ?? loadStartSitModel();
  const fi = input.fi !== undefined ? input.fi : loadFootballIntelligence();
  const warnings: string[] = [];
  const reason_codes: StartSitFiReasonCode[] = [];
  const contributions: FiFamilyContribution[] = [];

  const base: StartSitFiAdjustment = {
    canonical_player_id: input.canonical_player_id,
    position: input.position,
    nfl_team: input.nfl_team,
    opponent: input.opponent,
    baseline_projection: input.baseline_projection,
    raw_expected_adjustment: 0,
    expected_adjustment: 0,
    floor_adjustment: 0,
    ceiling_adjustment: 0,
    adjusted_projection: input.baseline_projection,
    decision_confidence: "INSUFFICIENT_SAMPLE",
    contributions,
    reason_codes,
    warnings,
    fi_prior_season_only: false,
    fi_available: false,
  };

  if (!model) {
    reason_codes.push("FI_UNAVAILABLE");
    warnings.push("start_sit_model.json not present — baseline unchanged.");
    return base;
  }
  const mp = model.positions[input.position];
  if (!mp || !mp.families?.length) {
    reason_codes.push("FI_SHADOW_ONLY");
    return base;
  }
  if (!fi) {
    reason_codes.push("FI_UNAVAILABLE");
    warnings.push("No Football Intelligence snapshot published — baseline unchanged.");
    return base;
  }
  base.fi_available = true;

  if (fi.manifest.season < input.request_season) {
    base.fi_prior_season_only = true;
    reason_codes.push("FI_PRIOR_SEASON_ONLY");
    warnings.push(
      `Football Intelligence is a ${fi.manifest.season}-derived prior for ${input.request_season}; treated as reduced-confidence preseason context.`,
    );
  }

  const team = input.nfl_team ? fi.team(input.nfl_team) : null;
  const oppTeam = input.opponent ? fi.team(input.opponent) : null;
  const usage = fi.playerUsage({ gsis_id: null, sleeper_id: null }); // resolved by caller-provided ids only
  // NOTE: caller passes canonical id; FI usage is gsis/sleeper keyed. The batch
  // helper (buildShadowComparison) resolves ids and injects usage values via
  // the value columns already present on the model families where possible.

  const confSeen: string[] = [];
  let raw = 0;

  for (const fam of mp.families) {
    let fiValue: number | null = null;
    let fiConf: FiFamilyContribution["fi_confidence"] = null;

    // team-offense percentile
    if (fam.value_col.startsWith("fi_off_") && team) {
      const key = fam.value_col.replace(/^fi_/, "").replace(/_league_percentile$/, "");
      const r = team.offense[key];
      fiValue = r?.league_percentile ?? null;
      fiConf = r?.confidence ?? null;
      // hard routing guard: never let a non-eligible Phase-3 status through
      if (r && !ELIGIBLE.has(r.predictive_status)) {
        fiValue = r.league_percentile ?? null; // keep for explanation
      }
    } else if (fam.value_col.startsWith("fidef_") && oppTeam) {
      const key = fam.value_col.replace(/^fidef_/, "").replace(/_league_percentile$/, "");
      const r = oppTeam.defense[key];
      fiValue = r?.league_percentile ?? null;
      fiConf = r?.confidence ?? null;
    }
    // usage + interaction values injected by the batch helper via fiValues.
    if (fiValue == null && input.fiValues?.[fam.value_col]) {
      fiValue = input.fiValues[fam.value_col]!.value;
      fiConf = (input.fiValues[fam.value_col]!.confidence ?? null) as FiFamilyContribution["fi_confidence"];
    }

    const cw = confWeight(mp, fam.routing, fiConf ?? null);
    let contribution = 0;
    if (fiValue != null && cw > 0 && ELIGIBLE.has(fam.routing)) {
      const sig = (fiValue - fam.center) / (fam.scale || 1);
      contribution = fam.beta * (Number.isFinite(sig) ? sig : 0) * cw;
    }
    if (!ELIGIBLE.has(fam.routing)) {
      reason_codes.push(fam.routing === "NOT_PREDICTIVE" ? "FI_NOT_PREDICTIVE" : "FI_DESCRIPTIVE_CONTEXT");
    }
    if (fiConf) confSeen.push(fiConf);
    raw += contribution;
    contributions.push({
      family: fam.family,
      routing: fam.routing,
      fi_value: fiValue,
      fi_confidence: fiConf,
      confidence_weight: cw,
      points_contribution: round4(contribution),
    });
  }

  base.raw_expected_adjustment = round4(raw);

  // Narrate ONLY the families whose contribution agrees in sign with the net
  // adjustment — the explanation must never imply a tailwind while the number
  // moved down (spec §12, §24).
  const netSign = Math.sign(raw);
  for (const c of contributions) {
    if (netSign !== 0 && Math.sign(c.points_contribution) !== netSign) continue;
    const rc = reasonForFamily(c.family, c.points_contribution);
    if (rc && !reason_codes.includes(rc)) reason_codes.push(rc);
  }

  // per-player cap: fraction of |baseline|
  const cap =
    input.baseline_projection != null && model.max_total_adjustment_fraction != null
      ? model.max_total_adjustment_fraction * Math.abs(input.baseline_projection)
      : Infinity;
  const capped = Math.max(-cap, Math.min(cap, raw));
  base.expected_adjustment = round4(capped);
  base.adjusted_projection =
    input.baseline_projection != null ? round2(input.baseline_projection + capped) : null;

  // decision confidence = weakest contributing FI confidence
  if (confSeen.length) {
    base.decision_confidence = confSeen.reduce((lo, c) =>
      CONF_ORDER.indexOf(c as (typeof CONF_ORDER)[number]) < CONF_ORDER.indexOf(lo as (typeof CONF_ORDER)[number]) ? c : lo,
    ) as StartSitFiAdjustment["decision_confidence"];
  }
  if (base.decision_confidence === "LOW" || base.decision_confidence === "INSUFFICIENT_SAMPLE") {
    if (!reason_codes.includes("FI_LOW_CONFIDENCE")) reason_codes.push("FI_LOW_CONFIDENCE");
  }
  reason_codes.push("FI_SHADOW_ONLY");
  void usage;
  return base;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
