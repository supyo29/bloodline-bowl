/**
 * Phase 3.5D — the chapter LIBRARY and book TEMPLATES (the analytical taxonomy).
 *
 * Chapters are defined once with a stable id and reused across book types (cross-book relationships, saved state).
 * Templates only choose which chapters appear, in which Part, in what order. There is deliberately NO universal list:
 * a WR player book, a defense book and a trade book have different Parts. A chapter names the evidence it needs; where
 * the system has no such evidence it names an UNSUPPORTED capability so the question stays visible and honest.
 */
import type { BookTemplate, BookType, ChapterDef, Need } from "./schema";

const req = (topic: string, o: Partial<Need> = {}): Need => ({ topic, role: "required", bind: "self", ...o });
const enr = (topic: string, o: Partial<Need> = {}): Need => ({ topic, role: "enrich", bind: "self", ...o });
const cap = (capability: string, o: Partial<Need> = {}): Need => ({ capability, role: "required", bind: "self", ...o });
const capE = (capability: string, o: Partial<Need> = {}): Need => ({ capability, role: "enrich", bind: "self", ...o });
const REC = ["WR", "TE", "RB"]; const RUSH = ["RB", "QB"];

const defs: ChapterDef[] = [
  /* ---------------------------------------------------------------- PLAYER & ROLE */
  { id: "player.background", title: "Player background", question: "Who is this player, where does he play, and what role level does the model assign?", tags: ["identity", "role"], needs: [req("role.player_profile"), capE("player_biographical_profile")], viz: ["TABLE"] },
  { id: "player.role.playing_time", title: "Playing time", question: "How much of the offense's snaps does he play, and is that changing?", tags: ["workload", "role", "playing_time", "snaps"], needs: [req("role.player_profile", { history: true, comparisons: true }), enr("fi.player_usage", { history: true, comparisons: true })], viz: ["TIME_SERIES", "PERCENTILE_BAR"] },
  { id: "player.role.route_participation", title: "Route participation", question: "Is he on the field for pass plays and running routes?", tags: ["workload", "role", "routes"], applies_to: REC, needs: [req("role.player_profile", { history: true, comparisons: true }), enr("fi.player_usage", { history: true }), capE("multi_season_route_history")], viz: ["TIME_SERIES", "PERCENTILE_BAR"] },
  { id: "player.role.target_opportunity", title: "Target opportunity", question: "What share of team targets and air yards does he command?", tags: ["workload", "targets", "opportunity", "receiving"], applies_to: REC, needs: [req("role.player_profile", { history: true, comparisons: true }), enr("fi.player_usage", { history: true, comparisons: true })], viz: ["TIME_SERIES", "PERCENTILE_BAR"],
    subchapters: [{ id: "A", title: "Target share vs position-group share" }, { id: "B", title: "Air-yards share and depth of target", needs: [enr("fi.player_usage")] }] },
  { id: "player.role.rushing_usage", title: "Rushing usage", question: "What share of the team's rushing work does he take?", tags: ["workload", "rushing", "opportunity"], applies_to: RUSH, needs: [req("role.player_profile", { history: true, comparisons: true }), enr("fi.player_usage", { history: true })], viz: ["TIME_SERIES", "PERCENTILE_BAR"] },
  { id: "player.role.high_value_usage", title: "High-value usage", question: "How does he use red-zone, goal-line, third-down and two-minute opportunity?", tags: ["workload", "touchdowns", "red_zone", "high_value", "scoring"], needs: [req("role.player_profile", { history: true, comparisons: true }), enr("fi.player_usage", { comparisons: true })], viz: ["TABLE", "PERCENTILE_BAR"] },
  { id: "player.role.trajectory", title: "Role trajectory", question: "Is his role growing, stable or shrinking, and did it change discontinuously?", tags: ["role", "trend", "trajectory"], needs: [req("role.role_change"), req("role.player_profile", { history: true })], viz: ["TIMELINE", "TIME_SERIES"] },
  { id: "player.qb.progression", title: "Quarterback progression profile", question: "How does this quarterback distribute reads and progressions?", tags: ["scheme", "qb", "progression"], applies_to: ["QB"], needs: [req("scheme.qb_progression", { comparisons: true })], viz: ["TABLE", "PERCENTILE_BAR"] },
  { id: "player.qb.spatial_formation", title: "Quarterback spatial & formation profile", question: "Where does he throw and from which formations?", tags: ["scheme", "qb", "spatial", "formation"], applies_to: ["QB"], needs: [req("scheme.qb_spatial"), req("scheme.qb_formation"), capE("qb_pressure_profile")], viz: ["HEATMAP", "TABLE"] },
  { id: "player.scheme.usage_profile", title: "Scheme-specific usage profile", question: "How do the offense's routes, gaps and spatial concepts shape his usage?", tags: ["scheme", "usage"], applies_to: ["WR", "TE", "RB"], needs: [cap("receiver_scheme_profile", { positions: ["WR", "TE"] }), cap("rb_scheme_profile", { positions: ["RB"] })], viz: ["HEATMAP"] },

  /* ---------------------------------------------------------------- TEAM ENVIRONMENT */
  { id: "team.competition", title: "Teammate competition", question: "Who competes with him for the same opportunity?", tags: ["competition", "role", "workload"], needs: [req("role.player_profile", { comparisons: true }), enr("opp.scenario", { bind: "own_team", scenario: true })], depends_on: ["player.role.target_opportunity", "player.role.rushing_usage"], viz: ["COMPARISON_BARS", "TABLE"] },
  { id: "team.offensive_line", title: "Offensive line", question: "How well does the offense protect the passer and generate rushing lanes?", tags: ["line", "protection", "team_environment"], needs: [req("fi.team_metric", { bind: "own_team", params: { side: "offense" }, history: true, comparisons: true }), capE("ol_player_level_pass_block")], viz: ["TIME_SERIES", "PERCENTILE_BAR"] },
  { id: "team.offensive_scheme", title: "Offensive scheme", question: "What is the offense's structure, pace and pass/run orientation?", tags: ["scheme", "tendencies", "team_environment"], needs: [req("fi.team_metric", { bind: "own_team", params: { side: "offense" }, history: true, comparisons: true }), enr("scheme.qb_formation", { bind: "team_qb" }), enr("scheme.qb_progression", { bind: "team_qb" })], viz: ["PERCENTILE_BAR", "TABLE"] },
  { id: "team.coaching_tendencies", title: "Coaching tendencies", question: "What do this staff's tendencies imply for the roles behind them?", tags: ["coaching", "tendencies", "scheme"], needs: [req("fi.team_metric", { bind: "own_team", params: { side: "offense" }, history: true }), capE("coach_specific_profile")], viz: ["TIME_SERIES"] },
  { id: "team.game_script", title: "Game-script sensitivity", question: "How does his production depend on the team leading or trailing?", tags: ["game_script", "environment"], needs: [cap("game_script_splits"), enr("fi.team_metric", { bind: "own_team", params: { side: "offense" } })], viz: ["SCATTER"] },
  { id: "team.red_zone_offense", title: "Team red-zone offense", question: "How efficiently does the offense convert red-zone trips into touchdowns?", tags: ["touchdowns", "red_zone", "scoring", "team_environment"], needs: [req("fi.team_metric", { bind: "own_team", params: { side: "offense", metrics: "off_rz_td_rate" }, history: true, comparisons: true })], viz: ["TIME_SERIES", "PERCENTILE_BAR"] },
  { id: "team.qb_interaction", title: "Quarterback interaction", question: "How does the team's passing quality and quarterback profile feed his role?", tags: ["qb", "scheme", "team_environment"], needs: [req("fi.team_metric", { bind: "own_team", params: { side: "offense", metrics: "off_pass_epa,off_pressure_rate_allowed,off_sack_rate_allowed" }, comparisons: true }), enr("scheme.qb_spatial", { bind: "team_qb" })], viz: ["PERCENTILE_BAR"] },

  /* ---------------------------------------------------------------- PERFORMANCE */
  { id: "player.performance.efficiency", title: "Efficiency", question: "How efficient is he per opportunity?", tags: ["efficiency", "performance"], needs: [cap("player_efficiency_metrics"), enr("fi.player_usage", { history: true })], viz: ["SCATTER"] },
  { id: "player.performance.explosiveness", title: "Explosiveness", question: "Does he generate explosive plays?", tags: ["explosiveness", "performance"], needs: [cap("player_explosive_play_rate"), enr("fi.player_usage")], viz: ["DISTRIBUTION"] },
  { id: "player.performance.expected_vs_actual", title: "Expected vs actual production", question: "Is his production above or below what his opportunity implies?", tags: ["efficiency", "performance", "regression"], needs: [cap("expected_fantasy_points_model")], viz: ["SCATTER"] },
  { id: "player.performance.sustainability", title: "Sustainability of usage", question: "Is his observed usage above or below its modeled / prior level?", tags: ["sustainability", "regression", "uncertainty"], needs: [req("fi.player_usage", { history: true, comparisons: true })], viz: ["TIME_SERIES", "PERCENTILE_BAR"] },

  /* ---------------------------------------------------------------- MATCHUP & FORWARD OUTLOOK */
  { id: "matchup.defensive_structure", title: "Opposing defensive structure", question: "How strong is the opposing defense against the pass and the run?", tags: ["matchup", "defense", "environment"], needs: [req("fi.team_metric", { bind: "opponent", params: { side: "defense" }, history: true, comparisons: true })], viz: ["PERCENTILE_BAR", "TIME_SERIES"] },
  { id: "matchup.coverage_interaction", title: "Coverage interaction", question: "How does the opponent's coverage structure interact with his role?", tags: ["matchup", "coverage", "scheme", "slot_boundary"], needs: [req("scheme.defense_coverage", { bind: "opponent", comparisons: true }), cap("receiver_scheme_profile", { positions: ["WR", "TE"] })], viz: ["HEATMAP", "TABLE"],
    subchapters: [
      { id: "A", title: "Man vs zone usage", needs: [req("scheme.defense_coverage", { bind: "opponent" })] },
      { id: "B", title: "Coverage shell", needs: [req("scheme.defense_coverage", { bind: "opponent" })] },
      { id: "C", title: "Slot / boundary matchup", needs: [cap("slot_boundary_alignment_data")], tags: ["slot_boundary"] },
      { id: "D", title: "Safety help / bracket risk", needs: [cap("safety_help_bracket_data")] },
      { id: "E", title: "Historical performance versus similar structures", needs: [req("scheme.defense_coverage", { bind: "opponent", history: true })] },
    ] },
  { id: "matchup.pressure_protection", title: "Pressure & protection", question: "How does the opposing pass rush meet this offense's protection?", tags: ["matchup", "pressure", "protection", "line", "qb"], needs: [req("fi.team_metric", { bind: "opponent", params: { side: "defense", metrics: "def_pressure_rate,def_blitz_rate" }, comparisons: true }), req("fi.team_metric", { bind: "own_team", params: { side: "offense", metrics: "off_pressure_rate_allowed,off_sack_rate_allowed" }, comparisons: true })], viz: ["PERCENTILE_BAR", "COMPARISON_BARS"] },
  { id: "matchup.cornerback_assignment", title: "Cornerback assignment", question: "Which defender is expected to cover him?", tags: ["matchup", "coverage", "assignment"], applies_to: ["WR", "TE"], needs: [cap("cornerback_assignment_data")], viz: ["TABLE"] },
  { id: "matchup.red_zone_defense", title: "Opposing red-zone defense", question: "How well does the opponent defend the red zone?", tags: ["touchdowns", "red_zone", "matchup", "scoring"], needs: [req("fi.team_metric", { bind: "opponent", params: { side: "defense", metrics: "def_rz_td_rate_allowed" }, comparisons: true })], viz: ["PERCENTILE_BAR"] },
  { id: "matchup.fantasy_view", title: "Fantasy matchup view (shadow)", question: "What does the shadow matchup model say about this week's scoring environment?", tags: ["matchup", "fantasy", "shadow", "scoring"], needs: [req("matchup.shadow", { bind: "manager" })], viz: ["DISTRIBUTION"] },
  { id: "schedule.remaining", title: "Remaining NFL schedule", question: "How favorable are the opponents still to come?", tags: ["schedule", "forward"], needs: [cap("nfl_schedule_strength")], viz: ["TIMELINE"] },
  { id: "schedule.fantasy_playoffs", title: "Fantasy playoff schedule", question: "What do the weeks that decide the fantasy season look like for this roster?", tags: ["schedule", "forward", "playoffs"], needs: [req("schedule_planning.team", { bind: "manager" })], viz: ["TIMELINE", "TABLE"] },
  { id: "injury.contingencies", title: "Injury contingencies", question: "If a teammate is unavailable, who inherits opportunity — and what if he is?", tags: ["injury", "contingency", "opportunity", "conditional"], needs: [req("opp.scenario", { bind: "own_team", scenario: true }), capE("injury_probability")], depends_on: ["team.competition"], viz: ["COMPARISON_BARS", "TABLE"] },

  /* ---------------------------------------------------------------- FANTASY DECISION */
  { id: "decision.projection_range", title: "Projection range", question: "What is the range of outcomes for this week?", tags: ["projection", "fantasy", "uncertainty"], needs: [cap("player_projection_distribution"), enr("startsit.shadow", { bind: "manager" })], depends_on: ["player.role.trajectory", "matchup.defensive_structure", "team.offensive_scheme"], viz: ["DISTRIBUTION"] },
  { id: "decision.floor_median_ceiling", title: "Floor / median / ceiling", question: "What are the floor, median and ceiling outcomes?", tags: ["projection", "fantasy", "uncertainty"], needs: [cap("player_projection_distribution")], viz: ["DISTRIBUTION"] },
  { id: "decision.roster_fit", title: "Roster fit", question: "What does this player do for the roster's needs and lineup?", tags: ["roster", "fantasy"], needs: [req("roster_health.team", { bind: "manager" }), enr("waiver2.actions", { bind: "manager" })], viz: ["TABLE"] },
  { id: "decision.replacement_value", title: "Replacement value", question: "How much better is he than the freely available alternative?", tags: ["replacement", "fantasy", "waiver"], needs: [req("waiver2.replacement", { bind: "manager" }), enr("waiver2.actions", { bind: "manager" }), enr("waiver.status", { bind: "manager" })], viz: ["COMPARISON_BARS"] },
  { id: "decision.market_value", title: "Market / trade value", question: "What is his trade-market value?", tags: ["market", "trade", "fantasy"], needs: [req("trade.evaluation", { bind: "manager" })], viz: ["TABLE"] },
  { id: "decision.risk_uncertainty", title: "Risk & uncertainty", question: "How confident is the evidence, and where is it thin or stale?", tags: ["risk", "uncertainty", "confidence"], needs: [req("role.player_profile"), req("fi.player_usage")], depends_on: ["player.role.playing_time", "player.role.target_opportunity", "player.performance.sustainability"], viz: ["TABLE"] },
  { id: "book.final_synthesis", title: "Final synthesis", question: "What do the researched chapters — and only those — support?", tags: ["synthesis"], needs: [], kind: "SYNTHESIS", viz: ["TABLE"] },

  /* ---------------------------------------------------------------- START/SIT (comparison) */
  { id: "compare.role_certainty", title: "Role certainty", question: "How certain is each player's role this week?", tags: ["role", "uncertainty", "comparison", "startsit"], needs: [req("role.player_profile", { comparisons: true }), req("role.role_change")], viz: ["COMPARISON_BARS", "TABLE"] },
  { id: "compare.evidence_scales", title: "Comparable evidence", question: "Are the players' evidence populations and scales actually comparable?", tags: ["comparison", "uncertainty"], needs: [req("role.player_profile", { comparisons: true }), req("fi.player_usage", { comparisons: true })], viz: ["TABLE"] },
  { id: "compare.game_environment", title: "Game environment", question: "What scoring environment does each player's game offer?", tags: ["environment", "comparison", "scoring"], needs: [req("fi.team_metric", { bind: "both_teams", params: { side: "offense" }, comparisons: true }), enr("matchup.shadow", { bind: "manager" }), capE("betting_lines")], viz: ["COMPARISON_BARS"] },
  { id: "startsit.shadow_view", title: "Shadow Start/Sit comparison", question: "What does the shadow Start/Sit model say about the alternatives?", tags: ["startsit", "shadow", "comparison"], needs: [req("startsit.shadow", { bind: "manager" })], viz: ["TABLE", "COMPARISON_BARS"] },
  { id: "startsit.historical_accuracy", title: "Historical Start/Sit accuracy", question: "How accurate has the Start/Sit model been?", tags: ["startsit", "history", "validation"], needs: [req("startsit.shadow", { bind: "manager", history: true })], viz: ["TIME_SERIES"] },
  { id: "compare.head_to_head", title: "Head-to-head evidence", question: "Side by side, where does each player win or lose?", tags: ["comparison"], needs: [req("role.player_profile", { comparisons: true }), req("fi.player_usage", { comparisons: true })], depends_on: ["compare.role_certainty", "player.role.playing_time"], viz: ["COMPARISON_BARS"] },

  /* ---------------------------------------------------------------- GAME / OFFENSE-V-DEFENSE */
  { id: "game.offensive_plan", title: "Offensive plan", question: "How does each offense want to attack?", tags: ["offense", "scheme", "tendencies", "game"], needs: [req("fi.team_metric", { bind: "both_teams", params: { side: "offense" }, history: true, comparisons: true }), enr("scheme.qb_formation", { bind: "team_qb" })], viz: ["PERCENTILE_BAR", "COMPARISON_BARS"] },
  { id: "game.defensive_plan", title: "Defensive plan", question: "How does each defense want to defend?", tags: ["defense", "scheme", "game"], needs: [req("fi.team_metric", { bind: "both_teams", params: { side: "defense" }, history: true, comparisons: true }), enr("scheme.defense_coverage", { bind: "both_teams" })], viz: ["PERCENTILE_BAR", "COMPARISON_BARS"] },
  { id: "game.personnel", title: "Personnel", question: "Which personnel groupings will each side use?", tags: ["personnel", "game"], needs: [cap("personnel_groupings")], viz: ["TABLE"] },
  { id: "game.fronts", title: "Fronts", question: "What fronts does each defense show?", tags: ["fronts", "defense", "game"], needs: [cap("defensive_front_alignment")], viz: ["TABLE"] },
  { id: "game.pressure", title: "Pressure", question: "Where does pressure win or lose the game?", tags: ["pressure", "line", "game"], needs: [req("fi.team_metric", { bind: "both_teams", params: { side: "defense", metrics: "def_pressure_rate,def_blitz_rate" }, comparisons: true }), req("fi.team_metric", { bind: "both_teams", params: { side: "offense", metrics: "off_pressure_rate_allowed,off_sack_rate_allowed" }, comparisons: true })], viz: ["COMPARISON_BARS"] },
  { id: "game.coverage", title: "Coverage", question: "How will coverage structures meet the passing games?", tags: ["coverage", "scheme", "game"], needs: [req("scheme.defense_coverage", { bind: "both_teams", comparisons: true })], viz: ["HEATMAP", "TABLE"] },
  { id: "game.offense_vs_defense.pass", title: "Pass offense vs pass defense", question: "How do the passing games match up in both directions?", tags: ["matchup", "game", "passing"], needs: [req("fi.team_metric", { bind: "both_teams", params: { metrics: "off_pass_epa,def_pass_epa_allowed,off_explosive_pass_rate,def_explosive_pass_rate_allowed" }, comparisons: true })], viz: ["COMPARISON_BARS"] },
  { id: "game.offense_vs_defense.rush", title: "Rush offense vs run defense", question: "How do the rushing games match up in both directions?", tags: ["matchup", "game", "rushing"], needs: [req("fi.team_metric", { bind: "both_teams", params: { metrics: "off_rush_epa,def_rush_epa_allowed,off_explosive_rush_rate,def_explosive_rush_rate_allowed" }, comparisons: true }), capE("run_fit_evidence")], viz: ["COMPARISON_BARS"] },
  { id: "game.adjustments", title: "Adjustments", question: "What in-game adjustments should be expected?", tags: ["adjustments", "game"], needs: [cap("in_game_adjustments")], viz: ["TIMELINE"] },
  { id: "game.line_play", title: "Line play", question: "Which trenches control the game?", tags: ["line", "game", "protection"], needs: [req("fi.team_metric", { bind: "both_teams", params: { metrics: "off_pressure_rate_allowed,off_sack_rate_allowed,def_pressure_rate" }, comparisons: true }), capE("ol_player_level_pass_block")], viz: ["COMPARISON_BARS"] },
  { id: "game.scoring_drives", title: "Scoring drives", question: "How do these offenses score — and how do they stall?", tags: ["scoring", "touchdowns", "game"], needs: [cap("drive_level_scoring_data"), enr("fi.team_metric", { bind: "both_teams", params: { metrics: "off_rz_td_rate,def_rz_td_rate_allowed" } })], viz: ["TIMELINE"] },
  { id: "game.repeatability", title: "Repeatability", question: "Which team strengths are repeatable and which are noise?", tags: ["repeatability", "uncertainty", "regression"], needs: [req("fi.team_metric", { bind: "both_teams", history: true, comparisons: true })], viz: ["TIME_SERIES"] },
  { id: "game.fantasy_implications", title: "Fantasy implications", question: "What does the game imply for the roster in question?", tags: ["fantasy", "game"], needs: [req("matchup.shadow", { bind: "manager" }), enr("startsit.shadow", { bind: "manager" })], depends_on: ["game.offense_vs_defense.pass"], viz: ["TABLE"] },

  /* ---------------------------------------------------------------- DEFENSE */
  { id: "defense.front", title: "Front", question: "What front structure does this defense use?", tags: ["fronts", "defense"], needs: [cap("defensive_front_alignment")], viz: ["TABLE"] },
  { id: "defense.pressure", title: "Pressure", question: "How often does this defense pressure the passer?", tags: ["pressure", "defense"], needs: [req("fi.team_metric", { bind: "own_team", params: { side: "defense", metrics: "def_pressure_rate" }, history: true, comparisons: true })], viz: ["TIME_SERIES", "PERCENTILE_BAR"] },
  { id: "defense.blitz", title: "Blitz", question: "How often and how effectively does it blitz?", tags: ["blitz", "pressure", "defense"], needs: [req("fi.team_metric", { bind: "own_team", params: { side: "defense", metrics: "def_blitz_rate" }, history: true, comparisons: true })], viz: ["TIME_SERIES", "PERCENTILE_BAR"] },
  { id: "defense.coverage", title: "Coverage", question: "What coverage families does it play?", tags: ["coverage", "defense", "scheme"], needs: [req("scheme.defense_coverage", { bind: "own_team", comparisons: true })], viz: ["TABLE", "HEATMAP"] },
  { id: "defense.man_zone", title: "Man vs zone", question: "How does it split man and zone?", tags: ["coverage", "man_zone", "defense"], needs: [req("scheme.defense_coverage", { bind: "own_team" })], viz: ["TABLE"] },
  { id: "defense.shell", title: "Coverage shell", question: "Which shells does it show?", tags: ["coverage", "shell", "defense"], needs: [req("scheme.defense_coverage", { bind: "own_team" })], viz: ["TABLE"] },
  { id: "defense.slot_boundary", title: "Slot / boundary", question: "How does it defend the slot versus the boundary?", tags: ["slot_boundary", "coverage", "defense"], needs: [cap("slot_boundary_alignment_data")], viz: ["TABLE"] },
  { id: "defense.run_fits", title: "Run fits", question: "How does it fit the run?", tags: ["run_defense", "defense"], needs: [cap("run_fit_evidence"), enr("fi.team_metric", { bind: "own_team", params: { side: "defense", metrics: "def_rush_epa_allowed,def_explosive_rush_rate_allowed" }, comparisons: true })], viz: ["TABLE"] },
  { id: "defense.personnel", title: "Personnel", question: "Which personnel does it defend best and worst?", tags: ["personnel", "defense"], needs: [cap("personnel_groupings")], viz: ["TABLE"] },
  { id: "defense.explosive_prevention", title: "Explosive-play prevention", question: "How well does it prevent explosive plays?", tags: ["explosiveness", "defense"], needs: [req("fi.team_metric", { bind: "own_team", params: { side: "defense", metrics: "def_explosive_pass_rate_allowed,def_explosive_rush_rate_allowed" }, history: true, comparisons: true })], viz: ["TIME_SERIES", "PERCENTILE_BAR"] },
  { id: "defense.fantasy_position_effects", title: "Fantasy-position effects", question: "Which fantasy positions does it help or hurt?", tags: ["fantasy", "defense", "matchup"], needs: [cap("defense_position_vulnerability")], viz: ["COMPARISON_BARS"] },
  { id: "defense.overall_strength", title: "Overall defensive strength", question: "How good is the defense overall, and is that stable?", tags: ["defense", "strength", "repeatability"], needs: [req("fi.team_metric", { bind: "own_team", params: { side: "defense" }, history: true, comparisons: true })], viz: ["PERCENTILE_BAR", "TIME_SERIES"] },

  /* ---------------------------------------------------------------- WAIVER */
  { id: "waiver.current_role", title: "Current role", question: "What role does the candidate actually have right now?", tags: ["role", "workload", "waiver"], needs: [req("role.player_profile", { comparisons: true }), enr("fi.player_usage", { comparisons: true })], viz: ["PERCENTILE_BAR", "TABLE"] },
  { id: "waiver.injury_opportunity", title: "Injury-created opportunity", question: "Is the opportunity created by someone else's absence, and how durable is it?", tags: ["injury", "opportunity", "conditional", "waiver"], needs: [req("opp.scenario", { bind: "own_team", scenario: true }), capE("injury_probability")], viz: ["COMPARISON_BARS"] },
  { id: "waiver.availability_faab", title: "Availability & FAAB", question: "What does the league's waiver state allow, and at what FAAB position?", tags: ["faab", "waiver", "fantasy"], needs: [req("waiver2.market", { bind: "manager" }), enr("waiver.status", { bind: "manager" })], viz: ["TABLE"] },
  { id: "waiver.manager_competition", title: "Manager competition", question: "Which other managers have a structural reason to pursue him?", tags: ["competition", "waiver", "managers"], needs: [req("waiver2.market", { bind: "manager" })], viz: ["TABLE"] },
  { id: "waiver.drop_cost", title: "Drop cost", question: "Who would be dropped, and what does that cost?", tags: ["waiver", "roster", "drop"], needs: [req("waiver2.actions", { bind: "manager" }), enr("roster_health.team", { bind: "manager" })], viz: ["TABLE"] },
  { id: "waiver.upside_uncertainty", title: "Upside & uncertainty", question: "What is the upside, and how uncertain is the role?", tags: ["uncertainty", "upside", "waiver"], needs: [req("role.player_profile"), req("fi.player_usage"), enr("waiver2.actions", { bind: "manager" })], depends_on: ["player.role.trajectory"], viz: ["TABLE"] },

  /* ---------------------------------------------------------------- TRADE */
  { id: "trade.player_value", title: "Player value", question: "What is the player worth in this league's trade market?", tags: ["market", "trade", "value"], needs: [req("trade.evaluation", { bind: "manager" })], viz: ["TABLE"] },
  { id: "trade.manager_incentives", title: "Manager incentives", question: "What does the counterparty need — and what will they accept?", tags: ["managers", "trade", "incentives"], needs: [cap("manager_incentive_evidence")], viz: ["TABLE"] },
  { id: "trade.positional_scarcity", title: "Positional scarcity", question: "How scarce is this position across the league?", tags: ["scarcity", "trade", "roster"], needs: [cap("positional_scarcity_evidence")], viz: ["DISTRIBUTION"] },
  { id: "trade.roster_impact", title: "Roster impact", question: "How does the trade change both rosters' strength and needs?", tags: ["roster", "trade", "fantasy"], needs: [req("roster_health.team", { bind: "manager" })], viz: ["TABLE"] },
  { id: "trade.risk", title: "Risk", question: "What could make this trade wrong?", tags: ["risk", "uncertainty", "trade"], needs: [req("role.player_profile"), req("fi.player_usage")], depends_on: ["player.role.trajectory"], viz: ["TABLE"] },

  /* ---------------------------------------------------------------- MANAGER / TEAM REVIEW */
  { id: "manager.roster_strength", title: "Roster strength", question: "How strong is the roster overall?", tags: ["roster", "strength", "manager"], needs: [req("roster_health.team", { bind: "manager" })], viz: ["TABLE"] },
  { id: "manager.position_rooms", title: "Position rooms", question: "Which position rooms are strong, thin or exposed?", tags: ["roster", "positions", "manager"], needs: [req("roster_health.team", { bind: "manager" })], viz: ["COMPARISON_BARS"] },
  { id: "manager.weekly_performance", title: "Weekly performance", question: "How has the team scored week to week?", tags: ["performance", "manager", "history"], needs: [cap("manager_weekly_results")], viz: ["TIME_SERIES"] },
  { id: "manager.startsit_decisions", title: "Start/sit decisions", question: "Were lineup decisions sound?", tags: ["startsit", "manager", "decisions"], needs: [req("startsit.shadow", { bind: "manager" })], viz: ["TABLE"] },
  { id: "manager.bench_decisions", title: "Bench decisions", question: "What did the bench cost or save?", tags: ["startsit", "manager", "bench"], needs: [req("startsit.shadow", { bind: "manager" })], viz: ["TABLE"] },
  { id: "manager.injuries", title: "Injuries", question: "How exposed is the roster to injuries and byes?", tags: ["injury", "manager", "roster"], needs: [req("roster_health.team", { bind: "manager" })], viz: ["TABLE"] },
  { id: "manager.waivers", title: "Waivers", question: "How has the team used the waiver wire, and what is available?", tags: ["waiver", "manager"], needs: [req("waiver.status", { bind: "manager" })], viz: ["TABLE"] },
  { id: "manager.trades", title: "Trades", question: "What have trades done to this roster?", tags: ["trade", "manager"], needs: [req("trade.evaluation", { bind: "manager" })], viz: ["TABLE"] },
  { id: "manager.schedule", title: "Schedule", question: "What does the remaining fantasy schedule look like?", tags: ["schedule", "manager", "forward"], needs: [req("schedule_planning.team", { bind: "manager" })], viz: ["TIMELINE"] },
  { id: "manager.future_outlook", title: "Future outlook", question: "What is the roster's outlook given its bye, lineup and injury structure?", tags: ["forward", "manager", "outlook"], needs: [req("schedule_planning.team", { bind: "manager" }), req("roster_health.team", { bind: "manager" })], depends_on: ["manager.schedule", "manager.roster_strength"], viz: ["TIMELINE"] },

  /* ---------------------------------------------------------------- WHY DID X HAPPEN */
  { id: "why.role_usage", title: "Role & usage in the event", question: "What role and usage did he have when it happened, versus his norm?", tags: ["role", "workload", "usage", "why"], needs: [req("role.player_profile", { history: true, comparisons: true }), req("fi.player_usage", { history: true })], viz: ["TIME_SERIES"] },
  { id: "why.alignment", title: "Alignment", question: "Where was he aligned?", tags: ["alignment", "slot_boundary", "why"], needs: [cap("slot_boundary_alignment_data")], viz: ["HEATMAP"] },
  { id: "why.matchup", title: "The matchup", question: "What did the opponent's defense look like against this kind of role?", tags: ["matchup", "defense", "why"], needs: [req("fi.team_metric", { bind: "opponent", params: { side: "defense" }, history: true, comparisons: true })], viz: ["PERCENTILE_BAR"] },
  { id: "why.coverage", title: "Coverage faced", question: "What coverage structure did he face?", tags: ["coverage", "why"], needs: [req("scheme.defense_coverage", { bind: "opponent" }), cap("receiver_scheme_profile", { positions: ["WR", "TE"] })], viz: ["HEATMAP"] },
  { id: "why.pressure", title: "Pressure & protection", question: "Did pressure change the passing game?", tags: ["pressure", "protection", "qb", "why"], needs: [req("fi.team_metric", { bind: "opponent", params: { side: "defense", metrics: "def_pressure_rate,def_blitz_rate" }, comparisons: true }), req("fi.team_metric", { bind: "own_team", params: { side: "offense", metrics: "off_pressure_rate_allowed,off_sack_rate_allowed" }, comparisons: true })], viz: ["COMPARISON_BARS"] },
  { id: "why.play_design", title: "Play design", question: "What did the play calling and design intend?", tags: ["play_design", "play_call_intent", "why"], needs: [cap("play_call_intent")], viz: ["TABLE"] },
  { id: "why.game_script", title: "Game script", question: "How did the game flow shape usage?", tags: ["game_script", "why"], needs: [cap("game_script_splits")], viz: ["TIMELINE"] },
  { id: "why.execution", title: "Execution", question: "Was the outcome execution or opportunity?", tags: ["execution", "efficiency", "why"], needs: [cap("player_efficiency_metrics"), enr("fi.player_usage", { history: true })], viz: ["SCATTER"] },
  { id: "why.historical_comparison", title: "Historical comparison", question: "Is this outcome unusual for him?", tags: ["history", "why", "comparison"], needs: [req("role.player_profile", { history: true }), req("fi.player_usage", { history: true })], viz: ["TIME_SERIES"] },
  { id: "why.repeatability", title: "Repeatability", question: "Will it repeat?", tags: ["repeatability", "regression", "uncertainty", "why"], needs: [req("fi.player_usage", { history: true, comparisons: true }), req("role.role_change")], depends_on: ["why.role_usage", "why.historical_comparison"], viz: ["TIME_SERIES"] },
];

export const CHAPTER_LIBRARY: Record<string, ChapterDef> = Object.fromEntries(defs.map((d) => [d.id, d]));
if (Object.keys(CHAPTER_LIBRARY).length !== defs.length) throw new Error("duplicate chapter id in library");

const FS = "book.final_synthesis";
export const TEMPLATES: Record<BookType, BookTemplate> = {
  PLAYER_ANALYSIS: { type: "PLAYER_ANALYSIS", title: "Player analysis", parts: [
    { id: "P1", title: "PLAYER & ROLE", chapters: ["player.background", "player.role.playing_time", "player.role.route_participation", "player.role.target_opportunity", "player.role.rushing_usage", "player.role.high_value_usage", "player.role.trajectory", "player.qb.progression", "player.qb.spatial_formation", "player.scheme.usage_profile"] },
    { id: "P2", title: "TEAM ENVIRONMENT", chapters: ["team.competition", "team.offensive_line", "team.offensive_scheme", "team.coaching_tendencies", "team.game_script", "team.red_zone_offense", "team.qb_interaction"] },
    { id: "P3", title: "PERFORMANCE", chapters: ["player.performance.efficiency", "player.performance.explosiveness", "player.performance.expected_vs_actual", "player.performance.sustainability"] },
    { id: "P4", title: "MATCHUP & FORWARD OUTLOOK", chapters: ["matchup.defensive_structure", "matchup.coverage_interaction", "matchup.pressure_protection", "matchup.cornerback_assignment", "matchup.red_zone_defense", "matchup.fantasy_view", "schedule.remaining", "schedule.fantasy_playoffs", "injury.contingencies"] },
    { id: "P5", title: "FANTASY DECISION", chapters: ["decision.projection_range", "decision.floor_median_ceiling", "decision.roster_fit", "decision.replacement_value", "decision.market_value", "decision.risk_uncertainty", FS] },
  ], coverage_expectations: ["role", "workload", "scheme", "matchup", "schedule", "projection", "roster", "touchdowns", "coverage", "pressure", "uncertainty", "injury"] },

  START_SIT_COMPARISON: { type: "START_SIT_COMPARISON", title: "Start/sit comparison", parts: [
    { id: "S1", title: "ROLE & OPPORTUNITY", chapters: ["compare.role_certainty", "player.role.playing_time", "player.role.route_participation", "player.role.target_opportunity", "player.role.rushing_usage", "player.role.trajectory"] },
    { id: "S2", title: "MATCHUP", chapters: ["matchup.defensive_structure", "matchup.coverage_interaction", "matchup.pressure_protection", "matchup.cornerback_assignment"] },
    { id: "S3", title: "SCORING OPPORTUNITY", chapters: ["player.role.high_value_usage", "team.red_zone_offense", "matchup.red_zone_defense", "compare.game_environment", "team.game_script"] },
    { id: "S4", title: "PROJECTION & UNCERTAINTY", chapters: ["decision.projection_range", "decision.floor_median_ceiling", "startsit.shadow_view", "startsit.historical_accuracy", "decision.risk_uncertainty", "injury.contingencies"] },
    { id: "S5", title: "COMPARATIVE EVIDENCE", chapters: ["compare.evidence_scales", "compare.head_to_head", "decision.roster_fit", FS] },
  ], coverage_expectations: ["role", "workload", "matchup", "coverage", "pressure", "scoring", "uncertainty", "startsit", "comparison", "roster"] },

  GAME_ANALYSIS: { type: "GAME_ANALYSIS", title: "Game analysis", parts: [
    { id: "G1", title: "OFFENSIVE PLANS", chapters: ["game.offensive_plan", "game.personnel", "game.line_play"] },
    { id: "G2", title: "DEFENSIVE PLANS", chapters: ["game.defensive_plan", "game.fronts", "game.pressure", "game.coverage"] },
    { id: "G3", title: "OFFENSE VS DEFENSE", chapters: ["game.offense_vs_defense.pass", "game.offense_vs_defense.rush", "game.adjustments"] },
    { id: "G4", title: "SCORING & REPEATABILITY", chapters: ["game.scoring_drives", "team.red_zone_offense", "game.repeatability"] },
    { id: "G5", title: "FANTASY IMPLICATIONS", chapters: ["game.fantasy_implications", FS] },
  ], coverage_expectations: ["offense", "defense", "personnel", "fronts", "pressure", "coverage", "matchup", "adjustments", "line", "scoring", "repeatability", "fantasy"] },

  DEFENSE_ANALYSIS: { type: "DEFENSE_ANALYSIS", title: "Defense analysis", parts: [
    { id: "D1", title: "STRUCTURE", chapters: ["defense.overall_strength", "defense.front", "defense.personnel", "defense.run_fits"] },
    { id: "D2", title: "PRESSURE", chapters: ["defense.pressure", "defense.blitz"] },
    { id: "D3", title: "COVERAGE", chapters: ["defense.coverage", "defense.man_zone", "defense.shell", "defense.slot_boundary"] },
    { id: "D4", title: "OUTCOMES", chapters: ["defense.explosive_prevention", "defense.fantasy_position_effects", FS] },
  ], coverage_expectations: ["fronts", "pressure", "blitz", "coverage", "man_zone", "shell", "slot_boundary", "run_defense", "personnel", "explosiveness", "fantasy"] },

  WAIVER_ANALYSIS: { type: "WAIVER_ANALYSIS", title: "Waiver analysis", parts: [
    { id: "W1", title: "ROLE & OPPORTUNITY", chapters: ["waiver.current_role", "player.role.trajectory", "waiver.injury_opportunity", "team.competition"] },
    { id: "W2", title: "OUTLOOK", chapters: ["schedule.fantasy_playoffs", "matchup.defensive_structure", "waiver.upside_uncertainty"] },
    { id: "W3", title: "FANTASY DECISION", chapters: ["decision.replacement_value", "decision.roster_fit", "waiver.availability_faab", "waiver.manager_competition", "waiver.drop_cost", FS] },
  ], coverage_expectations: ["role", "waiver", "opportunity", "schedule", "replacement", "roster", "faab", "competition", "drop", "uncertainty"] },

  TRADE_ANALYSIS: { type: "TRADE_ANALYSIS", title: "Trade analysis", parts: [
    { id: "T1", title: "PLAYER VALUE", chapters: ["trade.player_value", "decision.market_value", "player.role.trajectory", "player.role.playing_time", "schedule.fantasy_playoffs"] },
    { id: "T2", title: "ROSTER & MANAGER CONTEXT", chapters: ["trade.roster_impact", "decision.replacement_value", "trade.positional_scarcity", "trade.manager_incentives"] },
    { id: "T3", title: "RISK", chapters: ["trade.risk", "decision.risk_uncertainty", FS] },
  ], coverage_expectations: ["market", "role", "schedule", "roster", "replacement", "managers", "scarcity", "risk", "trade"] },

  MANAGER_REVIEW: { type: "MANAGER_REVIEW", title: "Manager / team review", parts: [
    { id: "M1", title: "ROSTER", chapters: ["manager.roster_strength", "manager.position_rooms", "manager.injuries"] },
    { id: "M2", title: "DECISIONS", chapters: ["manager.weekly_performance", "manager.startsit_decisions", "manager.bench_decisions", "manager.waivers", "manager.trades"] },
    { id: "M3", title: "FORWARD", chapters: ["manager.schedule", "manager.future_outlook", FS] },
  ], coverage_expectations: ["roster", "positions", "performance", "startsit", "bench", "injury", "waiver", "trade", "schedule", "outlook"] },

  WHY_ANALYSIS: { type: "WHY_ANALYSIS", title: "Why did it happen?", parts: [
    { id: "Y1", title: "WHAT HAPPENED", chapters: ["why.role_usage", "why.alignment", "why.execution"] },
    { id: "Y2", title: "THE OPPONENT", chapters: ["why.matchup", "why.coverage", "why.pressure"] },
    { id: "Y3", title: "CONTEXT", chapters: ["why.play_design", "why.game_script", "why.historical_comparison"] },
    { id: "Y4", title: "REPEATABILITY", chapters: ["why.repeatability", FS] },
  ], coverage_expectations: ["role", "usage", "alignment", "matchup", "coverage", "pressure", "play_design", "game_script", "execution", "history", "repeatability"] },

  PLAYER_VS_DEFENSE_GAME_ANALYSIS: { type: "PLAYER_VS_DEFENSE_GAME_ANALYSIS", title: "Player vs defense (game)", parts: [
    { id: "H1", title: "THE PLAYER'S ROLE", chapters: ["why.role_usage", "player.role.target_opportunity", "player.role.rushing_usage", "why.alignment"] },
    { id: "H2", title: "THE DEFENSE", chapters: ["defense.overall_strength", "defense.front", "defense.pressure", "defense.blitz", "defense.coverage", "defense.man_zone", "defense.shell", "defense.slot_boundary", "defense.run_fits"] },
    { id: "H3", title: "THE INTERACTION", chapters: ["matchup.coverage_interaction", "matchup.pressure_protection", "matchup.cornerback_assignment", "why.game_script", "why.play_design"] },
    { id: "H4", title: "EXECUTION & REPEATABILITY", chapters: ["why.execution", "why.historical_comparison", "why.repeatability", FS] },
  ], coverage_expectations: ["role", "usage", "alignment", "fronts", "pressure", "blitz", "coverage", "man_zone", "shell", "slot_boundary", "game_script", "execution", "repeatability", "matchup"] },
};

/** Every chapter a template references must exist (checked at import so a bad edit fails loudly, not at runtime). */
for (const t of Object.values(TEMPLATES)) for (const p of t.parts) for (const c of p.chapters) if (!CHAPTER_LIBRARY[c]) throw new Error(`template ${t.type} references unknown chapter ${c}`);
