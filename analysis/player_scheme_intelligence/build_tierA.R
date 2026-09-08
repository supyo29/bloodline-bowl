#!/usr/bin/env Rscript
# ===========================================================================
# Player x Scheme Intelligence — Tier A build (spec §4,5,10,13,17,18,32,38,39).
#
#   Rscript analysis/player_scheme_intelligence/build_tierA.R [season] [week]
#
# Defaults: latest fully-available REG week of PSI$SEASON_CURRENT; if that
# season has zero games, the most recent COMPLETE season (matches FI).
#
# Writes the served contract to lib/player-scheme-intelligence/data/ :
#   player_scheme_manifest.json
#   player_directory.csv
#   qb_spatial_matrix.csv        qb_directional.csv
#   receiver_spatial_matrix.csv
#   rb_rush_matrix.csv           rb_rush_gap.csv
#   defense_pass_vulnerability.csv
#   defense_rush_profile.csv     defense_rush_gap.csv
#   league_baselines.csv
# and the audit artifact to outputs/player-scheme-intelligence-2026/ :
#   cutpoint_sensitivity.json
#   tierA_reconciliation.json
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite); library(digest) }))

.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "player_scheme_intelligence")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_spatial.R"))
set.seed(PSI$SEED)

args <- commandArgs(TRUE); args <- args[!grepl("^--", args)]
cache <- function(n) readRDS(file.path(PSI$CACHE_DIR, paste0(n, ".rds")))

message("loading pbp + ids ...")
pbp <- cache("pbp")
ff  <- cache("ff_playerids")

reg <- pbp %>% filter(season_type == "REG")
sw  <- reg %>% group_by(season) %>% summarise(mw = max(week), .groups = "drop")
if (length(args) >= 1) {
  SEASON <- as.integer(args[1])
  WEEK   <- if (length(args) >= 2) as.integer(args[2]) else sw$mw[sw$season == SEASON]
} else {
  cur <- sw$mw[sw$season == PSI$SEASON_CURRENT]
  if (length(cur) && is.finite(cur)) { SEASON <- PSI$SEASON_CURRENT; WEEK <- cur }
  else { SEASON <- max(sw$season); WEEK <- sw$mw[sw$season == max(sw$season)] }
}
message(sprintf("target: season %d through week %d", SEASON, WEEK))
CURRENT_SEASON_HAS_DATA <- SEASON %in% sw$season && any(reg$season == SEASON)

# ---- windows (spec §9): career / recent / current_team -----------------
RECENT_FROM <- SEASON - 2L        # rolling 3-season window incl current partial

# =======================================================================
# CUT-POINT SENSITIVITY AUDIT (spec §4) — run BEFORE freezing bins.
# For each candidate grid, recompute QB directional depth shares (career) and
# measure how much each QB's profile moves vs the frozen default (grid a).
# =======================================================================
message("cut-point sensitivity audit ...")
grids <- PSI$DEPTH_BIN_GRID
cut_of <- function(g) c(short_hi = g$SHORT_HI, int_hi = g$INT_HI)
dir_for_grid <- function(g) {
  pp <- psi_pass_plays(reg, cut_of(grids[[g]])) %>% psi_asof(SEASON, WEEK)
  psi_qb_directional(pp) %>% filter(n >= 100) %>%
    select(gsis_id, behind_los_pct, short_pct, intermediate_pct, deep_pct,
           deep_middle_pct, intermediate_middle_pct)
}
base_dir <- dir_for_grid("a")
sens <- lapply(c("b", "c"), function(g) {
  x <- dir_for_grid(g)
  j <- inner_join(base_dir, x, by = "gsis_id", suffix = c("_a", "_g"))
  data.frame(
    grid = g,
    short_hi = grids[[g]]$SHORT_HI, int_hi = grids[[g]]$INT_HI,
    n_qb = nrow(j),
    mean_abs_delta_deep_pct = mean(abs(j$deep_pct_a - j$deep_pct_g)),
    max_abs_delta_deep_pct  = max(abs(j$deep_pct_a - j$deep_pct_g)),
    mean_abs_delta_int_mid   = mean(abs(j$intermediate_middle_pct_a - j$intermediate_middle_pct_g)),
    spearman_int_mid = suppressWarnings(cor(j$intermediate_middle_pct_a, j$intermediate_middle_pct_g, method = "spearman")),
    spearman_deep    = suppressWarnings(cor(j$deep_pct_a, j$deep_pct_g, method = "spearman"))
  )
})
sens_df <- bind_rows(sens)
# Freeze rule (spec §4): the STANDARD convention (0/10/20) is frozen when the
# NEAREST conventional alternative (grid c, 12/22) preserves player rank-order
# (Spearman >= 0.90 on both deep% and intermediate-middle%). An AGGRESSIVE
# redefinition (grid b, 8/16) is expected to reshuffle level shares — that
# divergence is recorded as a caveat, not a blocker, because the raw per-cell
# air_yards mean + full matrix are served so any consumer can re-bin.
c_row <- sens_df[sens_df$grid == "c", ]
b_row <- sens_df[sens_df$grid == "b", ]
freeze_ok <- nrow(c_row) == 1 && c_row$spearman_deep >= 0.90 && c_row$spearman_int_mid >= 0.90
cutpoint_audit <- list(
  audit = "psi-tierA-cutpoint-2026.1",
  frozen_default = list(grid = "a", behind_los = "air_yards < 0", short = "0-9",
                        intermediate = "10-19", deep = "20+",
                        rationale = "transparent, conventional, reproducible round-number bins"),
  alternatives_tested = sens_df,
  verdict = if (freeze_ok)
      sprintf("FREEZE default bins (0/10/20). Nearest conventional alternative (12/22) preserves QB rank-order (Spearman deep=%.2f, int-mid=%.2f). CAVEAT (P3): an aggressive 8/16 redefinition reshuffles deep%% rank-order (Spearman=%.2f) — level shares are cut-point sensitive; the served raw matrix + per-cell air_yards mean let a consumer re-bin.",
              c_row$spearman_deep, c_row$spearman_int_mid, b_row$spearman_deep)
    else
      "DO NOT FREEZE: even the nearest conventional cut point reshuffles QB rank-order; escalate before Tier A certification.",
  note = "Shares shift in level (expected) but player rank-order — what a matchup read depends on — is what must be stable."
)
write_json(cutpoint_audit, file.path(PSI$OUT_DIR, "cutpoint_sensitivity.json"),
           auto_unbox = TRUE, pretty = TRUE, dataframe = "rows")
message(sprintf("  cut-point verdict: %s", if (freeze_ok) "FREEZE" else "ESCALATE"))

CUTS <- cut_of(grids[["a"]])   # frozen default

# =======================================================================
# BUILD PROFILES on the frozen bins
# =======================================================================
pass_all <- psi_pass_plays(reg, CUTS) %>% psi_asof(SEASON, WEEK)
rush_all <- psi_rush_plays(reg)       %>% psi_asof(SEASON, WEEK)

windows <- list(
  career       = list(pass = pass_all, rush = rush_all),
  recent       = list(pass = filter(pass_all, season >= RECENT_FROM),
                      rush = filter(rush_all, season >= RECENT_FROM))
)

# as-of team for each player (most recent game in the as-of window)
last_team <- function(df, idcol) df %>% arrange(season, week) %>%
  group_by(gsis_id = .data[[idcol]]) %>% summarise(asof_team = last(posteam), .groups = "drop")
qb_team  <- last_team(pass_all, "passer_player_id")
rec_team <- last_team(filter(pass_all, !is.na(receiver_player_id)), "receiver_player_id")
rb_team  <- last_team(rush_all, "rusher_player_id")

add_ct_window <- function(w, teams, kind) {
  # current_team window: career rows on the player's as-of team
  if (kind == "pass") {
    df <- pass_all %>% inner_join(teams, by = c("passer_player_id" = "gsis_id")) %>%
      filter(posteam == asof_team) %>% select(-asof_team)
  } else if (kind == "recv") {
    df <- pass_all %>% filter(!is.na(receiver_player_id)) %>%
      inner_join(teams, by = c("receiver_player_id" = "gsis_id")) %>%
      filter(posteam == asof_team) %>% select(-asof_team)
  } else {
    df <- rush_all %>% inner_join(teams, by = c("rusher_player_id" = "gsis_id")) %>%
      filter(posteam == asof_team) %>% select(-asof_team)
  }
  df
}

# ---- QB profiles ------------------------------------------------------
message("QB spatial profiles ...")
qb_rows <- list(); qb_dir_rows <- list()
qb_windows <- list(career = pass_all,
                   recent = filter(pass_all, season >= RECENT_FROM),
                   current_team = add_ct_window(NULL, qb_team, "pass"))
for (wn in names(qb_windows)) {
  pp <- qb_windows[[wn]]
  base <- psi_pooled_directional(pp)
  m <- psi_qb_matrix(pp, PSI)
  keep <- m$totals %>% filter(attempts_total >= 30) %>% pull(gsis_id)
  qb_rows[[wn]] <- m$cells %>% filter(gsis_id %in% keep) %>% mutate(window = wn)
  qb_dir_rows[[wn]] <- psi_qb_directional(pp, base) %>% filter(gsis_id %in% keep) %>% mutate(window = wn)
}
qb_spatial_matrix <- bind_rows(qb_rows)
qb_directional <- bind_rows(qb_dir_rows)

# ---- receiver profiles ---------------------------------------------
message("receiver spatial profiles ...")
rec_rows <- list()
rec_windows <- list(career = filter(pass_all, !is.na(receiver_player_id)),
                    recent = filter(pass_all, !is.na(receiver_player_id), season >= RECENT_FROM),
                    current_team = add_ct_window(NULL, rec_team, "recv"))
for (wn in names(rec_windows)) {
  m <- psi_receiver_matrix(rec_windows[[wn]], PSI)
  keep <- m$totals %>% filter(targets_total >= 20) %>% pull(gsis_id)
  rec_rows[[wn]] <- m$cells %>% filter(gsis_id %in% keep) %>% mutate(window = wn)
}
receiver_spatial_matrix <- bind_rows(rec_rows)

# ---- RB rushing profiles -----------------------------------------
message("RB rushing spatial profiles ...")
rb_dir_rows <- list(); rb_gap_rows <- list()
rb_windows <- list(career = rush_all,
                   recent = filter(rush_all, season >= RECENT_FROM),
                   current_team = add_ct_window(NULL, rb_team, "rush"))
for (wn in names(rb_windows)) {
  m <- psi_rb_rush_matrix(rb_windows[[wn]], PSI)
  keep <- m$totals %>% filter(carries_total >= 20) %>% pull(gsis_id)
  rb_dir_rows[[wn]] <- m$direction %>% filter(gsis_id %in% keep) %>% mutate(window = wn)
  rb_gap_rows[[wn]] <- m$gap %>% filter(gsis_id %in% keep) %>% mutate(window = wn)
}
rb_rush_matrix <- bind_rows(rb_dir_rows)
rb_rush_gap <- bind_rows(rb_gap_rows)

# ---- defense profiles ------------------------------------------
message("defense profiles ...")
def_pass_rows <- list(); def_rush_rows <- list(); def_rush_gap_rows <- list()
def_windows_pass <- list(career = pass_all, recent = filter(pass_all, season >= RECENT_FROM))
def_windows_rush <- list(career = rush_all, recent = filter(rush_all, season >= RECENT_FROM))
for (wn in names(def_windows_pass)) {
  dp <- psi_def_pass_matrix(def_windows_pass[[wn]], PSI)
  def_pass_rows[[wn]] <- dp$cells %>% mutate(window = wn)
  dr <- psi_def_rush_profile(def_windows_rush[[wn]], PSI)
  def_rush_rows[[wn]] <- dr$direction %>% mutate(window = wn)
  def_rush_gap_rows[[wn]] <- dr$gap %>% mutate(window = wn)
}
defense_pass_vulnerability <- bind_rows(def_pass_rows)
defense_rush_profile <- bind_rows(def_rush_rows)
defense_rush_gap <- bind_rows(def_rush_gap_rows)

# ---- league baselines (spec §5) ---------------------------------
message("league baselines ...")
league_baselines <- bind_rows(lapply(names(qb_windows), function(wn) {
  psi_pooled_pass_matrix(qb_windows[[wn]]) %>% mutate(window = wn, entity = "LEAGUE_QB")
}))

# ---- player directory (id resolution for the API, spec §37) -----
message("player directory ...")
ids_used <- unique(c(qb_spatial_matrix$gsis_id, receiver_spatial_matrix$gsis_id, rb_rush_matrix$gsis_id))
player_directory <- ff %>%
  filter(gsis_id %in% ids_used) %>%
  transmute(gsis_id, full_name = name, position, nfl_team = team,
            sleeper_id = as.character(sleeper_id), pfr_id = as.character(pfr_id),
            espn_id = as.character(espn_id), yahoo_id = as.character(yahoo_id)) %>%
  distinct(gsis_id, .keep_all = TRUE)
# players present in profiles but absent from ff crosswalk -> recorded, not dropped
missing_ids <- setdiff(ids_used, player_directory$gsis_id)
if (length(missing_ids))
  player_directory <- bind_rows(player_directory,
    tibble(gsis_id = missing_ids, full_name = NA, position = NA, nfl_team = NA,
           sleeper_id = NA, pfr_id = NA, espn_id = NA, yahoo_id = NA))

# =======================================================================
# RECONCILIATION (Tier A gate, spec §41, §42) — computed + persisted
# =======================================================================
message("reconciliation checks ...")
recon <- list()
# (1) QB matrix cell attempts sum to attempts_charted per (player, career)
q_career_cells <- qb_spatial_matrix %>% filter(window == "career") %>%
  group_by(gsis_id) %>% summarise(cell_sum = sum(attempts), charted = first(attempts_charted), .groups = "drop")
recon$qb_matrix_reconciles <- all(q_career_cells$cell_sum == q_career_cells$charted)
recon$qb_matrix_max_abs_gap <- max(abs(q_career_cells$cell_sum - q_career_cells$charted))
# (2) charted + uncharted == total
q_tot <- qb_spatial_matrix %>% filter(window == "career") %>% distinct(gsis_id, attempts_total, attempts_charted, attempts_uncharted)
recon$qb_charted_plus_uncharted_eq_total <- all(q_tot$attempts_charted + q_tot$attempts_uncharted == q_tot$attempts_total)
# (3) directional shares ~ sum to 1
qd <- qb_directional %>% filter(window == "career")
recon$qb_lmr_sums_to_1_max_err <- max(abs((qd$left_pct + qd$middle_pct + qd$right_pct) - 1))
recon$qb_depth_sums_to_1_max_err <- max(abs((qd$behind_los_pct + qd$short_pct + qd$intermediate_pct + qd$deep_pct) - 1))
# (4) defense pass matrix cells sum to targets_charted per team/window
dpc <- defense_pass_vulnerability %>% group_by(team, window) %>%
  summarise(cs = sum(targets_allowed), tc = first(targets_charted), .groups = "drop")
recon$def_pass_matrix_reconciles <- all(dpc$cs == dpc$tc)
# (5) no fabricated MIDDLE / SHORT: a play with NA location must not be in a cell.
#     structural — cells are built only from `charted` rows. Assert count identity:
recon$no_uncharted_in_cells <- recon$qb_matrix_reconciles && recon$def_pass_matrix_reconciles
# (6) determinism: hash the served frames
served_hash <- digest::digest(list(qb_spatial_matrix, qb_directional, receiver_spatial_matrix,
                                   rb_rush_matrix, rb_rush_gap, defense_pass_vulnerability,
                                   defense_rush_profile, defense_rush_gap, league_baselines), algo = "sha256")
recon$served_content_sha256 <- served_hash
recon$all_pass <- isTRUE(recon$qb_matrix_reconciles) && isTRUE(recon$qb_charted_plus_uncharted_eq_total) &&
  isTRUE(recon$def_pass_matrix_reconciles) && recon$qb_lmr_sums_to_1_max_err < 1e-9 &&
  recon$qb_depth_sums_to_1_max_err < 1e-9
write_json(c(list(reconciliation = "psi-tierA-reconciliation-2026.1", season = SEASON, week = WEEK), recon),
           file.path(PSI$OUT_DIR, "tierA_reconciliation.json"), auto_unbox = TRUE, pretty = TRUE)
message(sprintf("  reconciliation all_pass = %s", recon$all_pass))

# =======================================================================
# MANIFEST + WRITE
# =======================================================================
version <- sprintf("psi:%d:w%02d:%s", SEASON, WEEK, substr(served_hash, 1, 12))
data_cutoff <- list(pbp = as.integer(WEEK))
avail_state <- if (CURRENT_SEASON_HAS_DATA && SEASON == PSI$SEASON_CURRENT) "LIVE_CURRENT" else "HISTORICAL_CURRENT_THROUGH_2025"

manifest <- list(
  player_scheme_version = version,
  model_tag = PSI$MODEL_TAG,
  tier = "A",
  feature_schema_version = PSI$FEATURE_SCHEMA_VERSION,
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
  current_season = SEASON,
  as_of_week = WEEK,
  data_cutoff = data_cutoff,
  seasons_used = sort(unique(pass_all$season)),
  availability_state = avail_state,
  live_class = "LIVE_CAPABLE",
  current_season_status = if (avail_state == "LIVE_CURRENT") "LIVE_CURRENT" else "PRIOR_ONLY",
  model_versions = list(spatial = PSI$SPATIAL_VERSION),
  source_versions = list(nflreadr = tryCatch(as.character(utils::packageVersion("nflreadr")), error = function(e) "unknown")),
  config = list(seed = PSI$SEED, depth_short_hi = unname(CUTS["short_hi"]), depth_int_hi = unname(CUTS["int_hi"]),
                recent_from_season = RECENT_FROM,
                explosive_pass_yards = PSI$EXPLOSIVE_PASS_YARDS, explosive_rush_yards = PSI$EXPLOSIVE_RUSH_YARDS),
  windows = c("career", "recent", "current_team"),
  files = c("player_directory.csv", "qb_spatial_matrix.csv", "qb_directional.csv",
            "receiver_spatial_matrix.csv", "rb_rush_matrix.csv", "rb_rush_gap.csv",
            "defense_pass_vulnerability.csv", "defense_rush_profile.csv",
            "defense_rush_gap.csv", "league_baselines.csv"),
  deployment = "SHARED_DESCRIPTIVE",
  fantasy_adjustment_enabled = FALSE,
  cutpoint_verdict = if (freeze_ok) "FROZEN" else "ESCALATE",
  reconciliation_all_pass = recon$all_pass,
  determinism = "seeded; pure aggregation; identical cache -> identical version",
  notes = c(
    "Tier A is PBP-only and LIVE_CAPABLE. No participation / FTN / NGS input.",
    "Cells are built ONLY from plays with a charted pass_location AND air_yards (or run_location). Uncharted plays are counted in *_total, never assigned to a cell (spec §41).",
    "depth bins: BEHIND_LOS air_yards<0 | SHORT 0-9 | INTERMEDIATE 10-19 | DEEP 20+. air_yards==0 -> SHORT (documented).",
    "run_location / run_gap are offense-perspective as shipped by nflverse; no mirroring (spec §42).",
    "Scrambles + sacks + spikes + kneels + 2-pt are excluded from the designed-play universes; sacks are NOT pass attempts.",
    if (avail_state != "LIVE_CURRENT") "current_season_status=PRIOR_ONLY: newest data is a prior season; NOT a current-season observation (spec §3)." else "current_season_status=LIVE_CURRENT."
  )
)

w_csv <- function(df, name) write.csv(as.data.frame(df), file.path(PSI$SERVE_DIR, name), row.names = FALSE, na = "")
w_csv(player_directory, "player_directory.csv")
w_csv(qb_spatial_matrix, "qb_spatial_matrix.csv")
w_csv(qb_directional, "qb_directional.csv")
w_csv(receiver_spatial_matrix, "receiver_spatial_matrix.csv")
w_csv(rb_rush_matrix, "rb_rush_matrix.csv")
w_csv(rb_rush_gap, "rb_rush_gap.csv")
w_csv(defense_pass_vulnerability, "defense_pass_vulnerability.csv")
w_csv(defense_rush_profile, "defense_rush_profile.csv")
w_csv(defense_rush_gap, "defense_rush_gap.csv")
w_csv(league_baselines, "league_baselines.csv")
write(jsonlite::toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, null = "null"),
      file.path(PSI$SERVE_DIR, "player_scheme_manifest.json"))
saveRDS(list(manifest = manifest, qb_spatial_matrix = qb_spatial_matrix, qb_directional = qb_directional,
             receiver_spatial_matrix = receiver_spatial_matrix, rb_rush_matrix = rb_rush_matrix,
             defense_pass_vulnerability = defense_pass_vulnerability),
        file.path(PSI$OUT_DIR, sprintf("tierA_%s.rds", gsub("[:]", "_", version))))

message("\nsnapshot ", version)
message(sprintf("  qb_spatial_matrix          %d rows (%d QBs career)", nrow(qb_spatial_matrix),
                n_distinct(filter(qb_spatial_matrix, window == "career")$gsis_id)))
message(sprintf("  receiver_spatial_matrix    %d rows (%d receivers career)", nrow(receiver_spatial_matrix),
                n_distinct(filter(receiver_spatial_matrix, window == "career")$gsis_id)))
message(sprintf("  rb_rush_matrix             %d rows (%d RBs career)", nrow(rb_rush_matrix),
                n_distinct(filter(rb_rush_matrix, window == "career")$gsis_id)))
message(sprintf("  defense_pass_vulnerability %d rows", nrow(defense_pass_vulnerability)))
message(sprintf("  player_directory           %d players (%d unresolved to crosswalk)", nrow(player_directory), length(missing_ids)))
message(sprintf("  cutpoint: %s | reconciliation: %s", manifest$cutpoint_verdict,
                if (recon$all_pass) "ALL PASS" else "FAILURES — SEE tierA_reconciliation.json"))
