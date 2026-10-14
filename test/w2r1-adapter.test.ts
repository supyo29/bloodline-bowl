import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEarlyInputs } from "@/lib/w2r1/adapter";
import { validateAsset, validateMarket } from "@/lib/w2r1/evidence";
import { computeDynamicVor } from "@/lib/w2r1/vor";
import { addReport, dropReport, envelope, findPlayer, kdstReport, LAYER_STATUS, K_DST_NOTICE, EARLY_LABEL } from "@/lib/w2r1/live";
import { w2r1Enabled } from "@/lib/w2r1/guard";
import type { WeeklyTeamContext } from "@/lib/weekly/schema";

const player = (id: string, pos: string, team = "AAA") => ({ canonical_player_id: id, full_name: id.toUpperCase(), position: pos, eligible_positions: [pos], nfl_team: team });
interface FOpts { exp?: number | null; cond?: number | null; state?: string; ros?: number | null; out?: number; hold?: number | null; bye?: boolean }
const forecast = (id: string, o: FOpts = {}) => ({
  canonical_player_id: id,
  game_status: { is_bye: o.bye === true }, projection: { expected_points: o.exp === undefined ? 10 : o.exp, conditional_active_points: o.cond === undefined ? (o.exp === undefined ? 10 : o.exp) : o.cond },
  weekly_value: { current_week_state: o.state ?? "PLAYABLE" },
  asset_value: { forward_value: { ros_points: o.ros === undefined ? 120 : o.ros, forward_weeks_out: o.out ?? 0 }, asset_value: { hold_points_per_week: o.hold === undefined ? 10 : o.hold } },
  freshness: { source_observed_at: "2026-10-14T12:00:00Z", age_ms: 1000 }, provenance: { projection_provider: "test", source_version: "t1" }, certification: { state: "PRODUCTION" },
});
const row = (id: string, o: { bye?: boolean; ros?: number | null } = {}) => ({ canonical_player_id: id, is_bye: o.bye === true, projected_points: 10, rest_of_season_points: o.ros === undefined ? 120 : o.ros, source: "test", model_version: "t1" });

function ctxOf(opts: { week?: number; provider?: string; actionable?: boolean; byes?: Record<string, number | null>; verifiedByes?: boolean; forecasts?: Record<string, FOpts>; pool?: Array<{ id: string; pos: string; ownership?: string; acq?: "FREE_AGENT_ADD" | "WAIVER_CLAIM" | null; f?: FOpts }> } = {}): WeeklyTeamContext {
  const week = opts.week ?? 6;
  const starters = [player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"), player("fl", "WR"), player("k1", "K"), player("d1", "DEF")];
  const bench = [player("bn1", "RB"), player("bn2", "WR")];
  const ir = [player("ir1", "RB")];
  const all = [...starters, ...bench, ...ir];
  const fo = (id: string) => ({ ...(opts.forecasts ?? {})[id] });
  const forecasts = new Map<string, unknown>(); const rows = new Map<string, unknown>();
  for (const p of all) { forecasts.set(p.canonical_player_id, forecast(p.canonical_player_id, fo(p.canonical_player_id))); rows.set(p.canonical_player_id, row(p.canonical_player_id, { bye: (opts.forecasts ?? {})[p.canonical_player_id]?.bye, ros: (opts.forecasts ?? {})[p.canonical_player_id]?.ros })); }
  const free = (opts.pool ?? []).map((c) => { const p = player(c.id, c.pos); forecasts.set(c.id, forecast(c.id, c.f ?? { exp: 9 })); rows.set(c.id, row(c.id)); return { canonical_player_id: c.id, player: p, ownership: c.ownership ?? "free_agent", owned_by_team_id: null, unresolved_note: null, ...(c.acq ? { acquisition: { method: c.acq, provider_status: c.acq === "WAIVER_CLAIM" ? "W" : "FA", waiver_clears_on: null } } : {}) }; });
  return {
    generated_at: "2026-10-14T12:00:00Z",
    league: { slug: "L", provider: opts.provider ?? "yahoo", week, season: 2026, raw_scoring: { rec: 0.5, pass_td: 4 }, roster_constraints: { starting_slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"], bench_slots: 6, ir_slots: 1 } },
    manager: { manager_slug: "m" }, starters, bench, reserve_ir: ir, taxi: [], all_rostered: all,
    forecasts: { by_player: forecasts }, projections: { by_player: rows, source: "test", status: "READY" },
    byes: { bye_status: opts.verifiedByes === false ? "UNVERIFIED" : "VERIFIED", by_player: opts.byes ?? {} },
    availability: { free_agents: free }, free_agent_pool_readiness: { actionable: opts.actionable !== false },
    market_pool: { provider: opts.provider ?? "yahoo", basis: opts.provider === "sleeper" ? "INFERRED" : "PROVIDER_STATUS", freshness: "FRESH", observed_at: "2026-10-14T12:00:00Z", age_ms: 1000, market_content_id: "mkt:x", axes: {} },
    status: "READY", free_agent_pool_readiness_: undefined,
  } as unknown as WeeklyTeamContext;
}

describe("W2.R1 live adapter (provider neutral)", () => {
  it("builds contract-valid assets and market; availability is NOT re-applied (lineup = Wave-1 expected_points verbatim)", () => {
    const ctx = ctxOf({ forecasts: { rb1: { exp: 8, cond: 10 } }, pool: [{ id: "fa1", pos: "RB", acq: "FREE_AGENT_ADD" }] });
    const inp = buildEarlyInputs(ctx);
    for (const a of inp.roster) assert.deepEqual(validateAsset(a), [], a.player_id);
    assert.deepEqual(validateMarket(inp.market), []);
    const rb1 = inp.roster.find((a) => a.player_id === "rb1")!;
    assert.equal(rb1.weeks[6]!.lineup, 8); assert.equal(rb1.weeks[6]!.underlying, 10);
    assert.ok(inp.roster.every((a) => a.scoring_fingerprint === inp.rules.scoring_fingerprint));
  });
  it("a verified bye: this week 0, future weeks keep the ROS value, a future bye is BYE; hold/ROS stay positive end to end", () => {
    const ctx = ctxOf({ byes: { rb1: 6, wr1: 9 }, forecasts: { rb1: { exp: 0, state: "BYE", cond: 10, bye: true } } });
    const inp = buildEarlyInputs(ctx);
    const rb1 = inp.roster.find((a) => a.player_id === "rb1")!; const wr1 = inp.roster.find((a) => a.player_id === "wr1")!;
    assert.equal(rb1.weeks[6]!.state, "BYE"); assert.equal(rb1.weeks[6]!.lineup, 0); assert.equal(rb1.weeks[7]!.state, "ACTIVE"); assert.ok(rb1.weeks[7]!.lineup! > 0);
    assert.equal(wr1.weeks[9]!.state, "BYE");
    const v = computeDynamicVor({ rules: inp.rules, roster: inp.roster, playerId: "rb1", week: 6, market: inp.market });
    assert.equal(v.weekly_roster_vor.value, 0); assert.ok(v.hold_vor.value! > 0); assert.ok(v.ros_vor.value! > 0);
  });
  it("a long-term IR player: OUT weeks then ACTIVE; returns_in_week assumed from the minimum stint and flagged", () => {
    const ctx = ctxOf({ forecasts: { ir1: { exp: 0, state: "OUT", out: 4, cond: 9 } } });
    const ir = buildEarlyInputs(ctx).roster.find((a) => a.player_id === "ir1")!;
    assert.equal(ir.status, "IR"); assert.equal(ir.returns_in_week, 10);
    assert.equal(ir.weeks[7]!.state, "OUT"); assert.equal(ir.weeks[10]!.state, "ACTIVE");
    assert.ok(ir.missing_evidence.includes("IR_RETURN_WEEK_ASSUMED_FROM_MINIMUM_STINT"));
  });
  it("an IR-slot player with NO known designation is NOT assumed activatable (unknown availability is not availability)", () => {
    const ir = buildEarlyInputs(ctxOf({ forecasts: { ir1: { exp: 5, out: 0 } } })).roster.find((a) => a.player_id === "ir1")!;
    assert.equal(ir.status, "IR"); assert.equal(ir.returns_in_week, null);
    assert.ok(ir.missing_evidence.includes("IR_SLOT_WITH_NO_LONG_TERM_DESIGNATION_RETURN_UNKNOWN"));
  });
  it("unknown ROS => future weeks UNKNOWN with a reason (never zero-filled)", () => {
    const ctx = ctxOf({ forecasts: { wr2: { ros: null } } });
    const wr2 = buildEarlyInputs(ctx).roster.find((a) => a.player_id === "wr2")!;
    assert.equal(wr2.weeks[8]!.state, "UNKNOWN"); assert.equal(wr2.weeks[8]!.lineup, null);
    assert.ok(wr2.missing_evidence.includes("ROS_UNAVAILABLE_FUTURE_WEEKS_UNKNOWN")); assert.deepEqual(validateAsset(wr2), []);
  });
  it("Yahoo market: provider-verified FA = certain (1); waiver claim and Sleeper-inferred adds have UNKNOWN probability; no guaranteed claim", () => {
    const yahoo = buildEarlyInputs(ctxOf({ pool: [{ id: "fa1", pos: "RB", acq: "FREE_AGENT_ADD" }, { id: "wv1", pos: "WR", ownership: "waiver", acq: "WAIVER_CLAIM" }] })).market;
    assert.equal(yahoo.verified, true);
    assert.equal(yahoo.candidates.find((c) => c.player_id === "fa1")!.acquisition.success_probability, 1);
    assert.equal(yahoo.candidates.find((c) => c.player_id === "wv1")!.acquisition.success_probability, null);
    const sleeper = buildEarlyInputs(ctxOf({ provider: "sleeper", pool: [{ id: "fa2", pos: "RB" }] }));
    assert.equal(sleeper.market.provider, "sleeper"); assert.equal(sleeper.market.candidates[0]!.acquisition.success_probability, null);
    assert.ok(sleeper.notes.some((n) => /SLEEPER_ACQUISITION_METHOD_AND_PROBABILITY_INFERRED/.test(n)));
  });
  it("Sleeper market: observed time is the league snapshot time; the freshness STATE is not asserted without a policy verdict", () => {
    const base = ctxOf({ provider: "sleeper" }) as unknown as { market_pool?: unknown; lineage?: unknown };
    base.market_pool = undefined; const t = new Date().toISOString();
    base.lineage = { snapshot: { generated_at: t } };
    const m = buildEarlyInputs(base as unknown as WeeklyTeamContext).market;
    assert.equal(m.observed_at, t); assert.equal(m.freshness, "UNKNOWN");
    base.lineage = undefined;
    assert.equal(buildEarlyInputs(base as unknown as WeeklyTeamContext).market.observed_at, null);
  });
  it("an uncertified pool is flagged and never supplies replacements", () => {
    const inp = buildEarlyInputs(ctxOf({ actionable: false, pool: [{ id: "fa1", pos: "RB", acq: "FREE_AGENT_ADD", f: { exp: 30 } }] }));
    assert.equal(inp.market.verified, false); assert.ok(inp.notes.some((n) => /REPLACEMENT_MARKET_NOT_CERTIFIED/.test(n)));
    const v = computeDynamicVor({ rules: inp.rules, roster: inp.roster, playerId: "rb1", week: 6, market: inp.market });
    assert.equal(v.weekly_detail!.chosen_add, null);
  });
  it("verified FA enters the replacement chain; an unknown-probability waiver is shown only as the optimistic add", () => {
    const inp = buildEarlyInputs(ctxOf({ pool: [{ id: "wv1", pos: "RB", ownership: "waiver", acq: "WAIVER_CLAIM", f: { exp: 14 } }] }));
    const v = computeDynamicVor({ rules: inp.rules, roster: inp.roster, playerId: "rb1", week: 6, market: inp.market });
    assert.equal(v.weekly_detail!.chosen_add, null);
    assert.equal(v.weekly_detail!.optimistic_unverified_add!.player_id, "wv1");
    const drop = dropReport(ctxOf(), inp, "rb1") as { replacement: { best_market_candidate_with_UNKNOWN_probability: { name: string } | null } };
    assert.equal(drop.replacement.best_market_candidate_with_UNKNOWN_probability?.name, "WV1");
  });
  it("every envelope is labelled EARLY SHADOW, lists layer availability, carries the K/DST notice and states no production influence", () => {
    const ctx = ctxOf(); const inp = buildEarlyInputs(ctx); const e = envelope(ctx, inp, "roster", {});
    assert.equal(e.label, EARLY_LABEL); assert.equal(e.mode, "SHADOW_ONLY"); assert.equal(e.qualification, "DIAGNOSTIC");
    assert.equal(e.layers.S4_k_dst_component_model, "NOT YET QUALIFIED"); assert.equal(e.layers.S5_game_plan_intelligence, "NOT YET QUALIFIED");
    assert.equal(e.layers.S6_empirical_breakout_model, "NOT YET QUALIFIED"); assert.equal(e.layers.S7_final_retrospective_qualification, "NOT YET RUN");
    assert.equal(e.notices.k_dst, K_DST_NOTICE); assert.match(e.production_influence, /^NONE/); assert.equal(JSON.stringify(LAYER_STATUS).includes("QUALIFIED\""), true);
    assert.ok(!/breakout_probability|upside_probability/.test(JSON.stringify(e)), "no breakout probability is exposed before S6 produces a calibrated model");
  });
  it("K/DST report names the inherited-generic status; add report never claims an unknown acquisition as certain; player lookup is unambiguous", () => {
    const ctx = ctxOf({ pool: [{ id: "k9", pos: "K", acq: "FREE_AGENT_ADD", f: { exp: 9 } }, { id: "rbx", pos: "RB", ownership: "waiver", acq: "WAIVER_CLAIM", f: { exp: 13 } }] });
    const inp = buildEarlyInputs(ctx);
    assert.match(kdstReport(ctx, inp).forecast_quality, /INHERITED_GENERIC/);
    const top = addReport(ctx, inp, 5).top as Array<{ add: { player_id: string }; acquisition_probability_known: boolean }>;
    assert.equal(top.find((t) => t.add.player_id === "rbx")!.acquisition_probability_known, false);
    assert.equal(findPlayer(inp, "rb1").ok, true); assert.equal(findPlayer(inp, "nobody").ok, false);
  });
  it("routes are never served from a Vercel production deployment", () => {
    assert.equal(w2r1Enabled({ VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv), false);
    assert.equal(w2r1Enabled({ VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv), true);
    assert.equal(w2r1Enabled({ VERCEL_ENV: "preview", W2R1_SHADOW_DISABLED: "1" } as unknown as NodeJS.ProcessEnv), false);
  });
});
