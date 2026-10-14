# Frozen role-calibration vintage (2026 target week 3, WR only)

Why this exists: the automated `role-calibration: refresh inputs` workflow REPLACES `lib/role-calibration/data/role_profile_asof.csv` each week (it now holds target weeks 5-6 only), but the
statistical reproducibility test needs a profile whose target week HAS observed outcomes (so that "including the target week" is distinguishable from "strictly earlier").
That is only true for a frozen vintage, so the test reads this fixture instead of the moving file.

Derived (WR rows only; profiles of target week 3 and every observed game of those players) from commit `76f0423` (2026-09-30):
- `lib/role-calibration/data/role_profile_asof.csv`  -> `role_profile_asof_w3_wr.csv`  (254 rows)
- `lib/role-calibration/data/observed_role_game.csv` -> `observed_role_game_wr.csv`      (3164 rows)
Regenerate with `git show 76f0423:<path>` filtered as above. Never edit by hand.
