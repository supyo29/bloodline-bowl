/**
 * Phase 5 Checkpoints C + D — position-aware interaction FAMILIES. Every component is (a) computed for THIS defense and for ALL other
 * defenses using the SAME player profile, so `z`/`rank` are player-specific by construction (a strong defense can still be favourable for a
 * given role), (b) labelled with origin / history class / predictive class from the registry, (c) uncertainty-tagged, and (d) never
 * collapsed into a composite. Unsupported detail is not fabricated (see unsupported.ts).
 */
import type { Direction, EvidenceTier, InteractionComponent, Position, UncertaintySource } from "./contract";
import { familyById } from "./registry";
import type { MatchupContext } from "./context";
import type { DefenseEvidence, PlayerEvidence, SplitRow } from "./source";
import { mean, minTier, rankDesc, round, sd, tierAtLeast, zAmong } from "./stats";
import { evaluationFor, evaluationLine } from "./evaluation";
import { MATERIAL_VALUE, DEF_CHARTED_MODERATE, DEF_CHARTED_STRONG, DEF_CHARTED_WEAK, MAJOR_CELL_SHARE, MIN_COVERED_SHARE, MIN_DEFENSES_FOR_Z, MINOR_RECEIVING_ROLE, RZ_ROLE_MATERIAL_REC, RZ_ROLE_MATERIAL_RUSH, Z_MATERIAL } from "./thresholds";

interface Calc { value: number | null; inputs: Record<string, number | string | null>; evidence: EvidenceTier; window: string | null; limitations?: string[]; sens?: InteractionComponent["sensitivity"] }
type ValueFn = (d: DefenseEvidence) => Calc | null;
const chartedTier = (n: unknown): EvidenceTier => { const v = typeof n === "number" ? n : 0; return v >= DEF_CHARTED_STRONG ? "STRONG" : v >= DEF_CHARTED_MODERATE ? "MODERATE" : v >= DEF_CHARTED_WEAK ? "WEAK" : "INSUFFICIENT"; };
const fiTier = (c: string | null | undefined): EvidenceTier => (c === "HIGH" ? "STRONG" : c === "MEDIUM" ? "MODERATE" : c === "LOW" ? "WEAK" : "INSUFFICIENT");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** prefer the recent window when both sides have usable rows; otherwise career. */
/** Only the two prior-season-aggregate windows are admissible: any other window label (a current/future window) is ignored, never used as-of evidence. */
function windowFor(windows: string[]): string | null { return windows.includes("recent") ? "recent" : windows.includes("career") ? "career" : null; }
const defWin = (d: DefenseEvidence, w: string | null): string | null => (w && d.tendency[w] ? w : d.tendency.career ? "career" : Object.keys(d.tendency)[0] ?? null);

export function uncertaintyFor(ctx: MatchupContext, o: { evidence: EvidenceTier; position?: Position | "TEAM"; player?: PlayerEvidence | null; generic?: boolean; expectation?: boolean }): UncertaintySource[] {
  const u: UncertaintySource[] = [];
  const psi = ctx.vintage.find((v) => v.source === "player-scheme"); const fi = ctx.vintage.find((v) => v.source === "football-intelligence");
  if (psi?.availability === "PRIOR_ONLY") u.push({ kind: "PRIOR_ONLY_CURRENT_SEASON", level: "MEDIUM", note: `player/defense charting is through ${psi.season} w${psi.through_week}; no ${ctx.game.season} observation yet` });
  if (psi && fi && psi.season != null && fi.season != null && (psi.season !== fi.season || (psi.through_week ?? 0) !== (fi.through_week ?? 0))) u.push({ kind: "MIXED_VINTAGE", level: "LOW", note: `Player-Scheme ${psi.season} w${psi.through_week} vs Football Intelligence ${fi.season} w${fi.through_week}: different vintages, never blended` });
  if (o.evidence === "INSUFFICIENT" || o.evidence === "WEAK") u.push({ kind: "SMALL_SAMPLE", level: o.evidence === "INSUFFICIENT" ? "HIGH" : "MEDIUM", note: `evidence tier ${o.evidence}` });
  const dEra = ctx.defense?.scheme_era.at(-1); if (dEra && dEra.scheme_reset_hint === true) u.push({ kind: "SCHEME_RESET_HINT", level: "MEDIUM", note: "defensive scheme reset hinted for this season: prior tendencies may not persist" });
  const oEra = ctx.offense?.scheme_era.at(-1); if (oEra && (oEra.scheme_reset_hint === true || oEra.starting_qb_changed === true)) u.push({ kind: oEra.starting_qb_changed === true ? "QB_CHANGE" : "SCHEME_RESET_HINT", level: "MEDIUM", note: "offensive scheme reset or starting-QB change hinted: the player's profile was built under a different environment" });
  const r = o.player?.role; if (r && ((r.role_evidence && r.role_evidence !== "OBSERVED") || (r.role_trend && r.role_trend !== "STABLE"))) u.push({ kind: "ROLE_INSTABILITY", level: "MEDIUM", note: `role evidence ${r.role_evidence ?? "n/a"}, trend ${r.role_trend ?? "n/a"}` });
  if (o.player && !o.player.role) u.push({ kind: "ROLE_INSTABILITY", level: "LOW", note: "no Role & Opportunity profile for this player" });
  if (o.generic) u.push({ kind: "GENERIC_PROXY_ONLY", level: "MEDIUM", note: "unit-level (position-group) evidence: not an individual defender" });
  if (o.expectation) u.push({ kind: "BASELINE_ONLY_EXPECTATION", level: "HIGH", note: "no game-specific conditioning input (formation/personnel, opposing QB, alignment) exists: the expectation is the defense's baseline" });
  return u;
}

interface Def { material: number; id: string; registry: string; position: Position | "TEAM"; title: string; unit: string; origin?: InteractionComponent["origin"]; player?: PlayerEvidence | null; generic?: boolean; expectation?: boolean }
function component(ctx: MatchupContext, d: Def, fn: ValueFn, extraLimits: string[] = []): InteractionComponent {
  const fam = familyById(d.registry); const dev = ctx.defense; const league = ctx.league;
  const mine = dev ? fn(dev) : null;
  const all: number[] = []; for (const t of league.teams) { const de = league.defenses.get(t); const c = de ? fn(de) : null; if (c?.value != null) all.push(c.value); }
  const enough = all.length >= MIN_DEFENSES_FOR_Z; const z = enough ? zAmong(mine?.value ?? null, all) : null;
  const usable = mine != null && mine.value != null && tierAtLeast(mine.evidence, "WEAK");
  const material = mine?.value != null && Math.abs(mine.value) >= d.material; const direction: Direction = !usable || z == null ? "UNDETERMINED" : !material ? "NEUTRAL" : z >= Z_MATERIAL ? "ADVANTAGE" : z <= -Z_MATERIAL ? "DISADVANTAGE" : "NEUTRAL";
  const evidence = mine?.evidence ?? "INSUFFICIENT"; const evalRow = d.position === "TEAM" ? null : evaluationFor(d.registry, d.position);
  return { id: d.id, family: d.registry, position: d.position, title: d.title, origin: d.origin ?? fam?.origin ?? "DESCRIPTIVE_CONTEXT", history_class: fam?.history_class ?? "UNSAFE_FOR_BACKTEST", predictive_class: evalRow && evalRow.status !== "PREDICTIVE_INCREMENTAL" && (fam?.predictive_class ?? "") === "PREDICTIVE_CANDIDATE_UNVALIDATED" ? "EVALUATED_NO_INCREMENTAL_VALUE" : fam?.predictive_class ?? "DESCRIPTIVE_CONTEXT",
    direction, value: round(mine?.value ?? null), unit: d.unit, z: round(z, 3), rank_among_defenses: enough ? rankDesc(mine?.value ?? null, all) : null, evidence, window: mine?.window ?? null,
    inputs: mine?.inputs ?? {}, sensitivity: mine?.sens ?? [], uncertainty: uncertaintyFor(ctx, { evidence, position: d.position, player: d.player, generic: d.generic, expectation: d.expectation }),
    limitations: [...(mine?.limitations ?? []), ...(evalRow ? [evaluationLine(evalRow)] : []), ...(fam?.note ? [fam.note] : []), ...(enough ? [] : ["fewer than 20 comparable defenses: no standardization"]), ...(mine == null ? ["required evidence is unavailable for this player or defense"] : []), ...extraLimits] };
}

/* ------------------------------------------------------------------------------------------ coverage (man/zone) */
function edgeRows(rows: SplitRow[], key: string): { window: string; man: SplitRow; zone: SplitRow } | null {
  const order = ["recent", "career"];
  for (const w of order) { const man = rows.find((r) => r.window === w && r.bucket === "MAN"); const zone = rows.find((r) => r.window === w && r.bucket === "ZONE"); if (man && zone && num(man.values[key]) != null && num(zone.values[key]) != null && tierAtLeast(minTier(man.evidence, zone.evidence), "WEAK")) return { window: w, man, zone }; }
  return null;
}
export function coverageInteraction(ctx: MatchupContext, p: PlayerEvidence, pos: Position): InteractionComponent {
  const key = pos === "QB" ? "epa_per_play" : "epa_per_target"; const er = edgeRows(pos === "QB" ? p.qb_coverage : p.receiver_coverage, key);
  const fn: ValueFn = (d) => {
    if (!er) return null; const w = defWin(d, er.window); const row = w ? d.tendency[w] : null; const man = num(row?.["man_zone__man_rate"]); if (man == null) return null;
    const rates = ctx.league.teams.map((t) => num(ctx.league.defenses.get(t)?.tendency[w!]?.["man_zone__man_rate"])).filter((x): x is number => x != null); const m = mean(rates); const s = sd(rates); if (m == null) return null;
    const edge = num(er.man.values[key])! - num(er.zone.values[key])!; const value = (man - m) * edge;
    return { value, evidence: minTier(er.man.evidence, er.zone.evidence, chartedTier(row?.["man_zone__charted_mz"])), window: er.window,
      inputs: { epa_vs_man: num(er.man.values[key]), epa_vs_zone: num(er.zone.values[key]), man_edge: round(edge), n_man: er.man.n, n_zone: er.zone.n, defense_man_rate: round(man), league_man_rate: round(m), defense_window: w },
      sens: s == null ? [] : [{ scenario: "defense plays 1 SD more man than its history", value: round((man + s - m) * edge), note: "counterfactual mix, not a prediction" }, { scenario: "defense plays 1 SD more zone than its history", value: round((man - s - m) * edge), note: "counterfactual mix, not a prediction" }, { scenario: "league-average man/zone mix", value: 0, note: "reference" }] };
  };
  return component(ctx, { id: `${pos.toLowerCase()}.coverage.man_zone`, material: MATERIAL_VALUE.coverage, registry: "coverage.man_zone", position: pos, title: pos === "QB" ? "QB efficiency vs man/zone × defense mix" : "Receiver efficiency vs man/zone × defense mix", unit: pos === "QB" ? "expected EPA/play vs a league-average mix" : "expected EPA/target vs a league-average mix", origin: "OBSERVED_DEFENSIVE_TENDENCY", player: p }, fn,
    ["value = (defense man rate − league man rate) × (player EPA vs man − EPA vs zone): positive means the defense's historical mix favours this player", "player man/zone splits are participation-charted and PRIOR_ONLY in 2026"]);
}
/** §7: the game-specific EXPECTATION is a separate, MODELED component — here only the defense baseline, because nothing game-specific exists to condition on. */
export function coverageExpectation(ctx: MatchupContext, p: PlayerEvidence | null): InteractionComponent {
  const fn: ValueFn = (d) => { const w = defWin(d, "recent"); const row = w ? d.tendency[w] : null; const man = num(row?.["man_zone__man_rate"]); if (man == null) return null;
    return { value: man, evidence: chartedTier(row?.["man_zone__charted_mz"]), window: w, inputs: { expected_man_rate: round(man), expected_zone_rate: round(1 - man), conditioning_inputs_available: 0, missing_conditioning: "offensive formation/personnel, opposing QB, receiver alignment, coordinator tendency, game context" } }; };
  const c = component(ctx, { id: "coverage.game_expectation", material: MATERIAL_VALUE.coverage, registry: "coverage.man_zone", position: "TEAM", title: "Expected man rate this game (baseline only)", unit: "expected man share of charted dropbacks", origin: "MODELED_GAME_EXPECTATION", player: p, expectation: true }, fn, ["MODELED, not observed: equals the defense's own historical rate because no game-specific input exists; treat as a prior, not a scheme read"]);
  return { ...c, direction: "UNDETERMINED" };
}

/* ------------------------------------------------------------------------------------------ area / explosive (pass) */
interface AreaCfg { material?: number; metric: "epa" | "explosive"; unit: string; id: string; registry: string; title: string }
function areaInteraction(ctx: MatchupContext, p: PlayerEvidence, pos: Position, cfg: AreaCfg): InteractionComponent {
  const cells = pos === "QB" ? p.qb_cells : p.receiver_cells; const wins = [...new Set(cells.map((c) => c.window))]; const w = windowFor(wins.filter((x) => cells.filter((c) => c.window === x && tierAtLeast(c.evidence, "WEAK")).length >= 4));
  const leagueMean = (win: string): Map<string, number> => { const m = new Map<string, number[]>(); for (const t of ctx.league.teams) for (const c of ctx.league.defenses.get(t)?.pass_cells ?? []) { if (c.window !== win) continue; const v = cfg.metric === "epa" ? c.epa : c.explosive; if (v != null) { const k = `${c.depth_bin}|${c.field_third}`; (m.get(k) ?? m.set(k, []).get(k)!).push(v); } } return new Map([...m.entries()].map(([k, v]) => [k, mean(v)!])); };
  const fn: ValueFn = (d) => {
    if (!w) return null; const dw = d.pass_cells.some((c) => c.window === w) ? w : "career"; const lm = leagueMean(dw); const mine = cells.filter((c) => c.window === w);
    let num_ = 0, cov = 0, tot = 0; const parts: Array<[string, number]> = []; const tiers: EvidenceTier[] = [];
    for (const c of mine) { const sh = c.share ?? 0; tot += sh; const dc = d.pass_cells.find((x) => x.window === dw && x.depth_bin === c.depth_bin && x.field_third === c.field_third); const dv = cfg.metric === "epa" ? dc?.epa : dc?.explosive; const l = lm.get(`${c.depth_bin}|${c.field_third}`);
      if (dv == null || l == null || !tierAtLeast(c.evidence, "WEAK") || !dc || !tierAtLeast(dc.evidence, "WEAK")) continue; cov += sh; num_ += sh * (dv - l); parts.push([`${c.depth_bin}_${c.field_third}`, sh * (dv - l)]); if (sh >= MAJOR_CELL_SHARE) tiers.push(minTier(c.evidence, dc.evidence)); }
    if (cov <= 0) return null; const value = num_ / cov; const top = parts.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3);
    const ev: EvidenceTier = cov / (tot || 1) < MIN_COVERED_SHARE ? "INSUFFICIENT" : tiers.length ? minTier(...tiers) : "WEAK";
    return { value, evidence: ev, window: w, inputs: { covered_share: round(cov / (tot || 1)), defense_window: dw, top_cells: top.map(([k, v]) => `${k}:${round(v * 1000, 1)}`).join(",") || null, deep_share: round(mine.filter((c) => c.depth_bin === "DEEP").reduce((a, c) => a + (c.share ?? 0), 0)), short_share: round(mine.filter((c) => c.depth_bin === "SHORT" || c.depth_bin === "BEHIND_LOS").reduce((a, c) => a + (c.share ?? 0), 0)) } };
  };
  return component(ctx, { material: cfg.material ?? MATERIAL_VALUE.area, id: `${pos.toLowerCase()}.${cfg.id}`, registry: cfg.registry, position: pos, title: cfg.title, unit: cfg.unit, player: p }, fn, ["target LOCATION (depth × field third), not receiver alignment", "value = share-weighted defense-vs-league difference over the player's own volume cells (cell-level league means)"]);
}
export const areaEpa = (ctx: MatchupContext, p: PlayerEvidence, pos: Position) => areaInteraction(ctx, p, pos, { material: MATERIAL_VALUE.area, metric: "epa", id: "area.pass", registry: "area.pass_depth_third", title: pos === "QB" ? "Where the QB throws × where the defense concedes" : "Where he is targeted × where the defense concedes", unit: "expected EPA/target delta vs league-average defense" });
export const explosiveEnvironment = (ctx: MatchupContext, p: PlayerEvidence, pos: Position) => areaInteraction(ctx, p, pos, { material: MATERIAL_VALUE.explosive, metric: "explosive", id: "explosive.area", registry: "explosive.area", title: "Explosive-play environment in the player's areas", unit: "expected explosive-rate delta vs league-average defense" });

/** Player-side route-family profile: descriptive only — no defense-side route-allowed data exists, so no interaction is computed. */
export function routeFamilyProfile(ctx: MatchupContext, p: PlayerEvidence): InteractionComponent {
  const w = windowFor([...new Set(p.receiver_routes.map((r) => r.window))]); const rows = p.receiver_routes.filter((r) => r.window === w && tierAtLeast(r.evidence, "WEAK")).sort((a, b) => (num(b.values.targeted_route_share) ?? 0) - (num(a.values.targeted_route_share) ?? 0)).slice(0, 4);
  const fam = familyById("route.family")!; const ev = rows.length ? minTier(...rows.map((r) => r.evidence)) : "INSUFFICIENT";
  return { id: "receiver.route.family", family: fam.id, position: "TEAM", title: "Targeted-route families (player side only)", origin: "OBSERVED_PLAYER_PROFILE", history_class: fam.history_class, predictive_class: fam.predictive_class, direction: "UNDETERMINED", value: null, unit: "share of targets", z: null, rank_among_defenses: null, evidence: ev, window: w,
    inputs: Object.fromEntries(rows.map((r) => [r.bucket, round(num(r.values.targeted_route_share))])), sensitivity: [], uncertainty: uncertaintyFor(ctx, { evidence: ev, player: p }), limitations: [fam.note, "no defensive route-family allowed dataset exists, so the interaction is NOT computed (direction UNDETERMINED by design)"] };
}

/* ------------------------------------------------------------------------------------------ pressure (QB) */
export function pressureQbResponse(ctx: MatchupContext, p: PlayerEvidence): InteractionComponent {
  const rows = p.qb_pressure; const w = ["recent", "career"].find((x) => rows.some((r) => r.window === x && r.bucket === "CLEAN") && rows.some((r) => r.window === x && r.bucket === "PRESSURED")) ?? null; const clean = rows.find((r) => r.window === w && r.bucket === "CLEAN"); const pr = rows.find((r) => r.window === w && r.bucket === "PRESSURED");
  const fn: ValueFn = (d) => {
    if (!w || !clean || !pr) return null; const dw = defWin(d, w); const row = dw ? d.tendency[dw] : null; const rate = num(row?.["pressure__pressure_rate_generated"]); const ec = num(clean.values.epa_per_play); const ep = num(pr.values.epa_per_play); if (rate == null || ec == null || ep == null) return null;
    const rates = ctx.league.teams.map((t) => num(ctx.league.defenses.get(t)?.tendency[dw!]?.["pressure__pressure_rate_generated"])).filter((x): x is number => x != null); const m = mean(rates); const s = sd(rates); if (m == null) return null;
    const value = (rate - m) * (ep - ec);
    return { value, window: w, evidence: minTier(clean.evidence, pr.evidence, chartedTier(row?.["pressure__charted_pressure"])), inputs: { defense_pressure_rate: round(rate), league_pressure_rate: round(m), qb_epa_clean: round(ec), qb_epa_pressured: round(ep), pressure_epa_drop: round(ep - ec), qb_sack_rate_pressured: round(num(pr.values.sack_rate)), qb_sack_rate_clean: round(num(clean.values.sack_rate)), time_to_throw_pressured: round(num(pr.values.time_to_throw)), time_to_throw_clean: round(num(clean.values.time_to_throw)), air_yards_pressured: round(num(pr.values.air_yards)), air_yards_clean: round(num(clean.values.air_yards)), n_pressured: pr.n, n_clean: clean.n, defense_window: dw },
      sens: s == null ? [] : [{ scenario: "defense pressures 1 SD more than its history", value: round((rate + s - m) * (ep - ec)), note: "counterfactual, not a prediction" }, { scenario: "defense pressures 1 SD less", value: round((rate - s - m) * (ep - ec)), note: "counterfactual, not a prediction" }] };
  };
  return component(ctx, { id: "qb.pressure.response", material: MATERIAL_VALUE.pressure, registry: "pressure.qb_response", position: "QB", title: "Defense pressure rate × this QB's pressured-vs-clean response", unit: "expected EPA/dropback vs a league-average pass rush", origin: "OBSERVED_DEFENSIVE_TENDENCY", player: p }, fn, ["pressure rate reflects the opposing QB's behaviour as well as defensive quality: causality is not claimed", "value = (defense pressure rate − league) × (QB EPA pressured − EPA clean)"]);
}
export function rusherCountResponse(ctx: MatchupContext, p: PlayerEvidence): InteractionComponent {
  const rows = p.qb_rushers.filter((r) => r.window === "recent" || r.window === "career"); const w = ["recent", "career"].find((x) => rows.some((r) => r.window === x && r.bucket === "FOUR"));
  const four = rows.find((r) => r.window === w && r.bucket === "FOUR"); const blitz = rows.filter((r) => r.window === w && (r.bucket === "FIVE" || r.bucket === "SIXPLUS"));
  const fn: ValueFn = (d) => { if (!w || !four || !blitz.length) return null; const dw = defWin(d, w); const row = dw ? d.tendency[dw] : null; const b = num(row?.["pressure__blitz_proxy_rate"]); const e4 = num(four.values.epa_per_play); const nb = blitz.reduce((a, r) => a + (r.n ?? 0), 0); if (b == null || e4 == null || nb <= 0) return null;
    const eb = blitz.reduce((a, r) => a + (num(r.values.epa_per_play) ?? 0) * (r.n ?? 0), 0) / nb; const rates = ctx.league.teams.map((t) => num(ctx.league.defenses.get(t)?.tendency[dw!]?.["pressure__blitz_proxy_rate"])).filter((x): x is number => x != null); const m = mean(rates); if (m == null) return null;
    return { value: (b - m) * (eb - e4), window: w, evidence: minTier(four.evidence, ...blitz.map((r) => r.evidence), chartedTier(row?.["pressure__charted_pressure"])), inputs: { defense_blitz_proxy_rate: round(b), league_blitz_proxy_rate: round(m), qb_epa_vs_four: round(e4), qb_epa_vs_5plus: round(eb), n_blitz: nb }, limitations: ["blitz proxy = 5+ pass rushers on charted dropbacks, not a charted blitz call"] }; };
  const c = component(ctx, { id: "qb.pressure.rusher_count", material: MATERIAL_VALUE.rusher, registry: "pressure.rusher_count", position: "QB", title: "Blitz proxy × this QB's response to 5+ rushers", unit: "expected EPA/dropback vs league-average blitz rate", player: p }, fn); return { ...c, direction: c.direction };
}
/** TEAM level: offense pass protection meets defense pass rush (Football Intelligence ratings, consumed unmodified). */
export function pressureLine(ctx: MatchupContext): InteractionComponent {
  const off = ctx.offense?.fi_offense; const fam = familyById("pressure.qb_response")!;
  const fn: ValueFn = (d) => { const o = off?.off_pressure_rate_allowed; const dd = d.fi_defense.def_pressure_rate; if (!o || !dd || o.modeled == null || dd.modeled == null) return null; return { value: o.modeled + dd.modeled, window: null, evidence: minTier(fiTier(o.confidence), fiTier(dd.confidence)), inputs: { offense_pressure_allowed_modeled: round(o.modeled), defense_pressure_generated_modeled: round(dd.modeled), offense_predictive_status: o.predictive_status, defense_predictive_status: dd.predictive_status }, limitations: ["additive combination of two league-centred deviations (pressure-rate units); each side's FI predictive status is shown, never overridden"] }; };
  const c = component(ctx, { id: "team.pressure.line", material: MATERIAL_VALUE.line, registry: "pressure.qb_response", position: "TEAM", title: "Protection vs pass rush (team level)", unit: "expected pressure-rate deviation (positive = more pressure)", origin: "DESCRIPTIVE_CONTEXT", generic: true }, fn, ["team/unit level: no offensive-lineman or edge-rusher individual evidence exists"]);
  // orientation: more pressure is BAD for the offense, so flip the label
  const dir: Direction = c.direction === "ADVANTAGE" ? "DISADVANTAGE" : c.direction === "DISADVANTAGE" ? "ADVANTAGE" : c.direction;
  return { ...c, direction: dir, predictive_class: fam.predictive_class === "PREDICTIVE_CANDIDATE_UNVALIDATED" ? "DESCRIPTIVE_CONTEXT" : fam.predictive_class };
}

/* ------------------------------------------------------------------------------------------ run / front (RB) */
export function runDirection(ctx: MatchupContext, p: PlayerEvidence): InteractionComponent {
  const rows = p.rb_direction; const w = windowFor([...new Set(rows.filter((r) => tierAtLeast(r.evidence, "WEAK")).map((r) => r.window))]);
  const lm = (win: string) => { const m = new Map<string, number[]>(); for (const t of ctx.league.teams) for (const r of ctx.league.defenses.get(t)?.rush_direction ?? []) if (r.window === win && r.epa != null) (m.get(r.field_third) ?? m.set(r.field_third, []).get(r.field_third)!).push(r.epa); return new Map([...m].map(([k, v]) => [k, mean(v)!])); };
  const fn: ValueFn = (d) => { if (!w) return null; const dw = d.rush_direction.some((r) => r.window === w) ? w : "career"; const l = lm(dw); let n_ = 0, cov = 0, tot = 0; const tiers: EvidenceTier[] = []; const parts: string[] = [];
    for (const r of rows.filter((x) => x.window === w)) { const sh = r.share ?? 0; tot += sh; const dr = d.rush_direction.find((x) => x.window === dw && x.field_third === r.field_third); const lv = l.get(r.field_third); if (!dr || dr.epa == null || lv == null || !tierAtLeast(r.evidence, "WEAK") || !tierAtLeast(dr.evidence, "WEAK")) continue; cov += sh; n_ += sh * (dr.epa - lv); tiers.push(minTier(r.evidence, dr.evidence)); parts.push(`${r.field_third}:share ${round(sh, 2)} def_vs_league ${round(dr.epa - lv, 3)}`); }
    if (cov <= 0) return null; return { value: n_ / cov, window: w, evidence: cov / (tot || 1) < MIN_COVERED_SHARE ? "INSUFFICIENT" : minTier(...tiers), inputs: { covered_share: round(cov / (tot || 1)), cells: parts.join(" | "), defense_window: dw, defense_stuff_rate_middle: round(d.rush_direction.find((x) => x.window === dw && x.field_third === "MIDDLE")?.stuff ?? null) } }; };
  return component(ctx, { id: "rb.run.direction", material: MATERIAL_VALUE.run, registry: "run.direction", position: "RB", title: "Where he runs × where the defense concedes (left/middle/right)", unit: "expected EPA/rush delta vs league-average defense", player: p }, fn, ["directions are LEFT/MIDDLE/RIGHT from run_location — NOT inside/outside; the source has no such label"]);
}
export function runGap(ctx: MatchupContext, p: PlayerEvidence): InteractionComponent {
  const rows = p.rb_gap; const w = windowFor([...new Set(rows.filter((r) => tierAtLeast(r.evidence, "WEAK")).map((r) => r.window))]);
  const lm = (win: string) => { const m = new Map<string, number[]>(); for (const t of ctx.league.teams) for (const r of ctx.league.defenses.get(t)?.rush_gap ?? []) if (r.window === win && r.epa != null) (m.get(r.run_gap) ?? m.set(r.run_gap, []).get(r.run_gap)!).push(r.epa); return new Map([...m].map(([k, v]) => [k, mean(v)!])); };
  const fn: ValueFn = (d) => { if (!w) return null; const dw = d.rush_gap.some((r) => r.window === w) ? w : "career"; const l = lm(dw); const mine = rows.filter((r) => r.window === w); const tot = mine.reduce((a, r) => a + (r.n ?? 0), 0); if (tot <= 0) return null; let n_ = 0, cov = 0; const tiers: EvidenceTier[] = [];
    for (const r of mine) { const sh = (r.n ?? 0) / tot; const dr = d.rush_gap.find((x) => x.window === dw && x.run_gap === r.run_gap); const lv = l.get(r.run_gap); if (!dr || dr.epa == null || lv == null || !tierAtLeast(r.evidence, "WEAK") || !tierAtLeast(dr.evidence, "WEAK")) continue; cov += sh; n_ += sh * (dr.epa - lv); tiers.push(minTier(r.evidence, dr.evidence)); }
    if (cov <= 0) return null; return { value: n_ / cov, window: w, evidence: cov < MIN_COVERED_SHARE ? "INSUFFICIENT" : minTier(...tiers), inputs: { covered_share: round(cov), defense_window: dw, gaps: mine.map((r) => `${r.run_gap}:${round((r.n ?? 0) / tot, 2)}`).join(",") } }; };
  return component(ctx, { id: "rb.run.gap", material: MATERIAL_VALUE.run, registry: "run.gap", position: "RB", title: "Run gap usage (end/tackle/guard) × defense gap concession", unit: "expected EPA/rush delta vs league-average defense", player: p }, fn, ["source gap labels are END/TACKLE/GUARD only: no zone/gap/power/counter scheme classification exists and none is inferred"]);
}
export function runBox(ctx: MatchupContext, p: PlayerEvidence): InteractionComponent {
  const rows = p.rb_box; const w = ["recent", "career"].find((x) => rows.some((r) => r.window === x && r.bucket === "HEAVY" && tierAtLeast(r.evidence, "WEAK")) && rows.some((r) => r.window === x && r.bucket === "LIGHT" && tierAtLeast(r.evidence, "WEAK"))) ?? null; const h = rows.find((r) => r.window === w && r.bucket === "HEAVY"); const l = rows.find((r) => r.window === w && r.bucket === "LIGHT");
  const fn: ValueFn = (d) => { if (!w || !h || !l) return null; const dw = defWin(d, w); const row = dw ? d.tendency[dw] : null; const rate = num(row?.["box__heavy_box_rate"]); const eh = num(h.values.epa_per_rush); const el = num(l.values.epa_per_rush); if (rate == null || eh == null || el == null) return null;
    const rates = ctx.league.teams.map((t) => num(ctx.league.defenses.get(t)?.tendency[dw!]?.["box__heavy_box_rate"])).filter((x): x is number => x != null); const m = mean(rates); const s = sd(rates); if (m == null) return null;
    return { value: (rate - m) * (eh - el), window: w, evidence: minTier(h.evidence, l.evidence, chartedTier(row?.["pressure__charted_pressure"])), inputs: { defense_heavy_box_rate: round(rate), league_heavy_box_rate: round(m), rb_epa_heavy_box: round(eh), rb_epa_light_box: round(el), defense_mean_box: round(num(row?.["box__mean_box_deployed"])), n_heavy: h.n, n_light: l.n }, limitations: ["box count is the only front evidence: front ALIGNMENT (4-3/3-4/odd/even), gap penetration and linebacker run fits are unsupported"],
      sens: s == null ? [] : [{ scenario: "defense uses heavy boxes 1 SD more often", value: round((rate + s - m) * (eh - el)), note: "counterfactual, not a prediction" }] }; };
  return component(ctx, { id: "rb.run.box", material: MATERIAL_VALUE.box, registry: "run.box", position: "RB", title: "Heavy-box rate × this RB's heavy-vs-light-box efficiency", unit: "expected EPA/rush vs a league-average box mix", player: p }, fn);
}

/* ------------------------------------------------------------------------------------------ unit coverage / red zone */
export function unitCoverage(ctx: MatchupContext, p: PlayerEvidence, pos: Position): InteractionComponent | null {
  if (pos === "QB") return null; const key = pos === "RB" ? "RB" : pos === "TE" ? "TE" : "WR"; const role = p.role;
  const fn: ValueFn = (d) => { const r = d.fi_unit_coverage[key]; if (!r || r.modeled == null) return null; return { value: r.modeled, window: null, evidence: fiTier(r.confidence), inputs: { unit_epa_allowed_modeled: round(r.modeled), league_percentile_best_defense_1: round(r.league_percentile), fi_predictive_status: r.predictive_status, fi_confidence: r.confidence, player_target_share: round(role?.target_share ?? null) }, limitations: ["FI coverage-allowed EPA to the whole position group (LB/S/CB combined): unit evidence, never a named defender"] }; };
  const c = component(ctx, { id: `${pos.toLowerCase()}.receiving.unit_coverage`, material: MATERIAL_VALUE.unit, registry: "rb.receiving_vs_coverage", position: pos, title: `${key} receiving vs the defense's unit coverage`, unit: "EPA/target allowed to the position group (league-centred)", origin: "DESCRIPTIVE_CONTEXT", player: p, generic: true }, fn);
  return pos === "RB" && role && (role.target_share ?? 0) < MINOR_RECEIVING_ROLE ? { ...c, direction: "NEUTRAL", limitations: [...c.limitations, `minor receiving role (target share ${round(role.target_share)}): unit coverage is not a material lever`] } : c;
}
export function scoringOpportunity(ctx: MatchupContext, p: PlayerEvidence, pos: Position): InteractionComponent {
  const role = p.role; const share = pos === "RB" ? Math.max(role?.rz_carry_share ?? 0, role?.rz_target_share ?? 0) : pos === "QB" ? null : role?.rz_target_share ?? null; const material = pos === "RB" ? (role?.rz_carry_share ?? 0) >= RZ_ROLE_MATERIAL_RUSH || (role?.rz_target_share ?? 0) >= RZ_ROLE_MATERIAL_REC : pos === "QB" ? true : (role?.rz_target_share ?? 0) >= RZ_ROLE_MATERIAL_REC;
  const fn: ValueFn = (d) => { const r = d.fi_defense.def_rz_td_rate_allowed; if (!r || r.modeled == null) return null; return { value: r.modeled, window: null, evidence: fiTier(r.confidence), inputs: { defense_rz_td_rate_allowed_modeled: round(r.modeled), league_percentile_best_defense_1: round(r.league_percentile), fi_predictive_status: r.predictive_status, player_rz_role_share: round(share), rz_carry_share: round(role?.rz_carry_share ?? null), rz_target_share: round(role?.rz_target_share ?? null), goal_line_carries_latest: role?.goal_line_carries ?? null }, limitations: ["red-zone role and defensive red-zone efficiency shown together; no touchdown expectation is derived (and none from last week's touchdowns)"] }; };
  const c = component(ctx, { id: `${pos.toLowerCase()}.scoring.red_zone`, material: MATERIAL_VALUE.red_zone, registry: "scoring.red_zone", position: pos, title: "Red-zone role × defensive red-zone efficiency", unit: "defense TD-rate-allowed deviation (league-centred)", origin: "DESCRIPTIVE_CONTEXT", player: p, generic: true }, fn);
  return material ? c : { ...c, direction: "NEUTRAL", limitations: [...c.limitations, "no material red-zone role for this player: defensive red-zone weakness/strength is not a lever for him"] };
}
