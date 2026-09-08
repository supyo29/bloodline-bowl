#!/usr/bin/env Rscript
# ===========================================================================
# Player x Scheme Intelligence — Tier C build (spec §16, §17, §20, §21, §22).
#
#   Rscript analysis/player_scheme_intelligence/build_tierC.R [season] [week]
#
# Team offense/defense tendency profiles + numeric player/defense archetype
# vectors + scheme-era mechanism. ADDITIVE to Tiers A/B; reads the served
# Tier A/B CSVs read-only, modifies none of them, does NOT touch Football
# Intelligence.
#
# Writes to lib/player-scheme-intelligence/data/ :
#   offense_team_profile.csv     defense_team_profile.csv
#   qb_archetype_vector.csv      defense_archetype_vector.csv
#   scheme_era.csv
#   player_scheme_manifest.json  (merged: adds a `tier_c` block; tiers -> A,B,C)
# and audit artifacts to outputs/player-scheme-intelligence-2026/ :
#   tierC_reconciliation.json    tierC_archetype_stability.json
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite); library(digest) }))

.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "player_scheme_intelligence")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_spatial.R"))
source(file.path(BASE, "lib_charting.R"))
source(file.path(BASE, "lib_team_archetype.R"))
set.seed(PSI$SEED)

`%||%` <- function(a, b) if (is.null(a)) b else a
args <- commandArgs(TRUE); args <- args[!grepl("^--", args)]
cache <- function(n) readRDS(file.path(PSI$CACHE_DIR, paste0(n, ".rds")))
serve <- function(n) {
  p <- file.path(PSI$SERVE_DIR, n)
  if (!file.exists(p)) stop(sprintf("Tier A/B artifact missing: %s (run build_tierA.R + build_tierB.R first)", n))
  read.csv(p, stringsAsFactors = FALSE)
}

message("loading pbp + participation + ftn + schedules ...")
pbp <- cache("pbp"); participation <- cache("participation"); ftn <- cache("ftn_charting")
schedules <- tryCatch(cache("schedules"), error = function(e) NULL)

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

cp <- psi_charting_plays(reg, participation, ftn, PSI) %>% psi_asof(SEASON, WEEK)
win_cp <- list(career = cp, recent = filter(cp, season >= RECENT_FROM))

# =======================================================================
# TEAM PROFILES
# =======================================================================
message("team offense/defense tendency profiles ...")
flatten_team <- function(lst, side, wn) {
  Reduce(function(a, b) full_join(a, b, by = "team"),
         lapply(names(lst), function(nm) {
           d <- lst[[nm]]
           av <- if ("availability" %in% names(d)) d$availability[1] else NA
           d %>% select(-any_of("availability")) %>%
             rename_with(~ ifelse(.x == "team", .x, paste0(nm, "__", .x)))
         })) %>% mutate(side = side, window = wn)
}
off_rows <- list(); def_rows <- list()
for (wn in names(win_cp)) {
  off_rows[[wn]] <- flatten_team(psi_offense_team_profile(win_cp[[wn]], PSI), "offense", wn)
  def_rows[[wn]] <- flatten_team(psi_defense_team_profile(win_cp[[wn]], PSI), "defense", wn)
}
offense_team_profile <- bind_rows(off_rows) %>% filter(!is.na(team), team != "")
defense_team_profile <- bind_rows(def_rows) %>% filter(!is.na(team), team != "")

# per-column availability map (spec §16: not one state for the whole profile)
off_avail <- c(live = "LIVE_CAPABLE", target_area = "LIVE_CAPABLE", rush_area = "LIVE_CAPABLE",
               formation = "PRIOR_ONLY", ftn = "DESCRIPTIVE_ONLY", box_faced = "PRIOR_ONLY")
def_avail <- c(live = "LIVE_CAPABLE", man_zone = "PRIOR_ONLY", coverage_family = "PRIOR_ONLY",
               pressure = "PRIOR_ONLY", box = "PRIOR_ONLY")

# =======================================================================
# ARCHETYPE VECTORS (spec §21) — numeric primary, labels only if stable
# =======================================================================
message("archetype vectors ...")
qb_dir   <- serve("qb_directional.csv")
qb_mx    <- serve("qb_spatial_matrix.csv")
qb_press <- serve("qb_pressure_profile.csv")
qb_con   <- serve("qb_concept_profile.csv")
qb_vec <- psi_qb_archetype_vector(qb_dir, qb_mx, qb_press, qb_con)

# defense archetype vector from Tier C team-defense + Tier A vulnerability map
def_vuln <- serve("defense_pass_vulnerability.csv") %>% filter(window == "career")
def_vuln_wide <- def_vuln %>%
  mutate(cell = paste0(tolower(depth_bin), "_", tolower(field_third))) %>%
  group_by(team) %>%
  summarise(deep_epa_allowed = mean(epa_per_target_allowed[depth_bin == "DEEP"], na.rm = TRUE),
            middle_epa_allowed = mean(epa_per_target_allowed[field_third == "MIDDLE"], na.rm = TRUE),
            explosive_allowed = mean(explosive_rate_allowed, na.rm = TRUE), .groups = "drop")
def_c <- defense_team_profile %>% filter(window == "career") %>%
  transmute(team,
            man_rate = man_zone__man_rate,
            blitz_proxy_rate = pressure__blitz_proxy_rate,
            pressure_rate_generated = pressure__pressure_rate_generated,
            heavy_box_rate = box__heavy_box_rate,
            epa_allowed = live__epa_per_play_allowed) %>%
  left_join(def_vuln_wide, by = "team")

qb_clust  <- psi_cluster_with_stability(qb_vec %>% rename(gsis_id = gsis_id), k = 4)
def_clust <- psi_cluster_with_stability(def_c %>% rename(gsis_id = team), k = 4)

qb_archetype_vector <- qb_vec %>%
  { if (!is.null(qb_clust$labels)) left_join(., qb_clust$labels, by = "gsis_id")
    else mutate(., archetype_cluster = NA_integer_) } %>%
  mutate(archetype_label_status = qb_clust$note, vector_version = PSI$TENDENCY_VERSION)
defense_archetype_vector <- def_c %>% rename(team = team) %>%
  { if (!is.null(def_clust$labels)) left_join(., def_clust$labels %>% rename(team = gsis_id), by = "team")
    else mutate(., archetype_cluster = NA_integer_) } %>%
  mutate(archetype_label_status = def_clust$note, vector_version = PSI$DEFENSE_VERSION)

write_json(list(audit = "psi-tierC-archetype-stability-2026.1",
                qb = list(k = 4, mean_ari = qb_clust$mean_ari, note = qb_clust$note,
                          labels_emitted = !is.null(qb_clust$labels), n = nrow(qb_vec)),
                defense = list(k = 4, mean_ari = def_clust$mean_ari, note = def_clust$note,
                               labels_emitted = !is.null(def_clust$labels), n = nrow(def_c)),
                policy = "Numeric vectors always ship. Cluster labels emitted only if mean bootstrap ARI >= 0.55 (spec §22)."),
           file.path(PSI$OUT_DIR, "tierC_archetype_stability.json"), auto_unbox = TRUE, pretty = TRUE)
message(sprintf("  QB cluster ARI=%.2f (%s) | DEF cluster ARI=%.2f (%s)",
                qb_clust$mean_ari, if (is.null(qb_clust$labels)) "labels withheld" else "labels emitted",
                def_clust$mean_ari, if (is.null(def_clust$labels)) "labels withheld" else "labels emitted"))

# =======================================================================
# SCHEME-ERA MECHANISM (spec §20) — coordinator identity NOT available
# =======================================================================
message("scheme-era mechanism ...")
starting_qb <- reg %>% filter(!is.na(passer_player_id)) %>%
  psi_asof(SEASON, WEEK) %>%
  group_by(season, team = toupper(posteam)) %>%
  count(passer_player_id) %>% slice_max(n, n = 1, with_ties = FALSE) %>%
  ungroup() %>% select(season, team, starting_qb = passer_player_id)
coord_yaml <- tryCatch(yaml::read_yaml(PSI$COORD_YAML), error = function(e) list(entries = list()))
n_coord_entries <- length(coord_yaml$entries %||% list())
scheme_era <- starting_qb %>%
  arrange(team, season) %>% group_by(team) %>%
  mutate(prior_qb = lag(starting_qb),
         starting_qb_changed = !is.na(prior_qb) & starting_qb != prior_qb,
         coordinator_known = FALSE,          # coordinators.yaml is empty (spec §20)
         scheme_reset_hint = starting_qb_changed,   # where a reset/heavy shrink WOULD apply
         prior_weight_multiplier = ifelse(starting_qb_changed, 0.6, 1.0)) %>%
  ungroup()

# =======================================================================
# RECONCILIATION (Tier C gate)
# =======================================================================
message("reconciliation ...")
r <- list()
r$offense_32_teams <- n_distinct(filter(offense_team_profile, window == "career")$team) == 32
r$defense_32_teams <- n_distinct(filter(defense_team_profile, window == "career")$team) == 32
# man_rate + zone_rate ~ 1 per team (charted only, 2 categories)
mz <- defense_team_profile %>% filter(window == "career", !is.na(man_zone__man_rate))
r$def_man_zone_sums_to_1_max_err <- if (nrow(mz)) max(abs(mz$man_zone__man_rate + mz$man_zone__zone_rate - 1)) else 0
# target-area distribution sums to 1
ta <- offense_team_profile %>% filter(window == "career", !is.na(target_area__tgt_left))
r$off_lmr_sums_to_1_max_err <- if (nrow(ta)) max(abs(ta$target_area__tgt_left + ta$target_area__tgt_middle + ta$target_area__tgt_right - 1)) else 0
r$off_depth_sums_to_1_max_err <- if (nrow(ta)) max(abs(ta$target_area__tgt_behind_los + ta$target_area__tgt_short + ta$target_area__tgt_intermediate + ta$target_area__tgt_deep - 1)) else 0
# archetype vectors always shipped
r$qb_vectors_shipped <- nrow(qb_archetype_vector) > 0
r$def_vectors_shipped <- nrow(defense_archetype_vector) == 32
r$labels_only_if_stable <- (is.null(qb_clust$labels) || qb_clust$mean_ari >= 0.55) &&
  (is.null(def_clust$labels) || def_clust$mean_ari >= 0.55)
# scheme-era: coordinator identity honestly absent, not guessed
r$coordinator_not_guessed <- all(scheme_era$coordinator_known == FALSE) && n_coord_entries == 0
# FI untouched (structural — this script never writes lib/football-intel)
r$fi_untouched <- !any(grepl("football-intel", c(list.files(PSI$SERVE_DIR))))
served <- list(offense_team_profile, defense_team_profile, qb_archetype_vector,
               defense_archetype_vector, scheme_era)
served_hash <- digest::digest(served, algo = "sha256")
r$served_content_sha256 <- served_hash
r$all_pass <- isTRUE(r$offense_32_teams) && isTRUE(r$defense_32_teams) &&
  r$def_man_zone_sums_to_1_max_err < 1e-9 && r$off_lmr_sums_to_1_max_err < 1e-9 &&
  r$off_depth_sums_to_1_max_err < 1e-9 && isTRUE(r$qb_vectors_shipped) &&
  isTRUE(r$def_vectors_shipped) && isTRUE(r$labels_only_if_stable) &&
  isTRUE(r$coordinator_not_guessed)
write_json(c(list(reconciliation = "psi-tierC-reconciliation-2026.1", season = SEASON, week = WEEK), r),
           file.path(PSI$OUT_DIR, "tierC_reconciliation.json"), auto_unbox = TRUE, pretty = TRUE)
message(sprintf("  reconciliation all_pass = %s", r$all_pass))

# =======================================================================
# MANIFEST MERGE + WRITE
# =======================================================================
mpath <- file.path(PSI$SERVE_DIR, "player_scheme_manifest.json")
manifest <- jsonlite::fromJSON(mpath, simplifyVector = TRUE)
manifest$tiers <- c("A", "B", "C")
manifest$tier_c <- list(
  built_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
  tendency_version = PSI$TENDENCY_VERSION, defense_version = PSI$DEFENSE_VERSION,
  offense_column_availability = as.list(off_avail),
  defense_column_availability = as.list(def_avail),
  archetype = list(
    qb_mean_ari = qb_clust$mean_ari, qb_labels_emitted = !is.null(qb_clust$labels),
    def_mean_ari = def_clust$mean_ari, def_labels_emitted = !is.null(def_clust$labels),
    policy = "numeric vectors always shipped; labels only if bootstrap ARI >= 0.55 (spec §22)"),
  scheme_era = list(
    coordinator_identity_available = FALSE,
    coordinators_yaml_entries = n_coord_entries,
    mechanism = "starting-QB-change breakpoint + prior_weight_multiplier hook; a sourced coordinators.yaml entry would add a coordinator reset (spec §20). Limitation documented, not guessed."),
  reconciliation_all_pass = r$all_pass,
  served_content_sha256 = served_hash,
  does_not_modify_football_intel = TRUE,
  files = c("offense_team_profile.csv", "defense_team_profile.csv", "qb_archetype_vector.csv",
            "defense_archetype_vector.csv", "scheme_era.csv"),
  notes = c(
    "Team profiles are DESCRIPTIVE TENDENCY primitives; the opponent-adjusted MODELED EPA/PROE/pace/pressure/explosive/RZ ratings remain owned by the frozen Football Intelligence engine (not duplicated, not rewired).",
    "Per-COLUMN availability (offense_column_availability / defense_column_availability): a team profile mixes LIVE_CAPABLE (pbp) with PRIOR_ONLY (participation) and DESCRIPTIVE_ONLY (FTN) columns (spec §16).",
    "Archetype numeric vectors ship regardless of label stability; cluster labels are withheld when unstable (spec §22).",
    "Coordinator identity is not available (coordinators.yaml empty) — scheme-era handling uses a starting-QB-change breakpoint and documents the limitation (spec §20)."
  )
)
write(jsonlite::toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, null = "null"), mpath)

w_csv <- function(df, name) write.csv(as.data.frame(df), file.path(PSI$SERVE_DIR, name), row.names = FALSE, na = "")
w_csv(offense_team_profile, "offense_team_profile.csv")
w_csv(defense_team_profile, "defense_team_profile.csv")
w_csv(qb_archetype_vector, "qb_archetype_vector.csv")
w_csv(defense_archetype_vector, "defense_archetype_vector.csv")
w_csv(scheme_era, "scheme_era.csv")

message("\nTier C built.")
message(sprintf("  offense_team_profile   %d rows | defense_team_profile %d rows", nrow(offense_team_profile), nrow(defense_team_profile)))
message(sprintf("  qb_archetype_vector    %d QBs (labels: %s)", nrow(qb_archetype_vector),
                if (is.null(qb_clust$labels)) "withheld — unstable" else "emitted"))
message(sprintf("  defense_archetype_vector %d teams | scheme_era %d team-seasons", nrow(defense_archetype_vector), nrow(scheme_era)))
message(sprintf("  reconciliation: %s", if (r$all_pass) "ALL PASS" else "FAILURES — see tierC_reconciliation.json"))
