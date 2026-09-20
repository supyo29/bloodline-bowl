# Player Role & Opportunity Intelligence — Deferred Infrastructure Defects

Living record of latent defects discovered in shared (Phase-1-adjacent) infrastructure while building Phase 2. Phase 2 routes around each of these without modifying the shared code; none has been fixed in place, per each checkpoint's explicit scope boundary. Maintained across checkpoints — do not delete prior entries when adding new ones.

---

## 1. `fetch_raw.R` schedules cache silently excludes all postseason games

- **Location:** `analysis/football_intel/fetch_raw.R`, the `schedules <- cache("schedules", { ... filter(game_type %in% c("REG", "POST")) ... })` line.
- **Impact:** nflreadr's actual postseason `game_type` values are `"WC"/"DIV"/"CON"/"SB"`, never the literal string `"POST"` — the filter has always matched zero playoff games. Invisible to Football Intelligence itself (it reads PBP directly for team/usage profiles, only using schedules for week-completion bookkeeping). Would silently break any new consumer that joins through `schedules.rds` for opponent identity or playoff-game context.
- **Phase 2 workaround:** `build_player_game.R`'s `.opponent_map()` derives opponent directly from PBP's own `posteam`/`defteam` columns instead of joining through schedules. Checkpoint C's role-profile backtest and live diagnostics also default to regular-season framing and do not depend on postseason schedule rows.
- **Recommended remediation:** fix the filter to `game_type %in% c("REG", "WC", "DIV", "CON", "SB")` (or equivalent) in a small, isolated PR against `fetch_raw.R`, with a regression test asserting `nrow(schedules %>% filter(game_type != "REG")) > 0` for any season with completed playoffs. Low urgency — no current production consumer is affected. Suggested owner: whoever next touches `fetch_raw.R` for an unrelated reason, or a dedicated small maintenance phase.

## 2. Raw PBP `return_team` field is never normalized

- **Location:** `analysis/football_intel/fetch_raw.R`'s `pbp <- cache("pbp", { ... })` block normalizes `posteam`/`defteam`/`home_team`/`away_team` via `FI$normalize_team()`, but not `return_team`.
- **Impact:** `return_team` still carries the pre-2016 `"LA"` code for the St. Louis/LA Rams instead of `"LAR"` (and potentially other stale aliases for other relocated/renamed franchises not checked in detail). Any consumer joining on `return_team` without normalizing it first will silently fork a team's return-game rows into two disjoint "teams."
- **Phase 2 workaround:** `build_player_game.R`'s `.player_return_evidence()` applies `FI$normalize_team()` to `return_team` itself before use.
- **Recommended remediation:** add `return_team = FI$normalize_team(return_team)` to `fetch_raw.R`'s existing `pbp` mutate block (one-line fix, same pattern already used for the other four columns). Low urgency, same reasoning as #1.

## 3. FI's `player_usage_profile.csv` mislabels `route_participation` as `OBSERVED` when the value is null

- **Location:** `lib/football-intel/data/player_usage_profile.csv`, `analysis/football_intel/lib_usage.R`'s `build_player_usage_profile()`.
- **Impact:** every 2026 `route_participation` row carries `output_class = "OBSERVED"` while `observed` is `NA` for all 1,200 rows, because the underlying `participation` raw source has not been published for 2026 yet (`nflreadr::load_participation(seasons = 2026)` returns a live 404). `output_class` is metadata about what KIND of value a field is *supposed to* represent, not a guarantee that a value exists — this is a real, exploitable gap: any future consumer that checks `output_class == "OBSERVED"` as a usability gate (rather than checking the value itself) would silently treat a null as real evidence.
- **Phase 2 workaround:** Phase 2 never reads `player_usage_profile.csv` at all (a hard architectural boundary set in Checkpoint B and re-verified structurally in Checkpoint C's test suite — `test-role-profile-invariants.R` test 14 greps Phase 2's own code to confirm no reference to the file exists). Phase 2's own substrate represents 2026 route data as genuinely `NULL`/`AVAILABLE_WITH_LAG`, never mislabeled.
- **Recommended remediation:** this one may be worth a small, dedicated, low-risk data-quality fix in `lib_usage.R` — either (a) suppress `output_class = "OBSERVED"` in favor of a distinct tag (e.g. `"UNAVAILABLE"` or `"SOURCE_NOT_YET_PUBLISHED"`) when the underlying raw source has zero rows for that season, or (b) add a `value_available: boolean` field alongside `output_class` so a consumer can check both. This should be scoped as its own small PR with its own tests, reviewed and merged independently of Phase 2's certification — not bundled into Phase 2's own commits, per the instruction to keep Phase 2 isolated from FI modifications. Medium priority: the risk is latent (no current consumer trips over it) but the fix is cheap and removes a real trap for the next person who builds against `player_usage_profile.csv`.

### Later correction to entry 3 (Phase 3.5B) — the original finding above is preserved unchanged

**Status: FIXED in the builder, the publish gate and the reader.** `lib_usage.R` now emits `output_class = MODELED` whenever
`observed` is absent (existing `OBSERVED | MODELED | DESCRIPTIVE_ONLY` vocabulary — no new class was invented);
`validate_snapshot.R` fails a candidate that labels an absent observation `OBSERVED`; and `lib/football-intel/read.ts`
(`usageOutputClass`) applies the same rule to any artifact still in circulation. An isolated rebuild against fresh
sources showed 6,584 rows change `OBSERVED → MODELED` (all with `observed = NA`, including all 1,210
`route_participation` rows) and none remain mislabelled. Entries 1 and 2 remain open and unchanged.

---

*Checkpoint history: entries 1-3 discovered during Checkpoint B (player-game substrate) and Checkpoint C (role profiles). No entries have required an in-scope fix in either checkpoint.*
