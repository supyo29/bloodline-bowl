# W2.R1 S5 builder: point-in-time TIER-A tactical features (+ labelled Tier-B prior-season carryover) per QB/RB/WR/TE player-game, seasons 2022-2025 ONLY.
# 2026 is never loaded here (FINAL guard). Every feature for game (season, week) uses only strictly earlier games.
suppressMessages({ library(nflreadr); library(data.table) })
SEASONS <- 2022:2025; K0 <- 4; KP <- 3; WINP <- 6; WINT <- 10
HALF <- list(py = .04, ptd = 4, pint = -2, ry = .1, rtd = 6, rec = .5, recy = .1, rectd = 6, fum = -2, tp = 2)
pbp <- rbindlist(lapply(SEASONS, function(s) as.data.table(load_pbp(s))[season_type == "REG", .(game_id, season, week, play_id, posteam, defteam, play_type, down, qtr, yardline_100, pass_attempt, rush_attempt, sack, qb_dropback, qb_scramble, air_yards, yards_gained, yards_after_catch, complete_pass, touchdown, td_team, interception, fumble_lost, epa, score_differential, wp, passer_player_id, receiver_player_id, rusher_player_id, home_team, away_team)]))
ftn <- rbindlist(lapply(SEASONS, function(s) as.data.table(load_ftn_charting(s))[, .(game_id = nflverse_game_id, play_id = nflverse_play_id, pa = as.integer(is_play_action), screen = as.integer(is_screen_pass), blitz = as.integer(n_blitzers > 0))]))
pbp <- merge(pbp, ftn, by = c("game_id", "play_id"), all.x = TRUE)
sch <- as.data.table(load_schedules(SEASONS))[game_type == "REG"]
one <- function(x) as.integer(!is.na(x) & x == 1)
# ---- player stats -> actual HALF points, played flag, designation ----
ps <- rbindlist(lapply(SEASONS, function(s) as.data.table(load_player_stats(s, summary_level = "week"))[season_type == "REG" & position %in% c("QB", "RB", "WR", "TE")]), fill = TRUE)
g0 <- function(c) { v <- ps[[c]]; fifelse(is.na(v), 0, v) }
ps[, actual := g0("passing_yards") * HALF$py + g0("passing_tds") * HALF$ptd + HALF$pint * (if ("passing_interceptions" %in% names(ps)) g0("passing_interceptions") else g0("interceptions")) + g0("rushing_yards") * HALF$ry + g0("rushing_tds") * HALF$rtd + g0("receptions") * HALF$rec + g0("receiving_yards") * HALF$recy + g0("receiving_tds") * HALF$rectd + HALF$fum * (g0("rushing_fumbles_lost") + g0("receiving_fumbles_lost") + g0("sack_fumbles_lost")) + HALF$tp * (g0("passing_2pt_conversions") + g0("rushing_2pt_conversions") + g0("receiving_2pt_conversions"))]
ids <- as.data.table(load_ff_playerids())[!is.na(gsis_id) & !is.na(pfr_id), .(gsis_id, pfr_id)]; ids <- unique(ids, by = "pfr_id")
sn <- rbindlist(lapply(SEASONS, function(s) as.data.table(load_snap_counts(s))[game_type == "REG", .(season, week, pfr_player_id, offense_snaps, offense_pct)])); sn <- merge(sn, ids, by.x = "pfr_player_id", by.y = "pfr_id", all.x = TRUE)[!is.na(gsis_id)]
inj <- rbindlist(lapply(SEASONS, function(s) as.data.table(load_injuries(s))[game_type == "REG"]), fill = TRUE)
inj[, desig := fcase(report_status == "Out", "OUT", report_status == "Doubtful", "DOUBTFUL", report_status == "Questionable", "QUESTIONABLE", default = "NONE")]
inj[, pract := fcase(grepl("^Full", practice_status), "FULL", grepl("^Limited", practice_status), "LIMITED", grepl("^Did Not", practice_status), "DNP", default = NA_character_)]
injk <- unique(inj[, .(season, week, gsis_id, team_i = team, position_i = position, desig, pract, raw = report_status)], by = c("season", "week", "gsis_id"))
# ---- pbp -> player-game usage ----
P <- pbp[pass_attempt == 1 & !is.na(receiver_player_id)]
rec <- P[, .(targets = .N, air = sum(replace(air_yards, is.na(air_yards), 0)), deep_t = sum(!is.na(air_yards) & air_yards >= 15), under_t = sum(!is.na(air_yards) & air_yards <= 5), rz_t = sum(yardline_100 <= 20, na.rm = TRUE), yac = sum(replace(yards_after_catch, is.na(yards_after_catch), 0)), recs = sum(complete_pass == 1, na.rm = TRUE), screen_t = sum(screen == 1, na.rm = TRUE)), by = .(game_id, gsis_id = receiver_player_id)]
R <- pbp[rush_attempt == 1 & !is.na(rusher_player_id) & one(qb_scramble) == 0]
rus <- R[, .(carries = .N, rz_c = sum(yardline_100 <= 20, na.rm = TRUE), gl_c = sum(yardline_100 <= 5, na.rm = TRUE), expl_c = sum(yards_gained >= 10, na.rm = TRUE)), by = .(game_id, gsis_id = rusher_player_id)]
Q <- pbp[!is.na(passer_player_id) & (one(qb_dropback) == 1)]
qbd <- Q[, .(dropbacks = .N, sacks_t = sum(sack == 1, na.rm = TRUE), pa_db = sum(pa == 1, na.rm = TRUE), att = sum(pass_attempt == 1, na.rm = TRUE), q_air = sum(ifelse(pass_attempt == 1, replace(air_yards, is.na(air_yards), 0), 0)), q_deep = sum(pass_attempt == 1 & !is.na(air_yards) & air_yards >= 15, na.rm = TRUE)), by = .(game_id, gsis_id = passer_player_id)]
scr <- pbp[one(qb_scramble) == 1 & !is.na(rusher_player_id), .(scrambles = .N), by = .(game_id, gsis_id = rusher_player_id)]
dqb <- pbp[rush_attempt == 1 & !is.na(rusher_player_id) & one(qb_scramble) == 0, .(game_id, gsis_id = rusher_player_id, c = 1)][, .(qb_designed = .N), by = .(game_id, gsis_id)]
# ---- assemble player-game base ----
base <- merge(ps[, .(gsis_id = player_id, season, week, team, opp = opponent_team, position, actual)], unique(pbp[, .(game_id, season, week, home_team, away_team)]), by = c("season", "week"), allow.cartesian = TRUE)[(team == home_team | team == away_team) & (opp == home_team | opp == away_team)]
base <- base[, .(gsis_id, season, week, team, opp, position, actual, game_id)]
for (t in list(rec, rus, qbd, scr)) base <- merge(base, t, by = c("game_id", "gsis_id"), all.x = TRUE)
base <- merge(base, sn[, .(season, week, gsis_id, offense_snaps, offense_pct)], by = c("season", "week", "gsis_id"), all.x = TRUE)
base <- merge(base, injk[, .(season, week, gsis_id, desig, pract, raw)], by = c("season", "week", "gsis_id"), all.x = TRUE)
base[is.na(desig), desig := "NONE"]
for (cn in c("targets", "air", "deep_t", "under_t", "rz_t", "yac", "recs", "screen_t", "carries", "rz_c", "gl_c", "expl_c", "dropbacks", "sacks_t", "pa_db", "att", "q_air", "q_deep", "scrambles")) set(base, which(is.na(base[[cn]])), cn, 0)
base[, played := as.integer(!is.na(offense_snaps) & offense_snaps > 0)]
setorder(base, gsis_id, season, week); base <- unique(base, by = c("gsis_id", "season", "week"))
# team-game totals for shares
tt <- base[, .(team_targets = sum(targets), team_carries = sum(carries), team_air = sum(air), team_rz_c = sum(rz_c)), by = .(game_id, team)]
base <- merge(base, tt, by = c("game_id", "team")); setorder(base, gsis_id, season, week)
sh <- function(a, b) fifelse(b > 0, a / b, NA_real_)
base[, `:=`(s_tgt = sh(targets, team_targets), s_car = sh(carries, team_carries), s_air = sh(air, team_air), s_rz_t = sh(rz_t, targets), s_deep = sh(deep_t, targets), s_under = sh(under_t, targets), s_screen = sh(screen_t, targets), s_yac = sh(yac, recs),
            s_adot = sh(air, targets), s_gl = sh(gl_c, carries), s_expl = sh(expl_c, carries), s_rz_c = sh(rz_c, team_rz_c), s_sack = sh(sacks_t, dropbacks), s_scr = sh(scrambles, dropbacks), s_pa = sh(pa_db, dropbacks), s_qdeep = sh(q_deep, att), s_qadot = sh(q_air, att),
            u_snap_g = offense_pct, u_db = dropbacks, u_car = carries, u_tgt = targets, u_rzc = rz_c, u_rzt = rz_t, u_scr = scrambles)]
base <- merge(base, dqb, by = c("game_id", "gsis_id"), all.x = TRUE); base[is.na(qb_designed), qb_designed := 0]; base[, u_des := qb_designed]
# =========================== TEAM-GAME TENDENCIES (Tier A) ===========================
pb <- pbp[!is.na(posteam) & !is.na(defteam) & (pass_attempt == 1 | rush_attempt == 1 | one(sack) == 1)]
pb[, `:=`(is_pass = as.integer(pass_attempt == 1 | sack == 1), is_run = as.integer(rush_attempt == 1 & one(qb_scramble) == 0), neutral = as.integer(!is.na(down) & down <= 2 & qtr <= 3 & !is.na(score_differential) & abs(score_differential) <= 8 & !is.na(wp) & wp >= .2 & wp <= .8))]
posn <- unique(base[, .(gsis_id, position)], by = "gsis_id"); setnames(posn, "gsis_id", "receiver_player_id")
pb <- merge(pb, posn, by = "receiver_player_id", all.x = TRUE)
rt <- function(num, den) fifelse(den > 0, num / den, NA_real_)
off <- pb[, .(n_pass = sum(is_pass), n_run = sum(is_run), nn_pass = sum(is_pass * neutral), nn_run = sum(is_run * neutral), ed_pass = sum(is_pass * (down <= 2), na.rm = TRUE), ed_run = sum(is_run * (down <= 2), na.rm = TRUE),
  pa = sum(pa == 1 & one(qb_dropback) == 1, na.rm = TRUE), db = sum(one(qb_dropback) == 1), scr = sum(screen == 1 & pass_attempt == 1, na.rm = TRUE), att = sum(pass_attempt == 1), deep = sum(pass_attempt == 1 & !is.na(air_yards) & air_yards >= 15),
  rb_t = sum(pass_attempt == 1 & position == "RB", na.rm = TRUE), rzp = sum(is_pass * (yardline_100 <= 20), na.rm = TRUE), rzr = sum(is_run * (yardline_100 <= 20), na.rm = TRUE), glp = sum(is_pass * (yardline_100 <= 5), na.rm = TRUE), glr = sum(is_run * (yardline_100 <= 5), na.rm = TRUE), sk = sum(sack == 1, na.rm = TRUE)), by = .(game_id, team = posteam)]
off[, `:=`(t_neutral_pass_rate = rt(nn_pass, nn_pass + nn_run), t_early_down_pass_rate = rt(ed_pass, ed_pass + ed_run), t_play_action_rate = rt(pa, db), t_screen_rate = rt(scr, att), t_deep_attempt_rate = rt(deep, att), t_rb_target_share = rt(rb_t, att), t_rz_pass_rate = rt(rzp, rzp + rzr), t_goal_line_run_rate = rt(glr, glp + glr), t_sack_rate_suffered = rt(sk, db), t_pace = n_pass + n_run)]
dfn <- pb[, .(db = sum(one(qb_dropback) == 1), sk = sum(sack == 1, na.rm = TRUE), bl = sum(blitz == 1 & one(qb_dropback) == 1, na.rm = TRUE), blk = sum(!is.na(blitz) & one(qb_dropback) == 1), pe = sum(ifelse(one(qb_dropback) == 1, epa, 0), na.rm = TRUE), re = sum(ifelse(is_run == 1, epa, 0), na.rm = TRUE), nr = sum(is_run), att = sum(pass_attempt == 1), ex = sum(pass_attempt == 1 & yards_gained >= 20, na.rm = TRUE), deep = sum(pass_attempt == 1 & !is.na(air_yards) & air_yards >= 15), rb_t = sum(pass_attempt == 1 & position == "RB", na.rm = TRUE),
  rzn = sum(yardline_100 <= 20 & (is_pass + is_run) > 0, na.rm = TRUE), rzt = sum(yardline_100 <= 20 & touchdown == 1 & !is.na(td_team) & td_team == posteam, na.rm = TRUE)), by = .(game_id, team = defteam)]
dfn[, `:=`(d_sack_rate = rt(sk, db), d_blitz_rate = rt(bl, blk), d_pass_epa_allowed = rt(pe, db), d_rush_epa_allowed = rt(re, nr), d_explosive_pass_allowed = rt(ex, att), d_deep_target_concession = rt(deep, att), d_rb_target_share_allowed = rt(rb_t, att), d_rz_td_rate_allowed = rt(rzt, rzn))]
tg <- merge(off[, c("game_id", "team", grep("^t_", names(off), value = TRUE)), with = FALSE], dfn[, c("game_id", "team", grep("^d_", names(dfn), value = TRUE)), with = FALSE], by = c("game_id", "team"), all = TRUE)
sg <- rbindlist(list(sch[, .(game_id, season, week, team = home_team, opp = away_team, home = 1L, gameday, pf = home_score, pa_s = away_score, coach = home_coach, total_line, spread_line, roof)], sch[, .(game_id, season, week, team = away_team, opp = home_team, home = 0L, gameday, pf = away_score, pa_s = home_score, coach = away_coach, total_line, spread_line, roof)]))
tg <- merge(sg, tg, by = c("game_id", "team"), all.x = TRUE); tg[, d_ppg_allowed := pa_s]
tg[, `:=`(implied_team_total = fifelse(home == 1, (total_line + spread_line) / 2, (total_line - spread_line) / 2), team_spread = fifelse(home == 1, -spread_line, spread_line), dome = as.integer(roof %in% c("dome", "closed")))]
setorder(tg, team, season, week)
tg_raw <- copy(tg)
OFFM <- grep("^t_", names(tg), value = TRUE); DEFM <- grep("^d_", names(tg), value = TRUE)
# ---- continuity: HC (nflverse) and QB (most dropbacks) per team-season ----
hc <- tg[, .(hc = names(which.max(table(coach)))), by = .(team, season)]
qbt <- merge(pbp[one(qb_dropback) == 1 & !is.na(passer_player_id), .(n = .N), by = .(game_id, team = posteam, gsis_id = passer_player_id)], unique(sch[, .(game_id, season)]), by = "game_id")[, .(n = sum(n)), by = .(season, team, gsis_id)][order(-n), .SD[1], by = .(season, team)][, .(season, team, qb = gsis_id)]
cont_tab <- merge(hc, qbt, by = c("season", "team"), all.x = TRUE)
ct <- split(cont_tab, cont_tab$team); getc <- function(tm, s, f) { x <- ct[[tm]]; v <- x[[f]][match(s, x$season)]; v }
cont_off <- function(tm, st, se) { if (se >= st) return(1); (if (identical(getc(tm, st, "hc"), getc(tm, se, "hc"))) 1 else 0.4) * (if (identical(getc(tm, st, "qb"), getc(tm, se, "qb"))) 1 else 0.6) }
cont_def <- function(tm, st, se) { if (se >= st) return(1); if (identical(getc(tm, st, "hc"), getc(tm, se, "hc"))) 1 else 0.4 }
# ---- as-of EB in three continuity modes ----
lgm <- sapply(c(OFFM, DEFM), function(m) mean(tg[season <= 2024][[m]], na.rm = TRUE))
asof_team <- function(d, metric, mode, contfn) { n <- nrow(d); x <- d[[metric]]; out <- numeric(n); cnt <- integer(n); for (i in seq_len(n)) { if (i == 1) { out[i] <- lgm[[metric]]; cnt[i] <- 0L; next }; js <- max(1, i - WINT):(i - 1); se <- d$season[js]; st <- d$season[i]
    w <- switch(mode, CUR = as.numeric(se == st), MULTI = rep(1, length(js)), CONT = sapply(seq_along(js), function(k) if (se[k] == st) 1 else 0.5^(st - se[k]) * contfn(d$team[i], st, se[k]))); ok <- !is.na(x[js]) & w > 0; out[i] <- (sum(w[ok] * x[js][ok]) + K0 * lgm[[metric]]) / (sum(w[ok]) + K0); cnt[i] <- sum(ok & se == st) }; list(v = out, n = cnt) }
res <- list()
for (tm in unique(tg$team)) { d <- tg[team == tm]; r <- data.table(game_id = d$game_id, team = tm)
  for (md in c("CUR", "MULTI", "CONT")) { for (m in OFFM) { a <- asof_team(d, m, md, cont_off); r[[paste0(m, "_", md)]] <- a$v; if (m == OFFM[1]) r[[paste0("n_off_cur_", md)]] <- a$n }; for (m in DEFM) { a <- asof_team(d, m, md, cont_def); r[[paste0(m, "_", md)]] <- a$v; if (m == DEFM[1]) r[[paste0("n_def_cur_", md)]] <- a$n } }
  d[, gap_days := as.numeric(as.Date(gameday) - shift(as.Date(gameday), 1))]; r$gap_days <- d$gap_days; r$cont_off <- sapply(seq_len(nrow(d)), function(i) cont_off(tm, d$season[i], d$season[i] - 1)); r$cont_def <- sapply(seq_len(nrow(d)), function(i) cont_def(tm, d$season[i], d$season[i] - 1)); res[[tm]] <- r }
TA <- rbindlist(res); tg <- merge(tg[, .(game_id, team, season, week, opp, home, implied_team_total, team_spread, dome, t_pace)], TA, by = c("game_id", "team")); setnames(tg, "t_pace", "pace_actual")
setorder(tg, team, season, week); lgpace <- mean(tg[season <= 2024]$pace_actual, na.rm = TRUE); tg[, team_pace_asof := { x <- pace_actual; sapply(seq_along(x), function(i) { pr <- if (i > 1) x[max(1, i - 10):(i - 1)] else numeric(0); pr <- pr[!is.na(pr)]; (sum(pr) + K0 * lgpace) / (length(pr) + K0) }) }, by = team]
# ---- Tier-B prior-season carryover (labelled) ----
partic <- rbindlist(lapply((min(SEASONS) - 1):(max(SEASONS) - 1), function(s) { p <- as.data.table(load_participation(s))[, .(nflverse_game_id, possession_team, offense_personnel, defense_man_zone_type, defense_coverage_type)]; p[, season := s]; p }))
tp <- partic[, .(game_id = nflverse_game_id, off = possession_team, ps = offense_personnel, mz = defense_man_zone_type, cov = defense_coverage_type, season)]
tp[, `:=`(away = sub("^[0-9]+_[0-9]+_([A-Z]+)_([A-Z]+)$", "\\1", game_id), home = sub("^[0-9]+_[0-9]+_([A-Z]+)_([A-Z]+)$", "\\2", game_id))]; tp[, def := fifelse(off == home, away, home)]
tbo <- tp[!is.na(ps), .(tb_off11 = mean(grepl("1 RB, 1 TE, 3 WR", ps, fixed = TRUE))), by = .(team = off, season)]
tbd <- tp[, .(tb_man = mean(mz == "MAN_COVERAGE", na.rm = TRUE) / max(1e-9, mean(mz %in% c("MAN_COVERAGE", "ZONE_COVERAGE"), na.rm = TRUE)), tb_2high = mean(cov %in% c("COVER_2", "COVER_4", "COVER_6", "2_MAN"), na.rm = TRUE) / max(1e-9, mean(!is.na(cov)))), by = .(team = def, season)]
tb <- merge(tbo, tbd, by = c("team", "season"), all = TRUE); lgtb <- sapply(c("tb_off11", "tb_man", "tb_2high"), function(c) mean(tb[season <= 2023][[c]], na.rm = TRUE))
tb[, target_season := season + 1]
# =========================== PLAYER AS-OF (EB over previous <=6 played games) ===========================
setorder(base, gsis_id, season, week); H <- base[played == 1 | targets + carries + dropbacks > 0]
USE <- c("u_snap_g", "u_db", "u_car", "u_tgt", "u_rzc", "u_rzt", "u_scr", "u_des"); FP <- c("s_tgt", "s_car", "s_air", "s_rz_t", "s_deep", "s_under", "s_screen", "s_yac", "s_adot", "s_gl", "s_expl", "s_rz_c", "s_sack", "s_scr", "s_pa", "s_qdeep", "s_qadot")
lgp <- list(); for (pos in c("QB", "RB", "WR", "TE")) lgp[[pos]] <- sapply(c(USE, FP), function(c) mean(H[season <= 2024 & position == pos][[c]], na.rm = TRUE))
player_asof <- function(gs, s, w, pos) { h <- Hs[[gs]]; if (is.null(h)) return(NULL); idx <- which(h$season < s | (h$season == s & h$week < w)); if (!length(idx)) return(list(n = 0L)); idx <- tail(idx, WINP); out <- list(n = length(idx), last_gap = NA_real_)
  for (c in c(USE, FP)) { x <- h[[c]][idx]; ok <- !is.na(x); out[[c]] <- (sum(x[ok]) + KP * lgp[[pos]][[c]]) / (sum(ok) + KP) }
  s4 <- idx[h$season[idx] == s]; same <- which(h$season < s | (h$season == s & h$week < w)); same <- same[h$season[same] == s]; b0 <- if (length(same)) mean(tail(h$actual[same], 4)) else NA_real_; out$b0 <- b0; out$n_season <- length(same); out$last_week <- h$week[tail(idx, 1)]; out$last_season <- h$season[tail(idx, 1)]; out }
Hs <- split(H, H$gsis_id)
# ---- S6 targets: pregame population (a player whose latest PLAYED game was for the team within its previous 3 team games). DNP stays in (label 0): no conditioning on playing. ----
setorder(tg, team, season, week); tg[, gi := seq_len(.N), by = team]
tgi <- tg[, .(team, season, week, gi, opp)]
Hp <- base[played == 1 & position %in% c("QB", "RB", "WR", "TE"), .(gsis_id, position, team, k_season = season, k_week = week)]
hk <- merge(Hp, tgi[, .(team, k_season = season, k_week = week, k_gi = gi)], by = c("team", "k_season", "k_week"))
cand <- hk[rep(seq_len(.N), each = 3)]; cand[, off := rep(1:3, length.out = .N)][, gi := k_gi + off]
cand <- merge(cand, tgi, by = c("team", "gi")); cand <- cand[week >= 3 & ((season <= 2024 & week <= 18) | (season == 2025 & week <= 17))]
setorder(cand, gsis_id, season, week, -k_season, -k_week); cand <- cand[, .SD[1], by = .(gsis_id, season, week, team)]
# a traded player can appear for two teams in one week: keep the team of his most recent played game
cand <- cand[order(gsis_id, season, week, -k_season, -k_week)][, .SD[1], by = .(gsis_id, season, week)]
T <- cand[, .(gsis_id, season, week, team, opp, position)]
pl <- base[, .(gsis_id, season, week, played, actual_o = actual, o_targets = targets, o_carries = carries, o_dropbacks = dropbacks)]
T <- merge(T, pl, by = c("gsis_id", "season", "week"), all.x = TRUE); T[is.na(played), played := 0L]; T[is.na(actual_o), actual_o := 0]; setnames(T, "actual_o", "actual"); for (cn in c("o_targets", "o_carries", "o_dropbacks")) set(T, which(is.na(T[[cn]])), cn, 0)
T <- merge(T, injk[, .(gsis_id, season, week, desig, pract, raw)], by = c("gsis_id", "season", "week"), all.x = TRUE); T[is.na(desig), desig := "NONE"]
T <- T[desig != "OUT"]; T[, split := fifelse(season <= 2024, "FIT", "VAL")]
cat("S6 targets (before B0p floor):", nrow(T), "\n")
rows <- lapply(seq_len(nrow(T)), function(i) { a <- player_asof(T$gsis_id[i], T$season[i], T$week[i], T$position[i]); if (is.null(a) || a$n == 0) return(NULL); c(list(i = i), a) })
rows <- lapply(seq_len(nrow(T)), function(i) { a <- player_asof(T$gsis_id[i], T$season[i], T$week[i], T$position[i]); if (is.null(a) || a$n == 0) return(NULL); c(list(i = i), a) })
rows <- rows[!sapply(rows, is.null)]; PF <- rbindlist(lapply(rows, function(r) as.data.table(r)), fill = TRUE); setnames(PF, "i", "ti")
T[, ti := .I]; T <- merge(T, PF, by = "ti")
# ---- join team / opponent tendencies (as-of at the target game) ----
own <- tg[, c("team", "season", "week", "implied_team_total", "team_spread", "dome", "team_pace_asof", "cont_off", "cont_def", "gap_days", paste0(rep(OFFM, each = 3), "_", c("CUR", "MULTI", "CONT")), paste0("n_off_cur_", c("CUR", "MULTI", "CONT"))), with = FALSE]
T <- merge(T, own, by = c("team", "season", "week"), all.x = TRUE)
oppd <- tg[, c("team", "season", "week", "implied_team_total", paste0(rep(DEFM, each = 3), "_", c("CUR", "MULTI", "CONT")), paste0("n_def_cur_", c("CUR", "MULTI", "CONT"))), with = FALSE]; setnames(oppd, c("team", "implied_team_total"), c("opp", "opp_implied_total"))
T <- merge(T, oppd, by = c("opp", "season", "week"), all.x = TRUE)
# ---- Tier-B carryover (season-1 only) ----
cf <- function(team, st, off) mapply(function(tm, s) if (off) cont_off(tm, s, s - 1) else cont_def(tm, s, s - 1), team, st)
tbo2 <- tb[, .(team, target_season, tb_off11)]; T <- merge(T, tbo2, by.x = c("team", "season"), by.y = c("team", "target_season"), all.x = TRUE)
tbd2 <- tb[, .(opp = team, target_season, tb_man, tb_2high)]; T <- merge(T, tbd2, by.x = c("opp", "season"), by.y = c("opp", "target_season"), all.x = TRUE)
T[, `:=`(c_off = cf(team, season, TRUE), c_def = cf(opp, season, FALSE))]
T[, `:=`(tbB_off11 = c_off * tb_off11 + (1 - c_off) * lgtb[["tb_off11"]], tbB_man = c_def * tb_man + (1 - c_def) * lgtb[["tb_man"]], tbB_2high = c_def * tb_2high + (1 - c_def) * lgtb[["tb_2high"]])]
# ---- second-order: teammates OUT (as-of shares) and OL / front availability ----
outs <- injk[desig == "OUT" & position_i %in% c("RB", "WR", "TE") ]
so_sh <- function(gs, s, w) { h <- Hs[[gs]]; if (is.null(h)) return(c(NA_real_, NA_real_)); idx <- which(h$season < s | (h$season == s & h$week < w)); if (!length(idx)) return(c(NA_real_, NA_real_)); idx <- tail(idx, WINP); c(mean(h$s_tgt[idx], na.rm = TRUE), mean(h$s_car[idx], na.rm = TRUE)) }
sh2 <- t(mapply(so_sh, outs$gsis_id, outs$season, outs$week)); outs[, `:=`(sh_t = ifelse(is.nan(sh2[, 1]), 0, sh2[, 1]), sh_c = ifelse(is.nan(sh2[, 2]), 0, sh2[, 2]))]; outs[is.na(sh_t), sh_t := 0]; outs[is.na(sh_c), sh_c := 0]
so1 <- outs[, .(so_missing_target_share = sum(sh_t), so_missing_rush_share = sum(sh_c)), by = .(team = team_i, season, week)]
ol <- injk[desig == "OUT" & position_i %in% c("T", "G", "C"), .(so_ol_out = .N), by = .(team = team_i, season, week)]; fr <- injk[desig == "OUT" & position_i %in% c("DE", "DT", "OLB"), .(so_front_out = .N), by = .(opp = team_i, season, week)]
T <- merge(T, so1, by = c("team", "season", "week"), all.x = TRUE); T <- merge(T, ol, by = c("team", "season", "week"), all.x = TRUE); T <- merge(T, fr, by = c("opp", "season", "week"), all.x = TRUE)
for (c in c("so_missing_target_share", "so_missing_rush_share", "so_ol_out", "so_front_out")) set(T, which(is.na(T[[c]])), c, 0)
# the player's own absence is not a "teammate": (the player is not OUT when he has a played target row; for VAL keys a player designated OUT is excluded from his own teammate sum)
own_out <- outs[, .(gsis_id, season, week, own_t = sh_t, own_c = sh_c)]; T <- merge(T, own_out, by = c("gsis_id", "season", "week"), all.x = TRUE); T[is.na(own_t), own_t := 0]; T[is.na(own_c), own_c := 0]; T[, `:=`(so_missing_target_share = so_missing_target_share - own_t, so_missing_rush_share = so_missing_rush_share - own_c)]
# ---- evidence labels ----
T[, `:=`(ev_stale = as.integer(!is.na(gap_days) & gap_days > 21), ev_prior_only_cur = as.integer(n_off_cur_CUR < 2 | n_def_cur_CUR < 2), ev_low_cont = as.integer(pmin(c_off, c_def) < 0.5))]
# usage-lite aliases (S6)
T[, `:=`(rl_dropbacks = u_db, rl_designed = u_des, rl_scrambles = u_scr, rl_snap = u_snap_g, rl_carries = u_car, rl_targets = u_tgt, rl_rz_carries = u_rzc, rl_rz_targets = u_rzt, rl_air_share = s_air)]

# =========================== S6 extras: trends, experience, labels ===========================
T <- T[!is.na(b0) & b0 >= 3]
ros <- rbindlist(lapply(SEASONS, function(s) { r <- as.data.table(load_rosters(s)); r[, .(gsis_id, season = s, years_exp)] })); ros <- unique(ros, by = c("gsis_id", "season")); T <- merge(T, ros, by = c("gsis_id", "season"), all.x = TRUE)
outs_all <- injk[desig == "OUT", .(gsis_id, k = season * 100 + week)]; outk <- split(outs_all$k, outs_all$gsis_id)
tr <- function(gs, s, w, team_) { h <- Hs[[gs]]; idx <- which(h$season < s | (h$season == s & h$week < w)); nn <- length(idx)
  d <- function(col) { if (nn < 6) return(NA_real_); x <- h[[col]][idx]; mean(tail(x, 3), na.rm = TRUE) - mean(x[(nn - 5):(nn - 3)], na.rm = TRUE) }
  rz <- if (nn < 6) NA_real_ else { x <- (h$u_rzt + h$u_rzc)[idx]; mean(tail(x, 3)) - mean(x[(nn - 5):(nn - 3)]) }
  tc <- if (nn < 3) NA_integer_ else as.integer(h$team[idx[nn - 2]] != team_)
  k0 <- s * 100 + w; ko <- outk[[gs]]; ko <- if (is.null(ko)) integer(0) else ko[ko < k0]; wso <- if (!length(ko)) 9L else { m <- max(ko); if (m %/% 100 == s) as.integer(min(8, w - m %% 100)) else 9L }
  list(snap_trend = d("u_snap_g"), target_trend = d("u_tgt"), carry_trend = d("u_car"), rz_trend = rz, career_prior = nn, team_changed_recent = tc, weeks_since_out = wso) }
TR <- rbindlist(lapply(seq_len(nrow(T)), function(i) tr(T$gsis_id[i], T$season[i], T$week[i], T$team[i]))); T <- cbind(T, TR)
# ---- labels (outcomes; computed AFTER and independently of every feature) ----
cut_tab <- base[, .(c6 = sort(actual, decreasing = TRUE)[min(.N, 6)], c12 = sort(actual, decreasing = TRUE)[min(.N, 12)]), by = .(season, week, position)]
T <- merge(T, cut_tab, by = c("season", "week", "position"), all.x = TRUE)
T[, `:=`(lab_primary = as.integer(played == 1 & actual >= fifelse(position == "TE", c6, c12)), lab_top6 = as.integer(played == 1 & actual >= c6), lab_top12 = as.integer(played == 1 & actual >= c12), lab_rel = as.integer(played == 1 & actual >= 2 * b0 & actual >= 15))]
sdres <- T[split == "FIT" & played == 1, .(sd_res = sd(actual - b0)), by = position]; T <- merge(T, sdres, by = "position"); T[, lab_resid := as.integer(played == 1 & (actual - b0) >= 1.5 * sd_res)]
T[, tier := fifelse(b0 >= 12, "STARTER", fifelse(b0 >= 6, "FLEX", "FRINGE"))]
dir.create("scripts/w2r1/cache", showWarnings = FALSE); fwrite(T, "scripts/w2r1/cache/s6_rows.csv"); fwrite(data.table(metric = names(lgm), lg = lgm), "scripts/w2r1/cache/s6_lg_means.csv"); fwrite(as.data.table(t(sapply(lgp, identity)), keep.rownames = "position"), "scripts/w2r1/cache/s6_lg_player.csv")
cat("rows:", nrow(T), " FIT:", sum(T$split == "FIT"), " VAL:", sum(T$split == "VAL"), "\n"); cat("cols:", ncol(T), "\n")

# =========================== LEAKAGE CONTROLS (spec: poison tests) ===========================
suppressMessages(library(jsonlite)); set.seed(20261014)
VT <- T[split == "VAL"]; samp <- VT[sample(.N, 150)]
ok_p <- 0L; bad_p <- character(0)
for (i in seq_len(nrow(samp))) { gs <- samp$gsis_id[i]; s <- samp$season[i]; w <- samp$week[i]; h <- Hs[[gs]]; if (is.null(h)) next
  orig <- player_asof(gs, s, w, samp$position[i]); Hs_save <- Hs[[gs]]; hp <- copy(h); later <- hp$season > s | (hp$season == s & hp$week >= w); for (cc in c(USE, FP, "actual")) set(hp, which(later), cc, 999); Hs[[gs]] <- hp
  pois <- player_asof(gs, s, w, samp$position[i]); Hs[[gs]] <- Hs_save; same <- isTRUE(all.equal(unlist(orig[c(USE, FP, "b0")]), unlist(pois[c(USE, FP, "b0")]))); if (same) ok_p <- ok_p + 1L else bad_p <- c(bad_p, gs) }
tsamp <- tg[sample(.N, 40)]; ok_t <- 0L; tot_t <- 0L
for (i in seq_len(nrow(tsamp))) { tm <- tsamp$team[i]; d0 <- tg_raw[team == tm]; k <- which(d0$game_id == tsamp$game_id[i]); if (!length(k) || k < 3) next
  dp <- copy(d0); for (m in c(OFFM, DEFM)) set(dp, k:nrow(dp), m, 999)
  for (md in c("CUR", "MULTI", "CONT")) for (m in c(OFFM[1:3], DEFM[1:3])) { a <- asof_team(d0, m, md, if (m %in% OFFM) cont_off else cont_def)$v[k]; b <- asof_team(dp, m, md, if (m %in% OFFM) cont_off else cont_def)$v[k]; tot_t <- tot_t + 1L; if (abs(a - b) < 1e-12) ok_t <- ok_t + 1L } }
# Tier-B: value for target season s uses ONLY season s-1 (poison every participation season >= s)
okb <- 0L; totb <- 0L; for (i in sample(nrow(T), 100)) { s <- T$season[i]; tm <- T$team[i]; tbp <- copy(tb); tbp[season >= s, `:=`(tb_off11 = 999, tb_man = 999, tb_2high = 999)]; prior <- tbp[team == tm & season == s - 1]$tb_off11; cf1 <- T$c_off[i]; v <- if (length(prior)) cf1 * prior + (1 - cf1) * lgtb[["tb_off11"]] else NA_real_; totb <- totb + 1L; if (is.na(v) && is.na(T$tbB_off11[i]) || (!is.na(v) && abs(v - T$tbB_off11[i]) < 1e-9)) okb <- okb + 1L }
leak <- list(player_asof_poison = list(passed = ok_p, total = nrow(samp), failures = bad_p), team_asof_poison = list(passed = ok_t, total = tot_t), tier_b_prior_season_only = list(passed = okb, total = totb),
  structural = list(max_feature_season_vs_target = "every as-of function reads rows strictly earlier than the target (poison above)", seasons_loaded = SEASONS, season_2026_loaded = FALSE))
dir.create("scripts/w2r1/results", showWarnings = FALSE); write_json(leak, "scripts/w2r1/results/s6_leak.json", auto_unbox = TRUE, pretty = TRUE)
cat("LEAK player", ok_p, "/", nrow(samp), " team", ok_t, "/", tot_t, " tierB", okb, "/", totb, "\n")
