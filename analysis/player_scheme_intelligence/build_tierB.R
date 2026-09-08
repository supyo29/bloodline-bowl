#!/usr/bin/env Rscript
# ===========================================================================
# Player x Scheme Intelligence — Tier B build (spec §6-16, §19, §21-24, §31, §36).
#
#   Rscript analysis/player_scheme_intelligence/build_tierB.R [season] [week]
#
# Charting-dependent profiles from participation + FTN. ADDITIVE to Tier A:
# reads NOTHING from Tier A's frozen artifacts and does not modify them.
# Every output carries machine-readable provenance (availability / source /
# source_season_through / current_season_observed / coverage rate).
#
# Writes to lib/player-scheme-intelligence/data/ :
#   qb_coverage_profile.csv        qb_coverage_family.csv
#   qb_pressure_profile.csv        qb_rusher_count_profile.csv
#   qb_formation_profile.csv
#   qb_concept_profile.csv         qb_progression_profile.csv
#   receiver_route_profile.csv     receiver_coverage_profile.csv
#   rb_box_profile.csv
#   player_scheme_manifest.json    (merged: adds a `tier_b` block + tiers list)
# and audit artifacts to outputs/player-scheme-intelligence-2026/ :
#   tierB_reconciliation.json  tierB_box_sensitivity.json  feature_registry_status.json
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite); library(digest) }))

.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "player_scheme_intelligence")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_spatial.R"))
source(file.path(BASE, "lib_charting.R"))
set.seed(PSI$SEED)

args <- commandArgs(TRUE); args <- args[!grepl("^--", args)]
cache <- function(n) readRDS(file.path(PSI$CACHE_DIR, paste0(n, ".rds")))

message("loading pbp + participation + ftn + ids ...")
pbp <- cache("pbp"); participation <- cache("participation"); ftn <- cache("ftn_charting")
ff  <- cache("ff_playerids")

reg <- pbp %>% filter(season_type == "REG")
sw  <- reg %>% group_by(season) %>% summarise(mw = max(week), .groups = "drop")
if (length(args) >= 1) {
  SEASON <- as.integer(args[1]); WEEK <- if (length(args) >= 2) as.integer(args[2]) else sw$mw[sw$season == SEASON]
} else {
  cur <- sw$mw[sw$season == PSI$SEASON_CURRENT]
  if (length(cur) && is.finite(cur)) { SEASON <- PSI$SEASON_CURRENT; WEEK <- cur }
  else { SEASON <- max(sw$season); WEEK <- sw$mw[sw$season == max(sw$season)] }
}
RECENT_FROM <- SEASON - 2L
message(sprintf("target: season %d through week %d", SEASON, WEEK))

# ---- per-source cutoffs (spec §22) -----------------------------------
part_games <- participation %>% distinct(nflverse_game_id) %>%
  inner_join(reg %>% distinct(game_id, season, week), by = c("nflverse_game_id" = "game_id"))
part_cut_season <- suppressWarnings(max(part_games$season[part_games$season <= SEASON]))
part_cut_week   <- if (is.finite(part_cut_season))
  max(part_games$week[part_games$season == part_cut_season & !(part_cut_season == SEASON & part_games$week > WEEK)]) else NA
ftn_cut_season <- if (!is.null(ftn) && nrow(ftn)) suppressWarnings(max(ftn$season[ftn$season <= SEASON])) else NA
ftn_cut_week   <- if (is.finite(ftn_cut_season)) max(ftn$week[ftn$season == ftn_cut_season]) else NA
# "current" is relative to the real current NFL season (PSI$SEASON_CURRENT),
# NOT the snapshot's target season — so a 2025-target build still correctly
# reports that 2026 charting is unobserved (spec §3, §31).
current_season_observed_part <- is.finite(part_cut_season) && part_cut_season >= PSI$SEASON_CURRENT
current_season_observed_ftn  <- is.finite(ftn_cut_season)  && ftn_cut_season  >= PSI$SEASON_CURRENT

message(sprintf("  participation cutoff: %s w%s   FTN cutoff: %s w%s",
                part_cut_season, part_cut_week, ftn_cut_season, ftn_cut_week))
message(sprintf("  current_season_observed: participation=%s  ftn=%s",
                current_season_observed_part, current_season_observed_ftn))

# ---- charting play frame, chronology-safe ----------------------------
cp <- psi_charting_plays(reg, participation, ftn, PSI) %>% psi_asof(SEASON, WEEK)
db_all   <- psi_charting_dropbacks(cp)
rush_all <- psi_charting_rushes(cp)

last_team <- function(df, idcol) df %>% arrange(season, week) %>%
  group_by(gsis_id = .data[[idcol]]) %>% summarise(asof_team = last(posteam), .groups = "drop")
qb_team  <- last_team(db_all, "passer_player_id")
rec_team <- last_team(filter(cp, pass_attempt == 1, !is.na(receiver_player_id)), "receiver_player_id")
rb_team  <- last_team(rush_all, "rusher_player_id")

win_db <- list(
  career = db_all,
  recent = filter(db_all, season >= RECENT_FROM),
  current_team = db_all %>% inner_join(qb_team, by = c("passer_player_id" = "gsis_id")) %>%
    filter(posteam == asof_team) %>% select(-asof_team)
)
win_cp_recv <- list(
  career = cp,
  recent = filter(cp, season >= RECENT_FROM),
  current_team = cp %>% filter(pass_attempt == 1, !is.na(receiver_player_id)) %>%
    inner_join(rec_team, by = c("receiver_player_id" = "gsis_id")) %>%
    filter(posteam == asof_team) %>% select(-asof_team)
)
win_rush <- list(
  career = rush_all,
  recent = filter(rush_all, season >= RECENT_FROM),
  current_team = rush_all %>% inner_join(rb_team, by = c("rusher_player_id" = "gsis_id")) %>%
    filter(posteam == asof_team) %>% select(-asof_team)
)

# =======================================================================
# BOX BUCKET SENSITIVITY AUDIT (spec §14) — before freezing bucket cuts
# =======================================================================
message("box-bucket sensitivity audit ...")
box_dir_for <- function(g) {
  cd <- list(LIGHT = c(-Inf, PSI$BOX_BUCKET_GRID[[g]]$light_hi),
             NEUTRAL = c(PSI$BOX_BUCKET_GRID[[g]]$light_hi, PSI$BOX_BUCKET_GRID[[g]]$heavy_lo),
             HEAVY = c(PSI$BOX_BUCKET_GRID[[g]]$heavy_lo, Inf))
  psi_rb_box_profile(rush_all, PSI, cutdef = cd)$boxes %>%
    filter(carries >= 40) %>%
    group_by(gsis_id) %>%
    summarise(heavy_epa = epa_per_rush[bucket == "HEAVY"][1],
              light_epa = epa_per_rush[bucket == "LIGHT"][1], .groups = "drop") %>%
    filter(!is.na(heavy_epa), !is.na(light_epa)) %>%
    mutate(heavy_minus_light = heavy_epa - light_epa)
}
ba <- box_dir_for("a")
box_sens <- bind_rows(lapply(c("b", "c"), function(g) {
  x <- box_dir_for(g); j <- inner_join(ba, x, by = "gsis_id", suffix = c("_a", "_g"))
  data.frame(grid = g, light_hi = PSI$BOX_BUCKET_GRID[[g]]$light_hi,
             heavy_lo = PSI$BOX_BUCKET_GRID[[g]]$heavy_lo, n_rb = nrow(j),
             spearman_heavy_minus_light = suppressWarnings(cor(j$heavy_minus_light_a, j$heavy_minus_light_g, method = "spearman")),
             mean_abs_delta = mean(abs(j$heavy_minus_light_a - j$heavy_minus_light_g)))
}))
box_freeze_ok <- all(box_sens$spearman_heavy_minus_light > 0.8, na.rm = TRUE)
write_json(list(audit = "psi-tierB-box-sensitivity-2026.1",
                frozen_default = list(grid = "a", light = "box < 6.5", neutral = "6.5-7.5", heavy = "box >= 7.5"),
                alternatives = box_sens,
                verdict = if (box_freeze_ok)
                  "FREEZE default box buckets: RB heavy-minus-light EPA rank-order is stable (Spearman > 0.80) across tested cut points."
                else
                  "CAVEAT: box-bucket rank-order is cut sensitive; expose raw mean_box_faced + per-bucket carries so a consumer can re-bucket."),
           file.path(PSI$OUT_DIR, "tierB_box_sensitivity.json"), auto_unbox = TRUE, pretty = TRUE, dataframe = "rows")
message(sprintf("  box-bucket verdict: %s", if (box_freeze_ok) "FREEZE" else "CAVEAT (raw served)"))

# =======================================================================
# BUILD PROFILES per window
# =======================================================================
tag_window <- function(df, wn) if (nrow(df)) mutate(df, window = wn) else mutate(df, window = character())

qb_cov <- list(); qb_covfam <- list(); qb_press <- list(); qb_rush <- list()
qb_form <- list(); qb_concept <- list(); qb_prog <- list()
rec_route <- list(); rec_cov <- list(); rb_box <- list()

for (wn in names(win_db)) {
  db <- win_db[[wn]]
  keep_qb <- db %>% count(passer_player_id) %>% filter(n >= 100) %>% pull(passer_player_id)
  db <- db %>% filter(passer_player_id %in% keep_qb)

  cvp <- psi_qb_coverage_profile(db, PSI, PSI$TIERB_FAMILIES$qb_coverage$first_season)
  qb_cov[[wn]]    <- tag_window(cvp$man_zone, wn)
  qb_covfam[[wn]] <- tag_window(cvp$family, wn)
  qb_press[[wn]]  <- tag_window(psi_qb_pressure_profile(db, PSI)$states, wn)
  qb_rush[[wn]]   <- tag_window(psi_qb_rusher_count_profile(db, PSI), wn)
  qb_form[[wn]]   <- tag_window(psi_qb_formation_profile(db, PSI), wn)
  qb_concept[[wn]]<- tag_window(psi_qb_concept_profile(db, PSI), wn)
  qb_prog[[wn]]   <- tag_window(psi_qb_progression_profile(db, PSI), wn)
}
for (wn in names(win_cp_recv)) {
  rr <- psi_receiver_route_profile(win_cp_recv[[wn]], PSI)
  rc <- psi_receiver_coverage_profile(win_cp_recv[[wn]], PSI)
  keep <- rr$totals %>% filter(targets_eligible >= 25) %>% pull(gsis_id)
  rec_route[[wn]] <- tag_window(rr$routes %>% filter(gsis_id %in% keep), wn)
  rec_cov[[wn]]   <- tag_window(rc$man_zone %>% filter(gsis_id %in% keep), wn)
}
for (wn in names(win_rush)) {
  rb <- psi_rb_box_profile(win_rush[[wn]], PSI)
  keep <- rb$totals %>% filter(carries_eligible >= 25) %>% pull(gsis_id)
  rb_box[[wn]] <- tag_window(rb$boxes %>% filter(gsis_id %in% keep), wn)
}

qb_coverage_profile      <- bind_rows(qb_cov)
qb_coverage_family       <- bind_rows(qb_covfam)
qb_pressure_profile      <- bind_rows(qb_press)
qb_rusher_count_profile  <- bind_rows(qb_rush)
qb_formation_profile     <- bind_rows(qb_form)
qb_concept_profile       <- bind_rows(qb_concept)
qb_progression_profile   <- bind_rows(qb_prog)
receiver_route_profile   <- bind_rows(rec_route)
receiver_coverage_profile<- bind_rows(rec_cov)
rb_box_profile           <- bind_rows(rb_box)

# =======================================================================
# RECONCILIATION (Tier B gate, spec §23)
# =======================================================================
message("reconciliation ...")
r <- list()
# coverage: man + zone plays <= dropbacks_charted_mz; never exceeds
cvt <- psi_qb_coverage_profile(db_all %>% filter(season >= 2018), PSI)$totals
r$coverage_man_plus_zone_le_charted <- all(cvt$man_dropbacks + cvt$zone_dropbacks <= cvt$dropbacks_charted_mz)
r$coverage_charted_le_eligible <- all(cvt$dropbacks_charted_mz <= cvt$dropbacks_eligible)
# man/zone shares of charted sum to <=1 (OTHER man_zone types dropped -> exactly the 2)
mz_career <- qb_coverage_profile %>% filter(window == "career") %>%
  group_by(gsis_id) %>% summarise(states = paste(sort(bucket), collapse = ","), .groups = "drop")
r$coverage_only_man_zone_buckets <- all(qb_coverage_profile$bucket %in% c("MAN", "ZONE"))
# pressure: pressured + clean plays == dropbacks_charted_pressure
pt <- psi_qb_pressure_profile(db_all, PSI)$totals
ps_sum <- qb_pressure_profile %>% filter(window == "career") %>% group_by(gsis_id) %>%
  summarise(s = sum(plays), .groups = "drop") %>%
  left_join(pt %>% select(gsis_id, dropbacks_charted_pressure), by = "gsis_id")
r$pressure_states_reconcile <- all(ps_sum$s == ps_sum$dropbacks_charted_pressure, na.rm = TRUE)
r$pressure_only_two_states <- all(qb_pressure_profile$bucket %in% c("PRESSURED", "CLEAN"))
# routes: targeted_route_share sums to 1 per (player, window)
rt_sum <- receiver_route_profile %>% group_by(gsis_id, window) %>%
  summarise(s = sum(targeted_route_share), .groups = "drop")
r$route_shares_sum_to_1_max_err <- if (nrow(rt_sum)) max(abs(rt_sum$s - 1)) else 0
# box buckets partition: box_share sums to 1
bx_sum <- rb_box_profile %>% group_by(gsis_id, window) %>% summarise(s = sum(box_share), .groups = "drop")
r$box_shares_sum_to_1_max_err <- if (nrow(bx_sum)) max(abs(bx_sum$s - 1)) else 0
r$box_only_three_buckets <- all(rb_box_profile$bucket %in% c("LIGHT", "NEUTRAL", "HEAVY"))
# FTN concepts: never fabricate FALSE — plays_with_concept <= charted_plays
r$concept_within_charted <- all(qb_concept_profile$plays_with_concept <= qb_concept_profile$charted_plays)
# no 2026 observation fabricated
r$no_current_season_participation <- !current_season_observed_part
r$no_current_season_ftn <- !current_season_observed_ftn
# determinism
served <- list(qb_coverage_profile, qb_coverage_family, qb_pressure_profile, qb_rusher_count_profile,
               qb_formation_profile, qb_concept_profile, qb_progression_profile,
               receiver_route_profile, receiver_coverage_profile, rb_box_profile)
served_hash <- digest::digest(served, algo = "sha256")
r$served_content_sha256 <- served_hash
r$all_pass <- isTRUE(r$coverage_man_plus_zone_le_charted) && isTRUE(r$coverage_charted_le_eligible) &&
  isTRUE(r$coverage_only_man_zone_buckets) && isTRUE(r$pressure_states_reconcile) &&
  isTRUE(r$pressure_only_two_states) && r$route_shares_sum_to_1_max_err < 1e-9 &&
  r$box_shares_sum_to_1_max_err < 1e-9 && isTRUE(r$box_only_three_buckets) &&
  isTRUE(r$concept_within_charted)
write_json(c(list(reconciliation = "psi-tierB-reconciliation-2026.1", season = SEASON, week = WEEK), r),
           file.path(PSI$OUT_DIR, "tierB_reconciliation.json"), auto_unbox = TRUE, pretty = TRUE)
message(sprintf("  reconciliation all_pass = %s", r$all_pass))

# =======================================================================
# MANIFEST MERGE (spec §22) + WRITE
# =======================================================================
mpath <- file.path(PSI$SERVE_DIR, "player_scheme_manifest.json")
manifest <- jsonlite::fromJSON(mpath, simplifyVector = TRUE)
tierb_families <- lapply(names(PSI$TIERB_FAMILIES), function(fn) {
  f <- PSI$TIERB_FAMILIES[[fn]]
  through <- if (f$source == "ftn") sprintf("%s w%s", ftn_cut_season, ftn_cut_week) else sprintf("%s w%s", part_cut_season, part_cut_week)
  cur_obs <- if (f$source == "ftn") current_season_observed_ftn else current_season_observed_part
  list(family = fn, source = f$source, first_supported_season = f$first_season,
       availability = f$availability, source_season_through = through,
       current_season_observed = cur_obs)
})
manifest$tiers <- c("A", "B")
manifest$tier_b <- list(
  built_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
  spatial_version = PSI$SPATIAL_VERSION,
  tendency_version = PSI$TENDENCY_VERSION,
  feature_registry_version = PSI$FEATURE_REGISTRY_VERSION,
  data_cutoff = list(participation_season = part_cut_season, participation_week = part_cut_week,
                     ftn_season = ftn_cut_season, ftn_week = ftn_cut_week),
  current_season_observed = list(participation = current_season_observed_part, ftn = current_season_observed_ftn),
  box_bucket_verdict = if (box_freeze_ok) "FROZEN" else "CAVEAT_RAW_SERVED",
  reconciliation_all_pass = r$all_pass,
  served_content_sha256 = served_hash,
  families = tierb_families,
  files = c("qb_coverage_profile.csv", "qb_coverage_family.csv", "qb_pressure_profile.csv",
            "qb_rusher_count_profile.csv", "qb_formation_profile.csv", "qb_concept_profile.csv",
            "qb_progression_profile.csv", "receiver_route_profile.csv",
            "receiver_coverage_profile.csv", "rb_box_profile.csv"),
  notes = c(
    "Every Tier B family is PRIOR_ONLY (participation) or DESCRIPTIVE_ONLY (FTN). NONE is LIVE_CAPABLE for 2026.",
    "Denominators are CHARTED plays; coverage_rate_* is exposed. Uncharted plays never become MAN/ZONE/FALSE/a box bucket (spec §5, §23).",
    "participation `route` is the TARGETED route only. targeted_route_share is a share of targets, NOT routes run. YPRR is not computable (spec §10).",
    "FTN n_blitzers (true blitz count) is kept distinct from participation number_of_pass_rushers >= 5 (blitz PROXY) (spec §8).",
    "FTN families are DESCRIPTIVE_ONLY and can never enter Tier D as a LIVE_CAPABLE predictor (spec §11)."
  )
)
write(jsonlite::toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, null = "null"), mpath)

w_csv <- function(df, name) write.csv(as.data.frame(df), file.path(PSI$SERVE_DIR, name), row.names = FALSE, na = "")
w_csv(qb_coverage_profile, "qb_coverage_profile.csv")
w_csv(qb_coverage_family, "qb_coverage_family.csv")
w_csv(qb_pressure_profile, "qb_pressure_profile.csv")
w_csv(qb_rusher_count_profile, "qb_rusher_count_profile.csv")
w_csv(qb_formation_profile, "qb_formation_profile.csv")
w_csv(qb_concept_profile, "qb_concept_profile.csv")
w_csv(qb_progression_profile, "qb_progression_profile.csv")
w_csv(receiver_route_profile, "receiver_route_profile.csv")
w_csv(receiver_coverage_profile, "receiver_coverage_profile.csv")
w_csv(rb_box_profile, "rb_box_profile.csv")

# ---- feature registry status artifact (spec §21) --------------------
reg_status <- lapply(names(PSI$TIERB_FAMILIES), function(fn) {
  f <- PSI$TIERB_FAMILIES[[fn]]
  frame <- switch(fn,
    qb_coverage = qb_coverage_profile, qb_pressure = qb_pressure_profile,
    qb_rusher_count = qb_rusher_count_profile, qb_formation = qb_formation_profile,
    qb_concepts = qb_concept_profile, qb_progression = qb_progression_profile,
    receiver_route = receiver_route_profile, receiver_coverage = receiver_coverage_profile,
    rb_box = rb_box_profile)
  list(feature = fn, built = nrow(frame) > 0, source = f$source,
       first_supported_season = f$first_season, availability = f$availability,
       current_season_status = "PRIOR_ONLY",
       predictive_eligible = if (f$availability == "DESCRIPTIVE_ONLY") FALSE else "candidate_pending_tierD",
       rows = nrow(frame),
       evidence_mix = as.list(table(frame$evidence_class)))
})
write_json(list(registry = PSI$FEATURE_REGISTRY_VERSION, tier = "B", updated_at = format(Sys.time()),
                families = reg_status),
           file.path(PSI$OUT_DIR, "feature_registry_status.json"), auto_unbox = TRUE, pretty = TRUE)

saveRDS(list(manifest = manifest$tier_b, qb_coverage_profile = qb_coverage_profile,
             qb_pressure_profile = qb_pressure_profile, receiver_route_profile = receiver_route_profile,
             rb_box_profile = rb_box_profile),
        file.path(PSI$OUT_DIR, sprintf("tierB_%s.rds", substr(served_hash, 1, 12))))

message("\nTier B built.")
message(sprintf("  qb_coverage_profile       %d rows (%d QBs career)", nrow(qb_coverage_profile),
                n_distinct(filter(qb_coverage_profile, window == "career")$gsis_id)))
message(sprintf("  qb_pressure_profile       %d rows", nrow(qb_pressure_profile)))
message(sprintf("  qb_concept_profile (FTN)  %d rows", nrow(qb_concept_profile)))
message(sprintf("  receiver_route_profile    %d rows (%d receivers)", nrow(receiver_route_profile),
                n_distinct(filter(receiver_route_profile, window == "career")$gsis_id)))
message(sprintf("  rb_box_profile            %d rows (%d RBs)", nrow(rb_box_profile),
                n_distinct(filter(rb_box_profile, window == "career")$gsis_id)))
message(sprintf("  box verdict: %s | reconciliation: %s",
                if (box_freeze_ok) "FROZEN" else "CAVEAT", if (r$all_pass) "ALL PASS" else "FAILURES"))
