/**
 * Phase 5 — canonical DEFENSIVE PROFILE (coverage, shells, pressure, box/front, explosives, pass-area concession, run, unit coverage, red zone).
 * Every value is an OBSERVED tendency with its league rank among the 32 defenses and an evidence tier; source-native buckets are preserved
 * (Cover 0/1/2/3/4/6, two-man) and never blended into invented shells. Built from the shared MatchupContext (once per game).
 */
import type { EvidenceTier } from "./contract";
import type { MatchupContext } from "./context";
import type { DefenseEvidence, Row } from "./source";
import { mean, rankDesc, round } from "./stats";
import { DEF_CHARTED_MODERATE, DEF_CHARTED_STRONG, DEF_CHARTED_WEAK } from "./thresholds";

export interface ProfileValue { key: string; value: number | null; league_mean: number | null; rank_high_to_low: number | null; of: number; evidence: EvidenceTier; n: number | null }
export interface DefenseProfile {
  team: string; window: string; defense_window_note: string;
  coverage: { man_zone: ProfileValue[]; shells_source_native: ProfileValue[]; source_conflict: string | null };
  pressure: ProfileValue[]; box: ProfileValue[]; explosive: ProfileValue[];
  pass_concession_by_depth: Array<{ depth_bin: string; target_share: number | null; epa_per_target: number | null; explosive_rate: number | null; epa_vs_league: number | null; evidence: EvidenceTier }>;
  run: { direction: Array<{ field_third: string; epa_per_rush: number | null; vs_league: number | null; stuff_rate: number | null; evidence: EvidenceTier }>; gap: Array<{ run_gap: string; epa_per_rush: number | null; vs_league: number | null; evidence: EvidenceTier }> };
  unit_coverage: Array<{ position: "RB" | "WR" | "TE"; epa_allowed_modeled: number | null; league_percentile_best_defense_1: number | null; predictive_status: string | null; confidence: string | null }>;
  red_zone: { td_rate_allowed_modeled: number | null; league_percentile_best_defense_1: number | null; predictive_status: string | null };
  scheme_era: { reset_hint: boolean | null; coordinator_known: boolean | null };
  shape: string[];
  unsupported: string[];
}
const tierN = (n: number | null): EvidenceTier => (n == null ? "INSUFFICIENT" : n >= DEF_CHARTED_STRONG ? "STRONG" : n >= DEF_CHARTED_MODERATE ? "MODERATE" : n >= DEF_CHARTED_WEAK ? "WEAK" : "INSUFFICIENT");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const MZ = ["man_zone__man_rate", "man_zone__zone_rate"]; const SHELLS = ["coverage_family__cover_0", "coverage_family__cover_1", "coverage_family__cover_2", "coverage_family__cover_3", "coverage_family__cover_4", "coverage_family__cover_6", "coverage_family__two_man"];
const PRESS = ["pressure__pressure_rate_generated", "pressure__blitz_proxy_rate", "pressure__pressure_without_heavy_blitz_rate"]; const BOX = ["box__mean_box_deployed", "box__heavy_box_rate"]; const EXPL = ["live__explosive_pass_allowed", "live__explosive_rush_allowed"];

function pv(ctx: MatchupContext, d: DefenseEvidence, w: string, keys: string[], nKey: string): ProfileValue[] {
  const row: Row | undefined = d.tendency[w] ?? d.tendency.career; const n = num(row?.[nKey]);
  return keys.map((k) => { const all = ctx.league.teams.map((t) => num(ctx.league.defenses.get(t)?.tendency[w]?.[k] ?? ctx.league.defenses.get(t)?.tendency.career?.[k])).filter((x): x is number => x != null); const v = num(row?.[k]);
    return { key: k.split("__")[1] ?? k, value: round(v), league_mean: round(mean(all)), rank_high_to_low: rankDesc(v, all), of: all.length, evidence: v == null ? "INSUFFICIENT" : tierN(n), n }; });
}
export function buildDefenseProfile(ctx: MatchupContext, window = "recent"): DefenseProfile | null {
  const d = ctx.defense; if (!d) return null; const w = d.tendency[window] ? window : "career"; const mz = pv(ctx, d, w, MZ, "man_zone__charted_mz");
  const cell = (dw: string) => ["BEHIND_LOS", "SHORT", "INTERMEDIATE", "DEEP"].map((depth) => { const rows = d.pass_cells.filter((c) => c.window === dw && c.depth_bin === depth); const tot = rows.reduce((a, c) => a + (c.targets ?? 0), 0); const ws = (f: (c: (typeof rows)[number]) => number | null) => (tot > 0 ? rows.reduce((a, c) => a + (f(c) ?? 0) * (c.targets ?? 0), 0) / tot : null);
    const lg = mean(ctx.league.teams.map((t) => { const rs = ctx.league.defenses.get(t)?.pass_cells.filter((c) => c.window === dw && c.depth_bin === depth) ?? []; const tt = rs.reduce((a, c) => a + (c.targets ?? 0), 0); return tt > 0 ? rs.reduce((a, c) => a + (c.epa ?? 0) * (c.targets ?? 0), 0) / tt : NaN; }).filter((x) => Number.isFinite(x)));
    const epa = ws((c) => c.epa); return { depth_bin: depth, target_share: round(ws((c) => c.share) == null ? null : rows.reduce((a, c) => a + (c.share ?? 0), 0)), epa_per_target: round(epa), explosive_rate: round(ws((c) => c.explosive)), epa_vs_league: epa == null || lg == null ? null : round(epa - lg), evidence: (tot >= 400 ? "STRONG" : tot >= 200 ? "MODERATE" : tot >= 80 ? "WEAK" : "INSUFFICIENT") as EvidenceTier }; });
  const pw = d.pass_cells.some((c) => c.window === w) ? w : "career"; const pass = cell(pw);
  const rw = d.rush_direction.some((r) => r.window === w) ? w : "career"; const rgw = d.rush_gap.some((r) => r.window === w) ? w : "career";
  const lgDir = (t: string) => mean(ctx.league.teams.map((x) => ctx.league.defenses.get(x)?.rush_direction.find((r) => r.window === rw && r.field_third === t)?.epa).filter((x): x is number => x != null)); const lgGap = (g: string) => mean(ctx.league.teams.map((x) => ctx.league.defenses.get(x)?.rush_gap.find((r) => r.window === rgw && r.run_gap === g)?.epa).filter((x): x is number => x != null));
  const era = d.scheme_era.at(-1); const shape: string[] = []; const short = pass.find((p) => p.depth_bin === "SHORT"); const deep = pass.find((p) => p.depth_bin === "DEEP");
  if (short?.epa_vs_league != null && deep?.epa_vs_league != null && short.evidence !== "INSUFFICIENT" && deep.evidence !== "INSUFFICIENT") { if (short.epa_vs_league > 0 && deep.epa_vs_league < 0) shape.push("concedes underneath efficiency while suppressing deep efficiency"); else if (short.epa_vs_league < 0 && deep.epa_vs_league > 0) shape.push("suppresses underneath efficiency but is vulnerable deep"); }
  const man = mz.find((x) => x.key === "man_rate"); if (man?.rank_high_to_low != null && man.evidence !== "INSUFFICIENT") { if (man.rank_high_to_low <= 6) shape.push("man-heavy relative to the league"); else if (man.rank_high_to_low >= man.of - 5) shape.push("zone-heavy relative to the league"); }
  return { team: d.team, window: w, defense_window_note: `tendency window ${w}; pass cells ${pw}; run ${rw}; gap ${rgw}`,
    coverage: { man_zone: mz, shells_source_native: pv(ctx, d, w, SHELLS, "coverage_family__charted_cov"), source_conflict: null }, pressure: pv(ctx, d, w, PRESS, "pressure__charted_pressure"), box: pv(ctx, d, w, BOX, "pressure__charted_pressure"), explosive: pv(ctx, d, w, EXPL, "live__plays_faced"), pass_concession_by_depth: pass,
    run: { direction: ["LEFT", "MIDDLE", "RIGHT"].map((t) => { const r = d.rush_direction.find((x) => x.window === rw && x.field_third === t); const l = lgDir(t); return { field_third: t, epa_per_rush: round(r?.epa ?? null), vs_league: r?.epa == null || l == null ? null : round(r.epa - l), stuff_rate: round(r?.stuff ?? null), evidence: r?.evidence ?? "INSUFFICIENT" }; }), gap: ["END", "TACKLE", "GUARD"].map((g) => { const r = d.rush_gap.find((x) => x.window === rgw && x.run_gap === g); const l = lgGap(g); return { run_gap: g, epa_per_rush: round(r?.epa ?? null), vs_league: r?.epa == null || l == null ? null : round(r.epa - l), evidence: r?.evidence ?? "INSUFFICIENT" }; }) },
    unit_coverage: (["RB", "WR", "TE"] as const).map((p) => ({ position: p, epa_allowed_modeled: round(d.fi_unit_coverage[p]?.modeled ?? null), league_percentile_best_defense_1: round(d.fi_unit_coverage[p]?.league_percentile ?? null), predictive_status: d.fi_unit_coverage[p]?.predictive_status ?? null, confidence: d.fi_unit_coverage[p]?.confidence ?? null })),
    red_zone: { td_rate_allowed_modeled: round(d.fi_defense.def_rz_td_rate_allowed?.modeled ?? null), league_percentile_best_defense_1: round(d.fi_defense.def_rz_td_rate_allowed?.league_percentile ?? null), predictive_status: d.fi_defense.def_rz_td_rate_allowed?.predictive_status ?? null },
    scheme_era: { reset_hint: typeof era?.scheme_reset_hint === "boolean" ? era.scheme_reset_hint : null, coordinator_known: typeof era?.coordinator_known === "boolean" ? era.coordinator_known : null },
    shape, unsupported: ["front alignment", "personnel response", "slot/perimeter defense", "cornerback assignment", "run-scheme (zone/gap/power) splits", "2026 in-season charting"] };
}
