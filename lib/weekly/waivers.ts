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
  starter_impact: number;
  bench_impact: number;
  bye_coverage_impact: number;
  injury_hedge_impact: number;

  priority: Priority | "DO_NOT_ADD";
  confidence: Confidence;
  score: DecisionScore;
  reasons: string[];
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
  do_not_add: Array<{ add_player_id: string; add_name: string; reason: string }>;
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
  const rosterSizeLimit = ctx.league.roster_constraints.roster_size_limit;
  const openSpot = rosterSizeLimit != null && ctx.roster.all_players.length < rosterSizeLimit;
  const weeksRemaining = Math.max(1, 18 - ctx.league.week);

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

  // best current starter proj by position (for "does this upgrade a starter?")
  const bestStarterAt: Record<string, number | null> = {};
  const weakestStarterAt: Record<string, { id: string; pts: number } | null> = {};
  for (const pos of BASE_POS) {
    const startersHere = ctx.roster.starters
      .map((id) => ({ id, p: myPlayers.get(id), wp: proj(id) }))
      .filter((x) => x.p && (x.p.position === pos || x.p.eligible_positions.includes(pos as never)));
    const pts = startersHere.map((x) => x.wp?.projected_points ?? 0);
    bestStarterAt[pos] = pts.length ? Math.max(...pts) : null;
    const weakest = startersHere.sort((a, b) => (a.wp?.projected_points ?? 0) - (b.wp?.projected_points ?? 0))[0];
    weakestStarterAt[pos] = weakest ? { id: weakest.id, pts: weakest.wp?.projected_points ?? 0 } : null;
  }

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

  const evals: WaiverCandidateEval[] = [];
  let considered = 0;

  for (const fa of ctx.availability.free_agents) {
    const wp = proj(fa.canonical_player_id);
    if (!wp || (wp.projected_points == null && wp.rest_of_season_points == null)) continue;
    considered += 1;
    const pos = wp.position;
    const weekly = wp.projected_points;
    const ros = wp.rest_of_season_points;

    const vor = weeklyVOR(fa.canonical_player_id, pos, weekly, ctx.replacement);

    // starter upgrade?
    const weakest = weakestStarterAt[pos] ?? null;
    const starterUpgrade = weekly != null && weakest && weakest.pts != null ? Math.max(0, weekly - weakest.pts) : 0;
    const flexWeakest = pos === "RB" || pos === "WR" || pos === "TE" ? weakestFlex(ctx, myPlayers, proj) : null;
    const flexUpgrade =
      starterUpgrade === 0 && weekly != null && flexWeakest != null ? Math.max(0, weekly - flexWeakest) : 0;

    const benchImpact = starterUpgrade > 0 || flexUpgrade > 0 ? 0 : Math.max(0, (vor.vor ?? -3)) * 0.5;
    const scarcity = ctx.positional_needs.find((n) => n.position === pos);
    const scarcityRaw = scarcity && scarcity.severity === "critical" ? 4 : scarcity && scarcity.severity === "weak" ? 2 : 0;
    const byeRaw = byeHolePos.has(pos) && !wp.is_bye ? Math.min(6, weekly ?? 0) : 0;
    const hedgeRaw = injuredStarterPos.has(pos) && !wp.is_bye ? Math.min(5, (weekly ?? 0) * 0.5) : 0;

    // Drop side.
    const dropChoice = openSpot ? null : dropBoard.find((d) => d.player.canonical_player_id !== fa.canonical_player_id) ?? null;
    const drop_cost = openSpot ? 0 : round2(dropChoice?.keep ?? 0);

    const score = buildScore([
      { key: "starter_upgrade", label: "Upgrades a current starter", raw: starterUpgrade > 0 ? round2(starterUpgrade) : null, note: weakest ? `over weakest ${pos} starter (${weakest.pts.toFixed(1)})` : undefined },
      { key: "flex_utility", label: "Upgrades a FLEX slot", raw: flexUpgrade > 0 ? round2(flexUpgrade) : null },
      { key: "weekly_vor", label: "Weekly value over replacement", raw: vor.vor },
      { key: "bench_utility", label: "Bench depth value", raw: benchImpact > 0 ? round2(benchImpact) : null },
      { key: "positional_scarcity", label: "Position is thin on this roster", raw: scarcityRaw || null },
      { key: "bye_coverage", label: "Covers a bye-week hole this week", raw: byeRaw || null },
      { key: "injury_hedge", label: "Hedges an injured starter at this position", raw: hedgeRaw || null },
      { key: "rest_of_season_value", label: "Rest-of-season edge over replacement (pts/week)", raw: rosEdgePerWeek(pos, ros ?? null), note: "clamped per-remaining-week ROS VOR" },
      { key: "drop_cost", label: "Cost of the required drop", raw: drop_cost > 0 ? -drop_cost : null, note: dropChoice ? `drop ${nameOf(dropChoice.player)}` : "open roster spot" },
      { key: "uncertainty_penalty", label: "Low-confidence projection penalty", raw: wp.projection_status !== "projected" || weekly == null ? -1.5 : null },
    ]);

    const net = score.total;
    const confidence: Confidence =
      weekly == null ? "LOW" : starterUpgrade >= 3 && net >= 4 ? "HIGH" : net >= 2 ? "MEDIUM" : "LOW";

    let priority: WaiverCandidateEval["priority"];
    if (net < MIN_NET_TO_RECOMMEND) priority = "DO_NOT_ADD";
    else if (net >= 4 && (starterUpgrade > 0 || flexUpgrade > 0 || byeRaw > 0 || hedgeRaw > 0)) priority = "HIGH";
    else if (net >= 2) priority = "MEDIUM";
    else priority = "LOW";

    const immediate_role =
      starterUpgrade > 0
        ? `${pos} starter upgrade (+${starterUpgrade.toFixed(1)} vs weakest starter)`
        : flexUpgrade > 0
          ? `FLEX upgrade (+${flexUpgrade.toFixed(1)})`
          : byeRaw > 0
            ? `bye-week fill at ${pos}`
            : hedgeRaw > 0
              ? `injury insurance at ${pos}`
              : (vor.vor ?? -1) > 1
                ? `${pos} bench depth`
                : "marginal";
    const rest_of_season_role =
      ros != null && ros > 60 ? `${pos}2/3 rest-of-season value` : ros != null && ros > 25 ? `${pos} streamer / stash` : "limited rest-of-season value";

    const reasons: string[] = [];
    if (starterUpgrade > 0) reasons.push(`Projects +${starterUpgrade.toFixed(1)} over the weakest ${pos} starter this week.`);
    if (flexUpgrade > 0) reasons.push(`Projects +${flexUpgrade.toFixed(1)} over the weakest FLEX option.`);
    if (byeRaw > 0) reasons.push(`Covers a ${pos} bye hole this week.`);
    if (hedgeRaw > 0) reasons.push(`Insurance for an injured ${pos} starter.`);
    if ((vor.vor ?? 0) > 3 && starterUpgrade === 0) reasons.push(`+${vor.vor?.toFixed(1)} weekly VOR — playable depth.`);
    if (priority === "DO_NOT_ADD") reasons.push(`Net roster gain ${net.toFixed(1)} does not clear the drop cost (${drop_cost.toFixed(1)}).`);
    if (weekly == null) reasons.push("No weekly projection — rest-of-season stash only, low confidence.");

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
      starter_impact: round2(starterUpgrade),
      bench_impact: round2(benchImpact),
      bye_coverage_impact: round2(byeRaw),
      injury_hedge_impact: round2(hedgeRaw),
      priority,
      confidence,
      score,
      reasons,
    });
  }

  evals.sort((a, b) => b.net_roster_gain - a.net_roster_gain);
  const recommendations = evals.filter((e) => e.priority !== "DO_NOT_ADD").slice(0, limit);
  const do_not_add = evals
    .filter((e) => e.priority === "DO_NOT_ADD")
    .slice(0, 5)
    .map((e) => ({ add_player_id: e.add_player_id, add_name: e.add_name, reason: e.reasons.at(-1) ?? "not worth the drop" }));

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
    roster_has_open_spot: openSpot,
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

function weakestFlex(
  ctx: WeeklyTeamContext,
  players: Map<string, CanonicalPlayer>,
  proj: (id: string) => ReturnType<WeeklyTeamContext["projections"]["by_player"]["get"]> | null,
): number | null {
  const flexEligible = ctx.roster.starters
    .map((id) => ({ p: players.get(id), wp: proj(id) }))
    .filter((x) => x.p && ["RB", "WR", "TE"].includes(x.p.position));
  const pts = flexEligible.map((x) => x.wp?.projected_points ?? 0).sort((a, b) => a - b);
  return pts.length ? pts[0]! : null;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function nameOf(p: CanonicalPlayer): string {
  return p.full_name || p.canonical_player_id;
}
