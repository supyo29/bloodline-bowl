/**
 * PR #3 — real-league week-1 validation for the three target managers, with the
 * full corrected-engine field list. Hits real Sleeper.
 *
 *   npx tsx scripts/phaseG-validate.ts [week]
 */

import { buildWeeklyTeamContext } from "../lib/weekly/context";
import { buildOptimalLineup } from "../lib/weekly/lineup";
import { buildMatchup } from "../lib/weekly/matchup";
import { buildWaiverRecommendations } from "../lib/weekly/waivers";

const WEEK = Number(process.argv[2] ?? 1);
const TARGETS = [
  ["bloodline-bowl", "supyo29"],
  ["bloodline-bowl", "BijiMac"],
  ["devoted-to-the-game", "DarthMarker"],
] as const;

const n2 = (v: number | null | undefined) => (v == null ? "n/a" : (Math.round(v * 100) / 100).toString());

async function main() {
  for (const [league, manager] of TARGETS) {
    console.log(`\n${"=".repeat(74)}\n${league} / ${manager} — week ${WEEK}\n${"=".repeat(74)}`);
    const built = await buildWeeklyTeamContext(league, manager, { week: WEEK });
    if (!built.context) {
      console.log(`  ERROR ${built.code} ${built.detail}`);
      continue;
    }
    const ctx = built.context;
    const nameOf = (id: string | null) =>
      id == null ? "(open spot)" : ctx.all_rostered.find((p) => p.canonical_player_id === id)?.full_name ?? id;

    // (a) baseline optimal legal lineup
    const players = new Map(ctx.all_rostered.map((p) => [p.canonical_player_id, p]));
    const lu = buildOptimalLineup({
      week: WEEK,
      roster: ctx.roster,
      constraints: ctx.league.roster_constraints,
      players,
      projections: ctx.projections,
    });
    console.log(
      `\n  BASELINE OPTIMAL LINEUP  optimality=${lu.optimality_status}  ` +
        `optimal_total=${n2(lu.optimal_total)} (known subtotal ${n2(lu.known_optimal_subtotal)})  ` +
        `current_total=${n2(lu.current_total)}  gain=${n2(lu.projected_points_gained)}  efficiency=${n2(lu.lineup_efficiency)}`,
    );
    if (lu.provisional_reason) console.log(`    provisional: ${lu.provisional_reason}`);
    console.log(
      `    coverage: optimal ${lu.projection_coverage.optimal_slots_known}/${lu.projection_coverage.optimal_slots_total} known,  ` +
        `current ${lu.projection_coverage.current_slots_known}/${lu.projection_coverage.current_slots_filled} known`,
    );
    for (const s of lu.slots) {
      console.log(
        `    ${s.slot.padEnd(6)} ${(nameOf(s.recommended_player_id) ?? "-").padEnd(24)} ${n2(s.recommended_projected)}  ` +
          `[${s.recommended_projection_state ?? "-"}]${s.is_starter_set_change ? "  <- ENTERING" : ""}`,
      );
    }
    console.log(`  GENUINE STARTER-SET CHANGES: ${lu.changes_recommended.length === 0 ? "(none — lineup optimal)" : ""}`);
    for (const c of lu.changes_recommended) {
      console.log(`    ${c.slot}: start ${nameOf(c.in)} over ${nameOf(c.out)}  (+${n2(c.gain)})`);
    }
    for (const u of lu.unresolved_decisions) console.log(`    UNRESOLVED ${u.slot}: ${u.reason}`);

    // (k) active roster capacity
    const rc = ctx.league.roster_constraints;
    console.log(
      `\n  ROSTER CAPACITY  active=${ctx.roster.all_players.filter((id) => !ctx.roster.ir.includes(id) && !ctx.roster.taxi.includes(id)).length}/${rc.active_roster_capacity}  ` +
        `IR=${ctx.roster.ir.length}/${rc.reserve_ir_capacity}  taxi=${ctx.roster.taxi.length}/${rc.taxi_capacity}`,
    );

    // (j) bye / schedule status
    console.log(
      `  BYE / SCHEDULE  status=${ctx.byes.bye_status}  source=${ctx.byes.schedule_source ?? "none"}  ` +
        `teams_on_bye=[${ctx.byes.teams_on_bye.join(",")}]  my_starters_on_bye=[${ctx.byes.starters_on_bye_this_week.map(nameOf).join(",")}]`,
    );

    // matchup totals / margin honesty under projection gaps
    const mu = buildMatchup(ctx);
    console.log(
      `  MATCHUP  has_opponent=${mu.has_opponent}  ` +
        `team_optimal=${n2(mu.team_optimal_total)} (known ${n2(mu.team_known_subtotal)})  ` +
        `opp_optimal=${n2(mu.opponent_optimal_total)} (known ${n2(mu.opponent_known_subtotal)})  ` +
        `margin=${n2(mu.projected_margin)} [${mu.projected_margin_status}]  win_prob=${n2(mu.win_probability)} [${mu.win_probability_confidence}]`,
    );

    // (g/h/i) ROS signal summary
    console.log(
      `  ROS SIGNAL  ${ctx.ros_signal ? `ri_status via meta; model=${ctx.ros_signal.ri_model_version ?? "n/a"}  external_source=${ctx.ros_signal.external_source}  ` +
        `players_with_ri=${ctx.ros_signal.players_with_ri}  players_with_disagreement=${ctx.ros_signal.players_with_disagreement}` : "none"}`,
    );

    // waivers — corrected engine decides
    const w = buildWaiverRecommendations(ctx);
    console.log(`\n  WAIVER RECOMMENDATIONS  (considered=${w.considered}, open_active_spot=${w.roster_has_open_spot}, model=${w.waiver_model})`);
    if (w.recommendations.length === 0) console.log("    (engine recommends adding nothing)");
    for (const rec of w.recommendations.slice(0, 5)) {
      const rs = rec.ros_signal;
      const repBasis = ctx.replacement.by_position[rec.position]?.basis ?? "n/a";
      const repRank = ctx.replacement.by_position[rec.position]?.derived_from_rank ?? null;
      console.log(
        `    ${rec.priority.padEnd(11)} ${rec.add_name.padEnd(22)} ${rec.position}  net=${n2(rec.net_roster_gain)}  conf=${rec.confidence}\n` +
          `        drop: ${nameOf(rec.drop_player_id)} (cost ${n2(rec.drop_cost)})\n` +
          `        counterfactual optimal-lineup gain: ${rec.starter_impact_status === "UNRESOLVED" ? "UNRESOLVED (projection gap)" : "+" + n2(rec.starter_impact)}\n` +
          `        weekly VOR: ${n2(rec.weekly_vor)}  flex VOR: ${n2(rec.flex_vor)}  weekly proj: ${n2(rec.weekly_projection)}\n` +
          `        replacement basis: ${repBasis} (rank ${repRank ?? "n/a"}), level ${n2(ctx.replacement.by_position[rec.position]?.replacement_points)}\n` +
          `        ROS external: ${n2(rs?.external_season_points)} season -> ${n2(rs?.points)} remaining;  ` +
          `RI: ${n2(rs?.ri_season_points)} season, posrank ${rs?.ri_position_rank ?? "n/a"}, tier ${rs?.ri_tier ?? "n/a"}\n` +
          `        disagreement: ${rs?.disagreement_direction ?? "n/a"} ${rs?.disagreement_pct != null ? `(${Math.round(rs.disagreement_pct * 100)}%)` : ""}  ROS confidence: ${rs?.confidence ?? "n/a"}`,
      );
    }
    for (const dna of w.do_not_add.slice(0, 4)) console.log(`    DO_NOT_ADD  ${dna.add_name} — ${dna.reason}`);

    // (l) warnings
    console.log(`\n  WARNINGS`);
    for (const wn of ctx.warnings) console.log(`    [${wn.severity}] ${wn.code}: ${wn.message}`);
    if (ctx.warnings.length === 0) console.log("    (none)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
