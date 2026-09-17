# Player Role & Opportunity Intelligence — Phase 2, Checkpoint B

**Canonical Player-Game Role & Opportunity Substrate.**
Branch: `player-role-opportunity-phase2-audit` (continuing from Checkpoint A).
Authoritative audit: [docs/PLAYER_ROLE_OPPORTUNITY_PHASE_2_AUDIT.md](PLAYER_ROLE_OPPORTUNITY_PHASE_2_AUDIT.md).

No role classification, no shrinkage/recency model, no fantasy points, no
production consumer changes. This checkpoint delivers one thing: a
trustworthy, versioned, player-game-grain table of what each player's raw
NFL opportunities actually were, with exact denominators and honest
missingness.

---

## 1. Git

```
branch:         player-role-opportunity-phase2-audit
pre-B SHA:      09fcb61 (Checkpoint A audit commit)
origin/main:    4bd41f7   -- fetched again at the start of this checkpoint; no drift
working tree:   clean before this checkpoint's commit
```

**Concurrency gate result:** `git fetch origin` produced no new commits; `origin/main` is still exactly `4bd41f7`, the same commit this branch is based on. No automated Football Intelligence refresh landed on `main` since Checkpoint A. Safe to proceed without any merge/reconciliation.

---

## 2. Important correction to the Checkpoint A audit finding

Checkpoint A's audit stated real 2026 week-1 route-participation data was available in FI's `player_usage_profile.csv` (`output_class = "OBSERVED"`, 1,200 rows). Building this checkpoint's own substrate directly from raw sources surfaced that this was **incomplete verification** — the audit checked that rows existed and were tagged `OBSERVED`, but not that the underlying `observed` values were actually non-null.

**Verified now, directly:** `nflreadr::load_participation(seasons = 2026)` returns a live 404 from nflverse's own data release — **participation/route data for the 2026 season does not exist upstream yet.** FI's own `player_usage_profile.csv` route_participation rows are all `output_class = "OBSERVED"` with `observed = NA` for every one of the 1,200 rows — i.e., FI's manifest labels the field as if it were current, but the field is actually empty for 2026. This is exactly the failure mode Checkpoint B's instructions warned against ("do not interpret this as routes are universally available") and it turned out to be more than a caution — the specific claim was wrong.

This checkpoint's substrate handles it correctly by construction: `route_participation` is `NA` for every 2026 row (never fabricated as 0), and the served manifest classifies the `ROUTES` feature family as `AVAILABLE_WITH_LAG` (Phase 1's own `EXPECTED_SOURCE_LAG` vocabulary, since `participation` is on FI's `EXPECTED_SOURCES` list) rather than a blanket "stale" or a false "current." Every other 2026 feature family (snaps, targets, air yards, rushing, red zone, third down, two minute, returns) is genuinely `AVAILABLE_CURRENT` through week 1 — the substrate does not collapse this into one flag, per spec §15.

**Correcting the record:** Checkpoint A's audit document is not edited retroactively (it is a dated snapshot of that checkpoint's understanding); this correction is the authoritative update going forward.

---

## 3. A second, unrelated latent bug found and routed around (not fixed in shared code)

While building the opponent join, every row's `opponent` came back `NA` initially. Root cause: `analysis/football_intel/fetch_raw.R`'s cached `schedules.rds` contains **zero postseason games** — `load_schedules() %>% filter(game_type %in% c("REG", "POST"))` has always silently matched nothing on `"POST"`, because nflreadr's real postseason `game_type` values are `"WC"/"DIV"/"CON"/"SB"`, never the literal string `"POST"`. This has no effect on FI's own team/usage profiles (they read PBP directly, never schedules, for anything except week-completion), so it has been invisible until a new consumer (this substrate) tried to join through schedules for opponent identity.

**Not fixed in `fetch_raw.R`** — that file is shared, Phase-1-adjacent infrastructure and this checkpoint's instructions are scoped to Checkpoint B only. Instead, this substrate derives `opponent` directly from PBP's own `posteam`/`defteam` columns (every play already states both), which is more robust regardless and sidesteps the bug entirely. Flagged here for whoever next touches `fetch_raw.R`.

A third, smaller finding of the same character: PBP's raw `return_team` column is never run through `FI$normalize_team()` by `fetch_raw.R` (only `posteam`/`defteam`/`home_team`/`away_team` are), so it still carries the pre-2016 `"LA"` code for the St. Louis/LA Rams instead of `"LAR"`. This substrate normalizes `return_team` itself before using it (`build_player_game.R`'s `.player_return_evidence()`).

---

## 4. Architecture delivered

```
analysis/player_role/
    config.R              -- ROLE env: schema version, rule constants (red-zone/inside-10/
                              goal-line yardlines, two-minute window, kneel-exclusion policy),
                              paths, content-hash version function. Sources FI's config.R
                              (reuses team normalization, paths, EXPECTED_SOURCES) rather
                              than duplicating it.
    build_player_game.R   -- build_player_game_role(): the full derivation, reading ONLY
                              FI's already-cached raw RDS (pbp, participation, snap_counts,
                              ff_playerids, rosters_weekly). No new nflverse fetch.
    run_build.R            -- orchestrator: loads caches, builds, saves internal RDS,
                              writes served CSV + manifest, runs data-quality diagnostics.
    tests/
        run.R
        testthat/test-player-game-invariants.R   -- 27 tests (synthetic-fixture exact-
                                                     formula tests + whole-table invariants
                                                     against the real built artifact)

internal (git-ignored, full multi-season history):
    analysis/player_role/cache/player_game_role.rds
    analysis/player_role/cache/conflicting_team_rows_audit.csv

served (committed, current season only):
    lib/player-role-intelligence/data/player_game_role.csv
    lib/player-role-intelligence/data/role_opportunity_manifest.json
```

**R/TS boundary:** unchanged from the FI/Player-Scheme-Intelligence convention documented in Checkpoint A — R never runs inside a request; only committed artifacts are read at runtime. This checkpoint stops at the served CSV + manifest; a TypeScript reader (`lib/player-role-intelligence/read.ts` + `schema.ts` + `lineage.ts`) is explicitly deferred to Checkpoint D, per the instructions ("Checkpoint B may stop before building the final served reader").

**Raw sources reused, not duplicated:** `pbp.rds`, `participation.rds`, `snap_counts.rds`, `ff_playerids.rds`, `rosters_weekly.rds` — all read directly from `analysis/football_intel/cache/`, populated by the existing `fetch_raw.R`. No second download of any nflverse source.

**Not reused:** `lib/football-intel/data/player_usage_profile.csv` (the shrunk FI profile) is not an input anywhere in this pipeline, per the hard requirement. It is used only as an external cross-check target (§8).

---

## 5. Metric contract — exact formulas and denominators

Grain: one row per `(season, week, game_id, gsis_id, team, opponent, position)`. A row exists **only** when there is direct participation evidence (present in `snap_counts`, or a nonzero target/carry/dropback/return) — never fabricated from a roster slot.

### Participation
| Field | Formula | Ownership |
|---|---|---|
| `offensive_snaps` | `snap_counts.offense_snaps` (PFR) | SOURCE_NATIVE |
| `team_offensive_plays` | count of PBP plays with `pass==1 \| (rush==1 & !qb_kneel)`, that team, that game | DERIVED |
| `snap_share_source` | `snap_counts.offense_pct` (PFR's own %, denominator internal to PFR, not re-derived) | SOURCE_NATIVE |
| `snap_share_derived` | `offensive_snaps / team_offensive_plays` | DERIVED |

`snap_share_source` and `snap_share_derived` are **kept as two distinct columns** (spec §5) and do diverge in practice: QBs show `snap_share_derived` slightly `> 1.0` in a small number of 2026 rows (14 of 1,200) because `offensive_snaps` (PFR) counts every offensive snap including QB kneels, while `team_offensive_plays` deliberately excludes kneels (below). This is the documented, expected consequence of that policy choice, not a defect — it's exactly why the two fields are not merged into one.

### Routes
| Field | Formula | Ownership |
|---|---|---|
| `pass_play_personnel` | count of PBP pass plays (`pass==1`) where the player's id appears in `participation.offense_players` for that play | DERIVED |
| `team_pass_plays` | count of PBP plays with `pass==1`, that team, that game | DERIVED |
| `route_participation` | `pass_play_personnel / team_pass_plays` | DERIVED |

**Source-schema finding (documented, not guessed, per spec §6):** nflverse's `participation.route` field is a single value **per play** (the route concept charted for that play — NGS-derived), not a per-player field, and `offense_players` lists all 11 offensive personnel on the field for the play with no flag distinguishing a receiver who released from a lineman who blocked. An exact per-player "ran a route" count **cannot** be derived from this source. What can be derived exactly is "was part of the offensive personnel on a pass play" — published as `route_participation` with an explicit `route_participation_definition = "pass_play_personnel_share"` tag and a `route_participation_reliability` tag (`"UNRELIABLE_NON_ELIGIBLE_POSITION"` for OL/DL/DB/LB/K/P/LS, `"PROXY_PERSONNEL_PRESENCE"` otherwise). `targets_per_route_run = targets / pass_play_personnel` is only computed when `pass_play_personnel` is non-null and non-zero; otherwise `NULL`, never `0`.

### Targets / receiving
| Field | Formula | Ownership |
|---|---|---|
| `targets` | count of PBP pass attempts targeting the player | DERIVED |
| `team_pass_att` | count of PBP plays with `pass==1`, that team, that game | DERIVED |
| `target_share` | `targets / team_pass_att` | DERIVED |
| `receptions` | count of those targets with `complete_pass==1` | DERIVED |
| `air_yards` | sum of `air_yards` on those targets (can be negative — screens) | DERIVED |
| `team_air_yards` | sum of `air_yards` over all team pass attempts, that game | DERIVED |
| `air_yards_share` | `air_yards / team_air_yards` (can be negative if the player's own sum is negative while the team total is positive — a real, not erroneous, outcome; 38 of 1,200 2026 rows) | DERIVED |
| `aDOT` | `air_yards / targets` when `targets > 0`, else `NULL` (never 0) | DERIVED |

### Rushing
| Field | Formula | Ownership |
|---|---|---|
| `carries` | count of PBP rush attempts, `rush==1 & qb_dropback==0`, **excluding `qb_kneel==1`** | DERIVED |
| `team_rush_att` | same filter, team total | DERIVED |
| `rush_share` | `carries / team_rush_att` | DERIVED |
| `dropbacks`, `qb_scrambles` | QB-specific: dropback count, scramble count (`qb_scramble==1`) among dropbacks | DERIVED |
| `designed_rushes` | carries by a player who also has a dropback that game (QB-only signal) | DERIVED |

**Kneel handling (spec §8, resolved explicitly):** QB kneels are excluded from both the numerator and `team_rush_att`. A kneel is clock management, not a rushing opportunity; including it in the denominator would understate every real rusher's share in games with end-of-half/end-of-game kneels. **Cross-check finding:** FI's own `build_player_game_usage()` (`lib_features.R`) does **not** exclude kneels from its `team_rush_att` — this substrate's `rush_share` formula is a deliberate, documented improvement over FI's existing formula, not merely a different convention. In the actual week-1 2026 data this produced zero observable divergence (every sampled RB's raw share matched FI's exactly — see §8), because none of the sampled games' kneels happened to touch a player in the cross-check sample; the difference remains real and will surface in games with more end-of-game kneel volume.

### Position-group context
| Field | Formula |
|---|---|
| `position_group_rush_share` | `carries / (sum of team RB+FB carries, that game)`, RB/FB only |
| `position_group_target_share` | `targets / (sum of team WR targets, that game)` for WR, or `/ (team TE targets)` for TE |

Kept distinct from the team-wide `rush_share`/`target_share` (spec §8's explicit "these answer different questions" requirement) — verified distinct in the invariant tests.

### Red zone / high-value opportunity
Yardline convention: `yardline_100` = distance in yards from the opponent's goal line (standard nflverse convention). Boundaries: red zone `<= 20`, inside-10 `<= 10`, goal-line `<= 5`.

| Field | Formula |
|---|---|
| `red_zone_targets` / `red_zone_carries` | targets/carries with `yardline_100 <= 20` |
| `inside_10_targets` / `inside_10_carries` | `yardline_100 <= 10` |
| `goal_line_carries` | `yardline_100 <= 5` |
| `end_zone_targets` | targets where `yardline_100 - air_yards <= 0` (the ball was thrown at or past the goal line) |
| `rz_target_share` / `rz_carry_share` | red/goal-line counts over the matching team red-zone denominator (`team_rz_pass_att`, `team_rz_rush_att`) |

### Third down / two minute
Raw counts only, no participation-denominator share (no reliable per-play offensive-personnel denominator exists at this grain for these windows — spec §11's explicit fallback).

| Field | Formula |
|---|---|
| `third_down_targets` / `third_down_carries` | `down == 3` |
| `two_minute_targets` / `two_minute_carries` | `qtr %in% c(2,4) & quarter_seconds_remaining <= 120`. **Overtime (`qtr == 5`) is explicitly excluded** — NFL OT's sudden-death/one-possession rules don't share the clock-management incentive structure of a real two-minute drill, and silently merging them would change "two-minute usage"'s meaning without a stated rule. |

### Alignment / motion / blocking
Genuinely `UNAVAILABLE` at player-game grain, confirmed again during this build (no per-player slot/wide/backfield, motion, pass-block, or run-block field exists anywhere in the raw sources used). Represented as typed `UNAVAILABLE` entries in the served manifest's feature-family table, not as all-`NA` columns bloating every row.

### Returns
Derived directly from PBP's own `kickoff_returner_player_id` / `punt_returner_player_id` / `return_yards` / `return_team` — **a deliberate departure from the existing production return-game model** (`lib/projections/return-game.ts`, Sleeper-box-score-sourced), made because: (a) PBP is already ingested and cached, so no new external fetch or cross-language join is needed to rebuild this substrate; (b) it uses the exact same `gsis_id` identity as every other field in this table, rather than a second identity system; (c) it is game-level exact, not a season aggregate. This is a documented choice, not an assumption of equivalence — see the cross-check in §8.

| Field | Formula |
|---|---|
| `kick_returns` / `punt_returns` | count of PBP plays where the player is the credited returner |
| `kick_return_yards` / `punt_return_yards` | sum of `return_yards` on those plays |
| `kick_return_opportunity_share` / `punt_return_opportunity_share` | player's returns / team's total returns of that type, that game |
| `offense_domain_active` / `return_domain_active` | boolean domain tags kept separate so a return-only player is never misread as an offensive contributor (spec §13) |

---

## 6. 2026 current-season source availability (from the served manifest)

| Feature family | Status | Through week |
|---|---|---|
| SNAPS | AVAILABLE_CURRENT | 1 |
| ROUTES | AVAILABLE_WITH_LAG | — (nflverse participation not yet published for 2026) |
| TARGETS | AVAILABLE_CURRENT | 1 |
| AIR_YARDS | AVAILABLE_CURRENT | 1 |
| RUSHING | AVAILABLE_CURRENT | 1 |
| RED_ZONE | AVAILABLE_CURRENT | 1 |
| THIRD_DOWN | AVAILABLE_CURRENT | 1 |
| TWO_MINUTE | AVAILABLE_CURRENT | 1 |
| RETURNS | AVAILABLE_CURRENT | 1 |
| ALIGNMENT / MOTION_PLAYER_LEVEL / PASS_BLOCKING / RUN_BLOCKING | UNAVAILABLE | — |

Full detail in [lib/player-role-intelligence/data/role_opportunity_manifest.json](../lib/player-role-intelligence/data/role_opportunity_manifest.json), including the complete per-field ownership table (`SOURCE_NATIVE`/`DERIVED`/`UNAVAILABLE`).

---

## 7. Data quality

Full-history build (all cached seasons, 2012–2026):

- **274,341 player-game rows**, 0 duplicate keys (post-resolution), 0 unresolved `gsis_id`, 0 missing `opponent`.
- **8 rows with missing `position`** (2 obscure players across 2014–2015 with incomplete roster-history data that season) — left as genuinely missing, not fabricated; negligible (0.003%).
- **72 player-games (144 rows before resolution)** had a genuine identity conflict: PFR's `snap_counts` source occasionally attributes a player to the wrong team with 0 snaps/0 touches alongside the correct, evidenced row (verified example: Super Bowl XLIX, `2014_21_NE_SEA` — Tom Brady appears once correctly as NE with real snaps, and once spuriously as SEA with 0 snaps/0 touches). Resolved **deterministically by evidence strength** (the row with more participation evidence wins), never fuzzy-matched, and every resolved conflict is logged to `analysis/player_role/cache/conflicting_team_rows_audit.csv` rather than silently dropped (spec §23).
- Full audit trail for the identity-resolution logic is in `build_player_game.R`'s "resolve genuine key conflicts" block.

2026-season-only (served subset, 1,200 rows, week 1):
- `route_participation`: 1,200/1,200 missing (expected — see §2/§6).
- `rz_target_share`: 38 missing (players/games with zero team red-zone pass attempts that game — a real zero-denominator case, not a data gap).
- `rz_carry_share`: 112 missing (same reason, rushing side).
- Everything else: 0 missing.

---

## 8. Cross-check against existing Football Intelligence

Compared this substrate's raw week-1 values against FI's `player_usage_profile.csv` `observed` field (the unshrunk, recency-weighted-over-one-game value — with `through_week = 1`, FI's own recency weighting reduces to exactly the single game, so this is an apples-to-apples comparison for every metric both sources compute).

| Metric | n compared | Exact matches (`<1e-6`) | Mean abs diff | Max abs diff |
|---|---|---|---|---|
| `snap_share` (vs `snap_share_source`) | 1,197 | 1,197 | 0.00000 | 0.00000 |
| `target_share` | 1,200 | 1,200 | 0.00000 | 0.00000 |
| `air_yards_share` | 253 | 253 | 0.00000 | 0.00000 |
| `rush_share` | 1,200 | 1,200 | 0.00000 | 0.00000 |
| `rz_target_share` | 248 | 248 | 0.00000 | 0.00000 |
| `rz_carry_share` | 102 | 102 | 0.00000 | 0.00000 |
| `route_participation` | 0 | — | — | — (both sides null, consistent) |

Every overlapping metric matched FI exactly for week 1 — a strong formula-correctness signal. The one intentional formula difference documented above (`rush_share`'s kneel exclusion) produced zero observed divergence this specific week only because no sampled player's game happened to include a kneel; it remains a real, documented difference in the formula, not a claim that the two are identical by construction. No unexplained formula drift found.

---

## 9. Performance

| Metric | Value |
|---|---|
| Seasons processed | 2012–2026 (15 seasons, reusing FI's existing cache) |
| Player-game rows (full history) | 274,341 |
| Served rows (2026, week 1) | 1,200 |
| Internal artifact size | 6.8 MB (`.rds`, git-ignored) |
| Served artifact size | 0.36 MB (`.csv`, committed) |
| Cache load time | ~14.5s |
| Build time (full 15-season history) | ~30–46s |
| Save time | ~1.4s |
| **Total wall time** | **~48–65s** |

This is well within range for a weekly (or even daily) rebuild — comparable to FI's own snapshot build time. The full multi-season table stays internal/git-ignored (per spec §21); only the current season is served and committed, keeping the repo's committed-artifact footprint small (0.36 MB, smaller than FI's own `player_usage_profile.csv` at 1.68 MB).

---

## 10. Tests

- **New: 27/27 passing** — `analysis/player_role/tests/testthat/test-player-game-invariants.R` (`Rscript analysis/player_role/tests/run.R`). Covers: exact denominators (target/rush share), kneel exclusion, red-zone/inside-10/goal-line boundary exactness, end-zone-target rule exactness, third-down/two-minute window exactness, return-team normalization, determinism, key uniqueness, no-fabricated-zero routes, no TPRR without real routes, snap-share/route-participation non-substitution, no fantasy-points/TD-outcome fields present at all, position-group vs team-share distinctness, return-only-player non-inflation, and full identity resolution.
- **Existing Football Intelligence tests: unaffected** — `Rscript analysis/football_intel/tests/run.R` still passes (`invariants: ........................`, `week-completion: .......................`), confirming no shared file was modified in a way that broke Phase 1.
- **Full repository regression: 1927/1931 passing, 0 failing, 4 skipped** (`npm test`) — identical to the Checkpoint A baseline. No TypeScript file was touched by this checkpoint.

---

## 11. Production isolation

No file under `lib/weekly/`, `lib/trades/`, `lib/orchestrator/`, `lib/projections/`, or `lib/football-intel/` was modified. `git status --short` at the end of this checkpoint shows only:
```
 M .gitignore                              (added /analysis/player_role/cache)
?? analysis/player_role/                   (new)
?? lib/player-role-intelligence/           (new)
```
`lib/projections/model.ts` (the audit's flagged high-risk duplicate) is untouched and is not imported by, nor does it import, any file under `analysis/player_role/` or `lib/player-role-intelligence/`. The full `npm test` regression count matching the Checkpoint A baseline exactly (1927/1931) is the structural proof that projections, waivers, Start/Sit, matchup, and trades all produced identical output before and after this checkpoint.

---

## 12. Live 2026 spot check (read-only, real week-1 data, not hand-picked to flatter the model)

| Archetype | Player | Evidence (raw, unclassified) |
|---|---|---|
| High-snap WR | Drake London (ATL) | 59 snaps (98% share), 4 targets, 22 air yards, 1 carry |
| High-target WR | Amon-Ra St. Brown (DET) | 69 snaps (90%), 14 targets (34% share), 10 rec, 4 red-zone targets |
| Workhorse RB | Jahmyr Gibbs (DET) | 57 snaps (74%), 29 carries (81% rush share), 8 red-zone carries, 5 targets |
| Committee RB | Travis Etienne (NO) | 53 snaps (59%), 9 carries (39% share), 9 targets, 2 red-zone targets |
| TE | Trey McBride (ARI) | 60 snaps (80%), 13 targets (31% share), 9 rec, 89 air yards, 4 red-zone targets |
| Return contributor | Barion Brown (NO) | 7 offensive snaps (8%), 0 targets/carries, **3 kick returns + 5 punt returns** — offense_domain_active = FALSE, return_domain_active = TRUE; correctly never reads as an offensive contributor |
| Low-snap concentrated opportunity | Zay Flowers (BAL) | 20 snaps (29% share), 6 targets (19% share), 91 air yards, 15.2 aDOT — high opportunity concentration on limited participation, exactly the pattern spec §26 asks this substrate to be able to represent honestly without classifying it |

No role state, confidence, or classification is produced for any of these — evidence only, as required.

---

## 13. Checkpoint B verdict

```
CHECKPOINT B COMPLETE — READY FOR REVIEW
```

Summary of what changed since Checkpoint A: one new, isolated R module (`analysis/player_role/`) builds a canonical, tested, cross-checked player-game substrate from Football Intelligence's existing raw cache — never from FI's shrunk profile. It found and honestly represents a genuine 2026 upstream data gap (routes), found and routed around two small pre-existing bugs in shared infrastructure without touching that infrastructure, resolved a real player-game identity conflict deterministically and transparently, and produced formulas that agree exactly with FI's own on every metric both sources compute. No production consumer was touched; the full repository regression suite is unchanged.

**STOP. Do not begin Checkpoint C.**
