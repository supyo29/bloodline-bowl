#!/usr/bin/env Rscript
# ===========================================================================
# Checkpoint C — route-aware vs route-agnostic corroboration check (spec §32).
#
#   Rscript analysis/player_role/route_corroboration_check.R
#
# Question: among target_share EXPANSION events (same materiality rule the
# live model uses), does corroborating route_participation movement predict
# GREATER persistence into the next game than uncorroborated expansions?
# Restricted to 2016+ (participation data only exists from then).
# ===========================================================================
suppressWarnings(suppressMessages({ library(dplyr) }))
BASE <- file.path(getwd(), "analysis", "player_role")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_recency_backtest.R"))
source(file.path(BASE, "lib_role_profile.R"))

pgr <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds")) %>%
  filter(season >= 2016, season < 2026, position %in% c("WR", "TE"))

ts_bt <- run_recency_backtest(pgr, "target_share", min_games = 2) %>%
  transmute(gsis_id, season, week, position, actual_next, latest_ts = latest_game, recent_ts = ewma_hl2)
rp_bt <- run_recency_backtest(pgr, "route_participation", min_games = 2) %>%
  transmute(gsis_id, season, week, latest_rp = latest_game, recent_rp = ewma_hl2)

joined <- ts_bt %>% inner_join(rp_bt, by = c("gsis_id", "season", "week")) %>%
  mutate(
    delta_ts = latest_ts - recent_ts,
    delta_rp = latest_rp - recent_rp,
    ts_expanding = delta_ts >= ROLE$MIN_SHARE_DELTA,
    rp_corroborates = !is.na(delta_rp) & delta_rp > 0,
    persisted = actual_next >= (recent_ts + 0.5 * delta_ts)
  )

events <- joined %>% filter(ts_expanding)
cat(sprintf("target_share EXPANSION events (2016-2025, WR/TE, delta >= %.2f): %d\n", ROLE$MIN_SHARE_DELTA, nrow(events)))

summ <- events %>% group_by(rp_corroborates) %>%
  summarise(n = dplyr::n(), pct_persisted = round(100 * mean(persisted), 1), mean_next_game_error = round(mean(abs(actual_next - latest_ts)), 4), .groups = "drop")
cat("\nPersistence by route-corroboration status:\n")
print(summ)

cat(sprintf("\nCoverage: route_participation was non-NA (usable at all) for %d of %d target_share-eligible rows (%.1f%%)\n",
           sum(!is.na(joined$delta_rp)), nrow(joined), 100 * mean(!is.na(joined$delta_rp))))

write.csv(summ, file.path(ROLE$CACHE_DIR, "route_corroboration_check.csv"), row.names = FALSE)
