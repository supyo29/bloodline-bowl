# W2.R1 S4 builder: team-game K and D/ST ACTUAL components (from nflverse pbp) + as-of features. Output cached under scripts/w2r1/cache (not committed).
# POINT-IN-TIME: every feature for game g uses only games strictly before g (schedule order); schedule lines/weather are pregame information.
suppressMessages({ library(nflreadr); library(data.table) })
seasons <- 2022:2025   # FINAL GUARD: 2026 is never loaded by the research builders (S7 loads it only after FROZEN.json)
pbp <- rbindlist(lapply(seasons, function(s) as.data.table(load_pbp(s))), fill = TRUE)[season_type == "REG"]
sch <- as.data.table(load_schedules(seasons))[game_type == "REG"]
pbp <- pbp[!is.na(posteam) | play_type %in% c("kickoff")]
BINS <- c(0, 20, 30, 40, 50, 60, 100); BL <- c("b0_19","b20_29","b30_39","b40_49","b50_59","b60p")
one <- function(x) as.integer(!is.na(x) & x == 1)
pbp[, `:=`(sk = one(sack), ic = one(interception), fl = one(fumble_lost), ff1 = one(fumble_forced), st = one(special_teams_play), td = one(touchdown))]

# ---- defense / ST components, credited to a team ----
mk <- function(dt, team, ...) { d <- dt[!is.na(team)]; d[, tm := team[!is.na(team)]]; d }
cred <- function(dt, teamcol, val, name) { d <- dt[!is.na(get(teamcol)) & val[!is.na(get(teamcol)) | TRUE][seq_len(.N)] != 0 | FALSE]; NULL }
agg <- function(dt, teamexpr, valexpr, name) {
  d <- dt[, .(game_id, season, week, team = eval(teamexpr), v = eval(valexpr))][!is.na(team) & !is.na(v) & v != 0]
  d[, .(v = sum(v)), by = .(game_id, team)][, setnames(.SD, "v", name)]
}
parts <- list(
  agg(pbp, quote(defteam), quote(sk), "sacks"),
  agg(pbp, quote(defteam), quote(ifelse(sk == 1, abs(yards_gained), 0)), "sack_yd"),
  agg(pbp, quote(defteam), quote(ic), "ints"),
  agg(pbp, quote(defteam), quote(ifelse(ic == 1, replace(return_yards, is.na(return_yards), 0), 0)), "int_ret_yd"),
  agg(pbp, quote(fumble_recovery_1_team), quote(ifelse(fl == 1 & st == 0, 1, 0)), "fumrec_def"),
  agg(pbp, quote(fumble_recovery_1_team), quote(ifelse(fl == 1 & st == 1, 1, 0)), "fumrec_st"),
  agg(pbp, quote(fumble_recovery_1_team), quote(ifelse(fl == 1, replace(fumble_recovery_1_yards, is.na(fumble_recovery_1_yards), 0), 0)), "fum_ret_yd"),
  agg(pbp, quote(ifelse(!is.na(fumbled_1_team) & fumbled_1_team == posteam, defteam, posteam)), quote(ifelse(st == 0, ff1, 0)), "ff_def"),
  agg(pbp, quote(ifelse(!is.na(fumbled_1_team) & fumbled_1_team == posteam, defteam, posteam)), quote(ifelse(st == 1, ff1, 0)), "ff_st"),
  agg(pbp, quote(defteam), quote(ifelse(!is.na(play_type) & play_type == "punt", 1, 0)), "forced_punts"),
  agg(pbp, quote(defteam), quote(ifelse(one(punt_attempt) == 1, 1, 0)), "forced_punts_pa"),
  agg(pbp, quote(return_team), quote(ifelse((one(punt_blocked) == 1 | (!is.na(field_goal_result) & field_goal_result == "blocked") | (!is.na(extra_point_result) & extra_point_result == "blocked")) & !is.na(return_yards), return_yards, 0)), "blk_ret_yd"),
  agg(pbp, quote(return_team), quote(ifelse(!is.na(field_goal_result) & field_goal_result %in% c("missed", "blocked") & !is.na(return_yards), return_yards, 0)), "fg_ret_yd"),
  agg(pbp, quote(defteam), quote(ifelse(td == 1 & !is.na(td_team) & td_team == defteam & st == 0 & (ic == 1 | fl == 1), 1, 0)), "def_td"),
  agg(pbp, quote(td_team), quote(ifelse(td == 1 & st == 1 & !is.na(td_team), 1, 0)), "st_td"),
  agg(pbp, quote(defteam), quote(one(safety)), "safeties"),
  agg(pbp, quote(defteam), quote(ifelse(one(punt_blocked) == 1 | (!is.na(field_goal_result) & field_goal_result == "blocked") | (!is.na(extra_point_result) & extra_point_result == "blocked"), 1, 0)), "blk"),
  agg(pbp, quote(defteam), quote(one(fourth_down_failed)), "stops4"),
  agg(pbp, quote(return_team), quote(ifelse(!is.na(play_type) & play_type == "kickoff", replace(return_yards, is.na(return_yards), 0), 0)), "kr_yd"),
  agg(pbp, quote(return_team), quote(ifelse(!is.na(play_type) & play_type == "punt", replace(return_yards, is.na(return_yards), 0), 0)), "pr_yd"),
  agg(pbp, quote(defteam), quote(ifelse(one(two_point_attempt) == 1 & one(defensive_two_point_conv) == 1, 1, 0)), "def2pt"),
  # offense side (for opponent features) credited to posteam
  agg(pbp, quote(posteam), quote(sk), "sacks_suffered"),
  agg(pbp, quote(posteam), quote(one(qb_dropback)), "dropbacks"),
  agg(pbp, quote(posteam), quote(ic), "ints_thrown"),
  agg(pbp, quote(posteam), quote(ifelse(fl == 1 & st == 0, 1, 0)), "fumlost_off")
)
# points scored by the OFFENSE (what a defense "allows"): TD on offense plays, FG, XP, 2pt
pbp[, off_pts := fifelse(td == 1 & play_type %in% c("pass", "run") & !is.na(td_team) & td_team == posteam, 6, 0) +
      fifelse(!is.na(field_goal_result) & field_goal_result == "made", 3, 0) +
      fifelse(!is.na(extra_point_result) & extra_point_result == "good", 1, 0) +
      fifelse(!is.na(two_point_conv_result) & two_point_conv_result == "success", 2, 0)]
pa <- pbp[!is.na(posteam), .(pts_scored_off = sum(off_pts)), by = .(game_id, team = posteam)]
parts <- c(parts, list(pa))
# ---- K components by distance bin ----
fg <- pbp[one(field_goal_attempt) == 1 & !is.na(posteam)]
fg[, `:=`(bin = cut(kick_distance, BINS, labels = BL, right = FALSE, include.lowest = TRUE), made = as.integer(field_goal_result == "made"))]
kb <- fg[!is.na(bin), .(att = .N, made = sum(made)), by = .(game_id, team = posteam, bin)]
kbw <- dcast(kb, game_id + team ~ bin, value.var = c("att", "made"), fill = 0, sep = "_")
xp <- pbp[one(extra_point_attempt) == 1 & !is.na(posteam), .(xp_att = .N, xp_made = sum(extra_point_result == "good")), by = .(game_id, team = posteam)]
kicker <- fg[, .(kicker = names(which.max(table(kicker_player_id)))), by = .(game_id, team = posteam)]
# ---- assemble team-game base from the schedule ----
g <- rbindlist(list(sch[, .(game_id, season, week, team = home_team, opp = away_team, home = 1L, gameday)], sch[, .(game_id, season, week, team = away_team, opp = home_team, home = 0L, gameday)]))
sw <- sch[, .(game_id, total_line, spread_line, roof, temp, wind, result)]
g <- merge(g, sw, by = "game_id", all.x = TRUE)
g[, `:=`(implied_team_total = fifelse(home == 1, (total_line + spread_line) / 2, (total_line - spread_line) / 2), team_spread = fifelse(home == 1, -spread_line, spread_line), dome = as.integer(roof %in% c("dome", "closed")))]
g[, `:=`(wind15 = as.integer(!is.na(wind) & wind >= 15 & dome == 0), cold = as.integer(!is.na(temp) & temp < 40 & dome == 0))]
for (p in parts) g <- merge(g, p, by = c("game_id", "team"), all.x = TRUE)
g <- merge(g, kbw, by = c("game_id", "team"), all.x = TRUE); g <- merge(g, xp, by = c("game_id", "team"), all.x = TRUE); g <- merge(g, kicker, by = c("game_id", "team"), all.x = TRUE)
g[, played := !is.na(result)]
g <- g[played == TRUE]
for (cn in setdiff(names(g), c("game_id","team","opp","season","week","gameday","roof","kicker","total_line","spread_line","temp","wind","result","implied_team_total","team_spread","dome","wind15","cold","home","played"))) set(g, which(is.na(g[[cn]])), cn, 0)
setorder(g, team, season, week)
fwrite(g, "scripts/w2r1/cache/s4_team_game.csv")
fwrite(fg[!is.na(bin), .(game_id, season, week, team = posteam, kicker = kicker_player_id, dist = kick_distance, bin = as.character(bin), made, wind = wind, temp = temp, roof = roof)], "scripts/w2r1/cache/s4_fg_attempts.csv")
cat("team-games:", nrow(g), " by season: ", paste(names(table(g$season)), table(g$season), collapse = " "), "\n")
cat("2026 weeks:", paste(sort(unique(g[season == 2026]$week)), collapse = ","), "\n")
cat("FG attempts:", nrow(fg), "\n")
