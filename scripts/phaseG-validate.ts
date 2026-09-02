/**
 * PR #3 — real-league week-1 validation for the three target managers, with the
 * full corrected-engine field list. Hits real Sleeper.
 *
 *   npx tsx scripts/phaseG-validate.ts [week]
 */

import { buildWeeklyTeamContext } from "../lib/weekly/context";
import { buildOptimalLineup } from "../lib/weekly/lineup";
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
    console.log(`\n  BASELINE OPTIMAL LINEUP  total=${n2(lu.optimal_total)}  efficiency=${n2(lu.lineup_efficiency)}`);
    for (const s of lu.slots) {
      const wp = s.recommended_player_id ? ctx.projections.by_player.get(s.recommended_player_id) : null;
      console.log(`    ${s.slot.padEnd(6)} ${(nameOf(s.recommended_player_id) ?? "-").padEnd(24)} ${n2(wp?.projected_points)}  [${wp?.projection_status ?? "-"}]`);
    }

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
          `        counterfactual optimal-lineup gain: +${n2(rec.starter_impact)}\n` +
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
