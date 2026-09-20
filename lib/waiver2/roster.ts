/**
 * Phase 4 — roster mechanics: the exact next-week lineup counterfactual (the SHARED Hungarian optimizer — not a v1 copy of
 * its FLEX logic) and DROP COST (what this roster loses if a given player leaves), decomposed.
 */
import { buildOptimalLineup } from "@/lib/weekly/lineup";
import type { CanonicalPlayer, CanonicalRoster } from "@/lib/canonical/schema";
import { PARAMS } from "./config";
import { round2, type WaiverContext } from "./context";
import { assetValue } from "./value";
import type { AssetValue, Component } from "./types";

const countBy = (arr: string[]): Map<string, number> => { const m = new Map<string, number>(); for (const s of arr) m.set(s, (m.get(s) ?? 0) + 1); return m; };

export function lineupDelta(ctx: WaiverContext, add: CanonicalPlayer, dropId: string | null): { legal: boolean; gain: number | null } {
  const w = ctx.input.weekly; const base = ctx.baseline;
  const hypoPlayers = new Map(w.all_rostered.map((p) => [p.canonical_player_id, p])); hypoPlayers.set(add.canonical_player_id, add);
  const roster: CanonicalRoster = { ...w.roster, all_players: [...w.roster.all_players.filter((id) => id !== dropId), add.canonical_player_id], starters: w.roster.starters.filter((id) => id !== dropId), bench: [...w.roster.bench.filter((id) => id !== dropId), add.canonical_player_id], slots: w.roster.slots.filter((s) => s.canonical_player_id !== dropId) };
  ctx.counters.lineup_builds += 1;
  const hypo = buildOptimalLineup({ week: ctx.week, roster, constraints: w.league.roster_constraints, players: hypoPlayers, projections: w.projections });
  const b = countBy(base.empty_slots); const legal = [...countBy(hypo.empty_slots)].every(([l, n]) => n <= (b.get(l) ?? 0));
  const known = (id: string) => { const p = ctx.proj(id); return p != null && (p.projected_points != null || p.projection_status === "bye"); };
  let gain: number | null = null;
  if (legal && base.optimal_total != null && base.optimality_status !== "PROVISIONAL" && (dropId == null || known(dropId)) && hypo.optimal_total != null && hypo.optimality_status !== "PROVISIONAL") gain = round2(hypo.optimal_total - base.optimal_total);
  return { legal, gain };
}

export interface DropCost { player_id: string; asset: AssetValue; cost: number; components: Component[]; readd_probability: number }

/** What this roster loses if `p` is dropped — starter value (vs the best remaining bench alternative), bench option, established contingency, bye cover, minus the chance the player can simply be re-added. */
export function dropCost(ctx: WaiverContext, p: CanonicalPlayer, cache: Map<string, DropCost>): DropCost {
  const hit = cache.get(p.canonical_player_id); if (hit) return hit;
  const a = assetValue(ctx, p, { role: "ROSTERED" }); const rep = ctx.replacement[p.position];
  const readd = (a.weekly_level ?? 0) <= (rep?.free_agent_replacement ?? Infinity) ? 0.7 : 0.2;
  const credit = round2(readd * 0.25 * a.by_kind.bench_option);
  // bye cover: if this is the only bench player at a position where one of my starters is on bye within 3 weeks
  let bye = 0;
  const sameBench = ctx.activeIds.filter((id) => id !== p.canonical_player_id && !ctx.startersByPlayer.has(id) && ctx.players.get(id)?.position === p.position);
  if (!ctx.startersByPlayer.has(p.canonical_player_id) && !sameBench.length && ctx.input.schedule) {
    for (const [sid] of ctx.startersByPlayer) { const sp = ctx.players.get(sid); if (sp?.position !== p.position) continue; const bw = ctx.byeWeek(sp); if (bw != null && bw >= ctx.week && bw <= ctx.week + 2) bye = Math.max(bye, Math.min(6, a.weekly_level ?? 0)); }
  }
  const comps: Component[] = [
    { key: "drop.starter_value", label: "Starter value lost (vs best remaining bench alternative)", value: a.by_kind.starter, unit: "points", status: "AVAILABLE" },
    { key: "drop.bench_option", label: "Bench optionality lost", value: a.by_kind.bench_option, unit: "points", status: "AVAILABLE" },
    { key: "drop.contingency", label: "Established contingency value lost", value: a.by_kind.contingency_counted, unit: "points", status: "AVAILABLE" },
    { key: "drop.bye_cover", label: "Bye-week cover lost (only bench option at a position with a starter bye in 3 weeks)", value: round2(bye), unit: "points", status: ctx.input.schedule ? "AVAILABLE" : "UNAVAILABLE" },
    { key: "drop.readd_credit", label: `Re-add credit (${Math.round(readd * 100)}% chance the player stays re-addable)`, value: -credit, unit: "points", status: "AVAILABLE", basis: "PRIOR_UNVALIDATED" },
  ];
  const cost = round2(Math.max(0, a.by_kind.starter + a.by_kind.bench_option + a.by_kind.contingency_counted + bye - credit));
  const d: DropCost = { player_id: p.canonical_player_id, asset: a, cost, components: comps, readd_probability: readd };
  void PARAMS; cache.set(p.canonical_player_id, d); return d;
}
