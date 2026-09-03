/**
 * Waiver / Free-Agent Intelligence — league-aware ACQUISITION, not a "top
 * available players" list.
 *
 * Every candidate answers: what does adding THIS player do for THIS roster?
 * Evaluation is always paired with the player who would be dropped
 * (`add/drop pair optimization`), and the engine can and does conclude
 * `DO_NOT_ADD` when the wire is not worth the drop. It never manufactures
 * activity because free agents exist.
 *
 * Free agency comes only from `ctx.availability` (canonical identity, this
 * league) — a rostered player can never surface, and an unresolved identity is
 * never offered.
 */

import { buildScore, type DecisionScore } from "./decision-score";
import { weeklyVOR } from "./replacement";
import { buildOptimalLineup } from "./lineup";
import type { CanonicalRoster } from "@/lib/canonical/schema";
import type {
  Confidence,
  Priority,
  WeeklyTeamContext,
  WeeklyWarning,
} from "./schema";
import type { CanonicalPlayer } from "@/lib/canonical/schema";

export interface WaiverCandidateEval {
  add_player_id: string;
  add_name: string;
  position: string;
  nfl_team: string | null;
  weekly_projection: number | null;
  rest_of_season_points: number | null;
  weekly_vor: number | null;
  flex_vor: number | null;

  immediate_role: string;
  rest_of_season_role: string;

  drop_player_id: string | null;
  drop_name: string | null;
  drop_cost: number;

  net_roster_gain: number;
  /** counterfactual optimal-lineup gain; `null` when a projection gap makes it unresolvable */
  starter_impact: number | null;
  starter_impact_status: "RESOLVED" | "UNRESOLVED";
  bench_impact: number;
  bye_coverage_impact: number;
  injury_hedge_impact: number;

  priority: Priority | "DO_NOT_ADD";
  confidence: Confidence;
  score: DecisionScore;
  reasons: string[];
  ros_signal: import("./schema").RosSignal | null;
}

export interface WaiverResult {
  week: number;
  league_slug: string;
  waiver_model: "faab" | "rolling_priority" | "free_agency" | "unknown";
  roster_has_open_spot: boolean;
  faab: { budget: number | null; remaining: number | null; suggested_bid_note: string } | null;
  waiver_priority: { current: number | null; note: string } | null;
  recommendations: WaiverCandidateEval[];
  considered: number;
  do_not_add: Array<{ add_player_id: string; add_name: string; reason: string; starter_impact: number | null; starter_impact_status: "RESOLVED" | "UNRESOLVED" }>;
  warnings: WeeklyWarning[];
}

const BASE_POS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const MIN_NET_TO_RECOMMEND = 0.75;

export function buildWaiverRecommendations(
  ctx: WeeklyTeamContext,
  opts: { limit?: number } = {},
): WaiverResult {
  const warnings: WeeklyWarning[] = [];
  const limit = opts.limit ?? 8;
  const proj = (id: string) => ctx.projections.by_player.get(id) ?? null;

  const myPlayers = new Map<string, CanonicalPlayer>(ctx.all_rostered.map((p) => [p.canonical_player_id, p]));

  // ---- Active vs reserve capacity. A HEALTHY waiver candidate must occupy a
  // starter/bench seat; an empty IR/taxi slot does NOT create an open active
  // spot, so it does not remove the need to drop an active-roster player.
  const irSet = new Set(ctx.roster.ir);
  const taxiSet = new Set(ctx.roster.taxi);
  const activeIds = ctx.roster.all_players.filter((id) => !irSet.has(id) && !taxiSet.has(id));
  const activeCap = ctx.league.roster_constraints.active_roster_capacity;
  const openActiveSpot = activeCap > 0 && activeIds.length < activeCap;
  const openReserveIr = ctx.league.roster_constraints.reserve_ir_capacity > ctx.roster.ir.length;

  const weeksRemaining = Math.max(1, 18 - ctx.league.week);

  // ---- Baseline optimal legal lineup — the source of truth for starter impact.
  const constraints = ctx.league.roster_constraints;
  const baseline = buildOptimalLineup({
    week: ctx.league.week,
    roster: ctx.roster,
    constraints,
    players: myPlayers,
    projections: ctx.projections,
  });
  const baselineOptimal = baseline.optimal_total;

  /**
   * Counterfactual: does ADD (dropping `dropId`) raise the OPTIMAL legal lineup?
   * Runs the same Hungarian optimizer on the hypothetical roster — the waiver
   * engine consumes lineup optimization, it does not re-approximate FLEX logic.
   *
   * Returns `null` (NOT 0) when the comparison cannot be supported:
   *   - the baseline optimal total is unavailable (UNKNOWN optimal starter), or
   *   - the baseline lineup is PROVISIONAL (an eligible bench player has no
   *     projection — its real value could erase any claimed gain), or
   *   - the drop is an UNKNOWN player (we cannot judge what we are giving up), or
   *   - the hypothetical optimal total is unavailable / PROVISIONAL, or
   *   - the drop leaves a required starter slot UNFILLABLE (a legal lineup can no
   *     longer be fielded — the add/drop pair is simply illegal).
   * A candidate must never earn a fake starter gain off an unresolved baseline.
   */
  const weeklyKnown = (id: string): boolean => {
    const p = proj(id);
    return p != null && (p.projected_points != null || p.projection_status === "bye");
  };
  // Per-LABEL empty-slot counts (not a Set) so the legality check catches a
  // hypothetical that turns one "RB" hole into two.
  const countBy = (arr: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const s of arr) m.set(s, (m.get(s) ?? 0) + 1);
    return m;
  };
  const baseEmptyCount = countBy(baseline.empty_slots);
  const hypoLineup = (add: CanonicalPlayer, dropId: string | null) => {
    const hypoPlayers = new Map(myPlayers);
    hypoPlayers.set(add.canonical_player_id, add);
    const keep = ctx.roster.all_players.filter((id) => id !== dropId);
    const hypoRoster: CanonicalRoster = {
      ...ctx.roster,
      all_players: [...keep, add.canonical_player_id],
      starters: ctx.roster.starters.filter((id) => id !== dropId),
      bench: [...ctx.roster.bench.filter((id) => id !== dropId), add.canonical_player_id],
      slots: ctx.roster.slots.filter((s) => s.canonical_player_id !== dropId),
    };
    return buildOptimalLineup({ week: ctx.league.week, roster: hypoRoster, constraints, players: hypoPlayers, projections: ctx.projections });
  };

  /**
   * Evaluate ONE (add, drop) pair on the counterfactual optimal lineup.
   *   legal  — the post-move roster fields every required starter slot: the
   *            hypothetical adds NO new unfilled slot at any label (STRUCTURAL,
   *            independent of projection availability; a slot held by an UNKNOWN
   *            player is filled, not a hole).
   *   gain   — SIGNED counterfactual optimal-lineup delta (may be negative — a
   *            drop that hurts the lineup is a real cost), or `null` when it
   *            cannot be supported (unresolved baseline / hypothetical, or an
   *            UNKNOWN drop).
   */
  const evalPair = (add: CanonicalPlayer, dropId: string | null): { legal: boolean; gain: number | null } => {
    const hypo = hypoLineup(add, dropId);
    const hypoEmptyCount = countBy(hypo.empty_slots);
    const legal = [...hypoEmptyCount].every(([label, n]) => n <= (baseEmptyCount.get(label) ?? 0));
    let gain: number | null = null;
    if (
      legal &&
      baselineOptimal != null &&
      baseline.optimality_status !== "PROVISIONAL" &&
      (dropId == null || weeklyKnown(dropId)) &&
      hypo.optimal_total != null &&
      hypo.optimality_status !== "PROVISIONAL"
    ) {
      gain = Math.round((hypo.optimal_total - baselineOptimal) * 100) / 100;
    }
    return { legal, gain };
  };

  // Rest-of-season replacement per position: the ROS points of a "realistically
  // available" free agent, so the ROS component is a per-week EDGE, not raw
  // season points (which would swamp every other component).
  const rosReplacementAt: Record<string, number> = {};
  for (const pos of BASE_POS) {
    const faRos = ctx.availability.free_agents
      .map((fa) => proj(fa.canonical_player_id))
      .filter((wp) => wp && wp.position === pos && wp.rest_of_season_points != null)
      .map((wp) => wp!.rest_of_season_points!)
      .sort((a, b) => b - a);
    rosReplacementAt[pos] = faRos.length ? (faRos[Math.min(2, faRos.length - 1)] ?? 0) : 0;
  }
  const rosEdgePerWeek = (pos: string, ros: number | null): number | null =>
    ros == null ? null : clamp((ros - (rosReplacementAt[pos] ?? 0)) / weeksRemaining, -4, 4);

  // Value of every player I roster (for the drop side). "keep" = cost of dropping.
  const rosterValue = ctx.all_rostered.map((p) => {
    const wp = proj(p.canonical_player_id);
    const v = weeklyVOR(p.canonical_player_id, p.position, wp?.projected_points ?? null, ctx.replacement);
    const rosEdge = rosEdgePerWeek(p.position, wp?.rest_of_season_points ?? null) ?? 0;
    const isStarter = ctx.roster.starters.includes(p.canonical_player_id);
    // A starter is protected only in proportion to how much better than the
    // waiver line they actually are — a bad starter (below replacement) is not.
    const starterProtection = isStarter ? Math.max(0, v.vor ?? -3) : 0;
    // Raw (can be negative) so a below-replacement player has a lower keep than a
    // playable one even when both have VOR <= 0.
    const keep = (v.vor ?? -3) + Math.max(0, rosEdge) * 1.2 + starterProtection;
    return { player: p, keep, isStarter, weekly: wp?.projected_points ?? null };
  });
  const dropBoard = [...rosterValue].sort((a, b) => a.keep - b.keep); // worst first

  const injuredStarterPos = new Set<string>(
    ctx.roster.starters
      .map((id) => ({ p: myPlayers.get(id), wp: proj(id) }))
      .filter((x) => x.p && x.wp && x.wp.expected_availability < 0.8)
      .map((x) => String(x.p!.position)),
  );
  const byeHolePos = new Set<string>(
    ctx.byes.starters_on_bye_this_week
      .map((id) => myPlayers.get(id)?.position)
      .filter((x): x is NonNullable<typeof x> => x != null)
      .map((x) => String(x)),
  );

  // ---- prefilter: only players who could plausibly matter get the (more
  // expensive) counterfactual optimizer run.
  const prefiltered = ctx.availability.free_agents
    .map((fa) => ({ fa, wp: proj(fa.canonical_player_id) }))
    .filter(({ wp }) => wp && (wp.projected_points != null || wp.rest_of_season_points != null))
    .map(({ fa, wp }) => {
      const vor = weeklyVOR(fa.canonical_player_id, wp!.position, wp!.projected_points, ctx.replacement);
      const rosEdge = rosEdgePerWeek(wp!.position, wp!.rest_of_season_points ?? null) ?? 0;
      const cheapScore = (wp!.projected_points ?? 0) + Math.max(0, rosEdge) * 2;
      return { fa, wp: wp!, vor, rosEdge, cheapScore };
    });
  const considered = prefiltered.length;

  // A candidate is boosted only if it can ACTUALLY fill the deficient slot —
  // each need carries its own `eligible_positions` (a base position, or the flex
  // slot's own eligibility set), so a QB never gets an ordinary-FLEX boost.
  const needBoost = new Set<string>();
  for (const n of ctx.positional_needs) {
    if (n.severity !== "critical" && n.severity !== "weak") continue;
    for (const p of n.eligible_positions) needBoost.add(p);
  }
  // A candidate is "needed" if it addresses a critical/weak positional need, a
  // bye hole, or an injured starter — these are NOT subject to the global
  // points-ranked cutoff (which could otherwise drop every K/DEF option behind
  // 60 higher-scoring skill players when the K/DEF slot is empty or on bye).
  const isNeeded = (c: (typeof prefiltered)[number]) =>
    needBoost.has(c.wp.position) || byeHolePos.has(c.wp.position) || injuredStarterPos.has(c.wp.position);
  const filtered = prefiltered.filter(
    (c) => (c.vor.vor ?? -99) > -4 || c.rosEdge > 0.5 || isNeeded(c),
  );
  const neededCands = filtered.filter(isNeeded).sort((a, b) => b.cheapScore - a.cheapScore);
  const otherCands = filtered
    .filter((c) => !isNeeded(c))
    .sort((a, b) => b.cheapScore - a.cheapScore)
    .slice(0, 60);
  const serious = [
    ...neededCands,
    ...otherCands.filter((c) => !neededCands.includes(c)),
  ].slice(0, Math.max(60, neededCands.length + 20));

  const evals: WaiverCandidateEval[] = [];

  for (const { fa, wp, vor } of serious) {
    const pos = wp.position;
    const weekly = wp.projected_points;
    const ros = wp.rest_of_season_points;
    const rosSig = wp.ros;

    // ---- Drop side. Evaluate the FULL (add, drop) pair for EVERY assessable
    // active player, keep only pairs that leave a legal fieldable lineup, and
    // pick the best pair by (signed gain - keep) — never just the globally
    // lowest-keep player (which might be the roster's only QB), and never a
    // truncated shortlist that could miss the best legal pair.
    let dropChoice: (typeof dropBoard)[number] | null = null;
    let starterGainRaw: number | null = null;
    if (openActiveSpot) {
      starterGainRaw = evalPair(fa.player, null).gain;
    } else {
      const candidates = dropBoard.filter(
        (d) =>
          d.player.canonical_player_id !== fa.canonical_player_id &&
          activeIds.includes(d.player.canonical_player_id) &&
          weeklyKnown(d.player.canonical_player_id),
      );
      let bestScore = -Infinity;
      for (const d of candidates) {
        const { legal, gain } = evalPair(fa.player, d.player.canonical_player_id);
        if (!legal) continue; // a drop that leaves a required slot unfillable is not a candidate
        const pairScore = (gain ?? 0) - Math.max(0, d.keep);
        if (pairScore > bestScore) {
          bestScore = pairScore;
          dropChoice = d;
          starterGainRaw = gain;
        }
      }
    }
    // Roster is full and NO drop is both assessable and lineup-legal (e.g. the
    // only sub-replacement player is the roster's lone QB). NOT an open spot.
    const noAssessableDrop = !openActiveSpot && dropChoice == null;
    const drop_cost = dropChoice ? round2(dropChoice.keep) : 0;

    // `null` => the counterfactual is unsupported (projection gap in the baseline
    // or hypothetical) — NOT a 0, and it downgrades confidence.
    const starterGainUnresolved = starterGainRaw == null && !noAssessableDrop;
    // SIGNED — a legal pair that LOWERS the optimal lineup is a real cost that
    // must show up in the score and `starter_impact`, not be clamped to 0.
    const starterGainSigned = starterGainRaw ?? 0;
    // Positive-only view, for presentation thresholds (immediate_role text,
    // HIGH-priority gate) that only make sense when the move is an upgrade.
    const starterGain = Math.max(0, starterGainSigned);

    const benchImpact = starterGain > 0.25 ? 0 : Math.max(0, vor.vor ?? -3) * 0.5;
    // Scarcity credit = the strongest need this candidate's position can ACTUALLY
    // solve (its own base need, or any flex-slot need whose eligibility set
    // includes `pos`).
    const sev = (s?: string) => (s === "critical" ? 4 : s === "weak" ? 2 : 0);
    const scarcityRaw = Math.max(
      0,
      ...ctx.positional_needs.filter((n) => n.eligible_positions.includes(pos)).map((n) => sev(n.severity)),
    );
    const byeRaw = byeHolePos.has(pos) && !wp.is_bye ? Math.min(6, weekly ?? 0) : 0;
    const hedgeRaw = injuredStarterPos.has(pos) && !wp.is_bye ? Math.min(5, (weekly ?? 0) * 0.5) : 0;

    // RI ordinal ROS signal + disagreement.
    const riDisagrees = rosSig?.disagreement_direction === "RI_ABOVE" || rosSig?.disagreement_direction === "RI_BELOW";
    const riMaterialDisagree = riDisagrees && Math.abs(rosSig?.disagreement_pct ?? 0) > 0.3;

    const score = buildScore([
      { key: "starter_upgrade", label: "Counterfactual optimal-lineup delta from the add/drop (signed)", raw: starterGainUnresolved || noAssessableDrop || Math.abs(starterGainSigned) < 0.05 ? null : round2(starterGainSigned), note: starterGainUnresolved ? "unresolved — a projection gap makes the counterfactual optimal lineup unavailable" : dropChoice ? `vs dropping ${nameOf(dropChoice.player)}` : noAssessableDrop ? "roster full — no assessable, lineup-legal drop" : "into an open active spot" },
      { key: "weekly_vor", label: "Weekly value over replacement", raw: vor.vor },
      { key: "bench_utility", label: "Bench depth value", raw: benchImpact > 0 ? round2(benchImpact) : null },
      { key: "positional_scarcity", label: "Position is thin on this roster", raw: scarcityRaw || null },
      { key: "bye_coverage", label: "Covers a bye-week hole this week", raw: byeRaw || null },
      { key: "injury_hedge", label: "Hedges an injured starter at this position", raw: hedgeRaw || null },
      { key: "rest_of_season_value", label: "Rest-of-season edge over replacement (pts/week, external)", raw: rosEdgePerWeek(pos, ros ?? null), note: `ROS confidence ${rosSig?.confidence ?? "n/a"}${riDisagrees ? `; RI ${rosSig?.disagreement_direction}` : ""}` },
      { key: "drop_cost", label: "Cost of the required drop", raw: drop_cost > 0 ? -drop_cost : null, note: dropChoice ? `drop ${nameOf(dropChoice.player)}` : noAssessableDrop ? "roster full — no assessable, lineup-legal drop" : "open active roster spot" },
      { key: "uncertainty_penalty", label: "Low-confidence projection penalty", raw: (wp.projection_status !== "projected" && wp.projection_status !== "bye") || weekly == null || riMaterialDisagree || starterGainUnresolved || noAssessableDrop ? -1.5 : null, note: noAssessableDrop ? "roster full and no active player has an assessable weekly value" : starterGainUnresolved ? "counterfactual lineup gain unresolved (projection gap)" : riMaterialDisagree ? "RI and external season models disagree materially" : undefined },
    ]);

    const net = score.total;
    const confidence: Confidence =
      weekly == null || riMaterialDisagree || starterGainUnresolved || noAssessableDrop ? "LOW" : starterGain >= 3 && net >= 4 ? "HIGH" : net >= 2 ? "MEDIUM" : "LOW";

    let priority: WaiverCandidateEval["priority"];
    // Cannot recommend an add that has no makeable drop.
    if (noAssessableDrop) priority = "DO_NOT_ADD";
    else if (net < MIN_NET_TO_RECOMMEND) priority = "DO_NOT_ADD";
    else if (net >= 4 && !starterGainUnresolved && (starterGain > 0.5 || byeRaw > 0 || hedgeRaw > 0)) priority = "HIGH";
    else if (net >= 2) priority = "MEDIUM";
    else priority = "LOW";

    const immediate_role =
      starterGain > 0.5
        ? `raises optimal lineup +${starterGain.toFixed(1)}${dropChoice ? "" : noAssessableDrop ? " (no drop available)" : " (open spot)"}`
        : byeRaw > 0
          ? `bye-week fill at ${pos}`
          : hedgeRaw > 0
            ? `injury insurance at ${pos}`
            : (vor.vor ?? -1) > 1
              ? `${pos} bench depth`
              : "marginal";
    const riRank = rosSig?.ri_position_rank;
    const rest_of_season_role =
      riRank != null && riRank <= 30
        ? `RI has him ~${pos}${riRank} rest-of-season`
        : ros != null && ros > 60
          ? `${pos}2/3 rest-of-season value`
          : ros != null && ros > 25
            ? `${pos} streamer / stash`
            : "limited rest-of-season value";

    const reasons: string[] = [];
    if (starterGainUnresolved && !noAssessableDrop) reasons.push("Counterfactual starter impact is unresolved — a projection gap makes the baseline or post-move optimal lineup unavailable. No starter gain is claimed; confidence is capped LOW.");
    if (!starterGainUnresolved && !noAssessableDrop && starterGainSigned > 0.25) reasons.push(`Raises the optimal legal lineup by +${starterGainSigned.toFixed(1)} (add ${nameOf(fa.player)}${dropChoice ? `, drop ${nameOf(dropChoice.player)}` : ""}).`);
    if (!starterGainUnresolved && !noAssessableDrop && starterGainSigned < -0.25) reasons.push(`This add/drop LOWERS the optimal legal lineup by ${starterGainSigned.toFixed(1)} (the best available legal drop still costs starting points this week).`);
    if (byeRaw > 0) reasons.push(`Covers a ${pos} bye hole this week.`);
    if (hedgeRaw > 0) reasons.push(`Insurance for an injured ${pos} starter.`);
    if (starterGain <= 0.25 && (vor.vor ?? 0) > 3) reasons.push(`+${vor.vor?.toFixed(1)} weekly VOR — playable depth, but not a starter upgrade in the optimal lineup.`);
    if (riDisagrees) reasons.push(`RI season model is ${rosSig!.disagreement_direction === "RI_ABOVE" ? "higher" : "lower"} than the external projection by ${Math.round(Math.abs(rosSig!.disagreement_pct ?? 0) * 100)}% (${rosSig!.warnings[0] ?? "see ros"}).`);
    if (priority === "DO_NOT_ADD" && !noAssessableDrop) reasons.push(`Net roster gain ${net.toFixed(1)} does not clear the drop cost (${drop_cost.toFixed(1)}).`);
    if (weekly == null) reasons.push("No weekly projection — rest-of-season stash only, low confidence.");
    if (noAssessableDrop) reasons.push("No legal drop preserves a fieldable starting roster (every assessable drop either can't be valued or would leave a required starter slot unfillable) — transaction not recommended.");

    evals.push({
      add_player_id: fa.canonical_player_id,
      add_name: nameOf(fa.player),
      position: pos,
      nfl_team: wp.nfl_team,
      weekly_projection: weekly,
      rest_of_season_points: ros,
      weekly_vor: vor.vor,
      flex_vor: vor.flex_vor,
      immediate_role,
      rest_of_season_role,
      drop_player_id: dropChoice?.player.canonical_player_id ?? null,
      drop_name: dropChoice ? nameOf(dropChoice.player) : null,
      drop_cost,
      net_roster_gain: net,
      starter_impact: starterGainUnresolved || noAssessableDrop ? null : round2(starterGainSigned),
      starter_impact_status: starterGainUnresolved || noAssessableDrop ? "UNRESOLVED" : "RESOLVED",
      bench_impact: round2(benchImpact),
      bye_coverage_impact: round2(byeRaw),
      injury_hedge_impact: round2(hedgeRaw),
      priority,
      confidence,
      score,
      reasons,
      ros_signal: rosSig ?? null,
    });
  }
  void openReserveIr;

  evals.sort((a, b) => b.net_roster_gain - a.net_roster_gain);
  const recommendations = evals.filter((e) => e.priority !== "DO_NOT_ADD").slice(0, limit);
  const do_not_add = evals
    .filter((e) => e.priority === "DO_NOT_ADD")
    .slice(0, 5)
    .map((e) => ({
      add_player_id: e.add_player_id,
      add_name: e.add_name,
      reason:
        e.reasons.find((r) => /LOWERS the optimal|No legal drop|projection is missing|unresolved/i.test(r)) ??
        e.reasons.at(-1) ??
        "not worth the drop",
      starter_impact: e.starter_impact,
      starter_impact_status: e.starter_impact_status,
    }));

  const ws = ctx.league.waiver_settings;
  const waiver_model =
    ws.type === "faab" ? "faab" : ws.type === "reverse_standings" || ws.type === "rolling" ? "rolling_priority" : ws.type === "unknown" ? "unknown" : "free_agency";

  if (ctx.availability.free_agents.length === 0) {
    warnings.push({ code: "no_free_agents", message: "No projected free agents in this league's pool.", severity: "warning" });
  }
  if (ctx.projections.status !== "READY") {
    warnings.push({ code: "waiver_projection_quality", message: `Waiver values use ${ctx.projections.status} projections.`, severity: "info" });
  }

  return {
    week: ctx.league.week,
    league_slug: ctx.league.slug,
    waiver_model,
    roster_has_open_spot: openActiveSpot,
    faab:
      waiver_model === "faab"
        ? {
            budget: ws.faab_budget,
            remaining: ctx.fantasy_team.faab_remaining,
            suggested_bid_note:
              "FAAB bid sizing is a later phase; scale bids to net_roster_gain and remaining budget, spending more on HIGH-priority starter upgrades early in the season.",
          }
        : null,
    waiver_priority:
      waiver_model === "rolling_priority"
        ? { current: ctx.fantasy_team.waiver_priority, note: "Rolling/reverse-standings waivers — spend priority on HIGH-priority claims only." }
        : null,
    recommendations,
    considered,
    do_not_add,
    warnings,
  };
}


const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function nameOf(p: CanonicalPlayer): string {
  return p.full_name || p.canonical_player_id;
}
