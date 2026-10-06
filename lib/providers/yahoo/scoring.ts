/**
 * Yahoo stat-category → canonical scoring-key mapping.
 *
 * The canonical scoring vocabulary (`pass_yd`, `pass_td`, `rec`, `fgm_20_29`, …)
 * is Sleeper's own scoring-settings key set — see `lib/scoring/catalog.ts`. Yahoo
 * has no equivalent short keys; it exposes a `stat_categories` collection (each
 * stat carrying a numeric `stat_id` plus human-readable `name`/`display_name`)
 * and a separate `stat_modifiers` collection (`stat_id` -> point value).
 *
 * Yahoo `stat_id` numbers are NOT hard-coded here as the join key: a numeric id
 * that silently drifted between game keys (or was simply misremembered) would
 * misattribute a scoring rule to the wrong stat with no visible signal — exactly
 * the failure mode the honesty contract forbids. Instead, each stat's Yahoo
 * `name` (its `display_name` as a fallback) is matched, case/whitespace
 * normalized, against a table of Yahoo's documented category names. A stat
 * whose name is not in the table is NEVER guessed at: it is preserved verbatim
 * under a namespaced `yahoo_stat_<id>` key (inert to `calculateFantasyPoints`,
 * which only ever multiplies a key it recognizes) and reported as an explicit
 * warning so it stays visible rather than silently dropped or misapplied.
 */

function normalizeStatName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9+]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Yahoo's documented NFL stat-category names -> the canonical (Sleeper-vocabulary)
 * scoring key. Source: Yahoo Fantasy Sports API `stat_categories` for the `nfl`
 * game (names are stable across season game keys). Extend conservatively —
 * every addition here changes what scoring rule a league fingerprint captures.
 */
const YAHOO_STAT_NAME_TO_CANONICAL_RAW: Record<string, string> = {
  // Passing
  "passing yards": "pass_yd",
  "passing touchdowns": "pass_td",
  interceptions: "pass_int",
  "interceptions thrown": "pass_int",
  "2-point conversions (passing)": "pass_2pt",
  "passing 2-point conversions": "pass_2pt",

  // Rushing
  "rushing attempts": "rush_att",
  "rushing yards": "rush_yd",
  "rushing touchdowns": "rush_td",
  "2-point conversions (rushing)": "rush_2pt",
  "rushing 2-point conversions": "rush_2pt",

  // Receiving
  receptions: "rec",
  "receiving yards": "rec_yd",
  "receiving touchdowns": "rec_td",
  targets: "rec_tgt",
  "2-point conversions (receiving)": "rec_2pt",
  "receiving 2-point conversions": "rec_2pt",

  // Return / misc offense
  //
  // "Return Yards" is not a one-to-one name: it is the SUM of kick + punt
  // return yardage, for players (position_type O) or team defense (DT). It is
  // handled by YAHOO_COMBINED_CATEGORIES below, which needs Yahoo's
  // position_type to pick kr_yd+pr_yd vs def_kr_yd+def_pr_yd; without it the
  // category stays yahoo_stat_<id> + warning.
  "return touchdowns": "st_td",
  "offensive fumble return td": "fum_rec_td",
  "fumbles lost": "fum_lost",
  fumbles: "fum",

  // Kicking
  "field goals 0-19 yards": "fgm_0_19",
  "field goals 20-29 yards": "fgm_20_29",
  "field goals 30-39 yards": "fgm_30_39",
  "field goals 40-49 yards": "fgm_40_49",
  "field goals 50-59 yards": "fgm_50_59",
  "field goals 60+ yards": "fgm_60p",
  "field goals 50+ yards": "fgm_50p",
  "field goal missed 0-19 yards": "fgmiss_0_19",
  "field goal missed 20-29 yards": "fgmiss_20_29",
  "field goal missed 30-39 yards": "fgmiss_30_39",
  "field goal missed 40-49 yards": "fgmiss_40_49",
  "field goal missed 50+ yards": "fgmiss_50p",
  // Yahoo's live category names use the plural "Field Goals Missed …" (observed
  // in production Maclin settings); same buckets as the singular spellings above.
  "field goals missed 0-19 yards": "fgmiss_0_19",
  "field goals missed 20-29 yards": "fgmiss_20_29",
  "field goals missed 30-39 yards": "fgmiss_30_39",
  "field goals missed 40-49 yards": "fgmiss_40_49",
  "field goals missed 50+ yards": "fgmiss_50p",
  "extra points made": "xpm",
  "point after attempt made": "xpm",
  "point after attempt missed": "xpmiss",

  // Team defense / special teams
  sack: "sack",
  sacks: "sack",
  // Yahoo's official NFL stat categories use singular "Interception" for the
  // defense stat (distinct from offense's "Interceptions Thrown").
  interception: "int",
  // "Interception Returns" is deliberately NOT mapped. It is ambiguous
  // between a COUNT of interceptions (the "int" bucket, same concept as
  // "Interceptions" used for the passer's thrown picks elsewhere in this
  // table) and interception RETURN YARDAGE (the canonical catalog's distinct
  // int_ret_yd key). Guessing either risks scoring a yardage stat as a
  // per-turnover count or vice versa. Falls through to yahoo_stat_<id> +
  // warning until a live Yahoo response disambiguates it.
  "fumble recovery": "fum_rec",
  "fumble recoveries": "fum_rec",
  "fumble return touchdowns": "fum_rec_td",
  "forced fumbles": "ff",
  safeties: "safe",
  safety: "safe",
  "block kick": "blk_kick",
  "blocked kicks": "blk_kick",
  touchdown: "def_td",
  "defensive touchdowns": "def_td",
  "kickoff and punt return touchdowns": "st_td",
  "points allowed": "pts_allow",
  "points allowed 0 points": "pts_allow_0",
  "points allowed 1-6 points": "pts_allow_1_6",
  "points allowed 7-13 points": "pts_allow_7_13",
  "points allowed 14-20 points": "pts_allow_14_20",
  "points allowed 21-27 points": "pts_allow_21_27",
  "points allowed 28-34 points": "pts_allow_28_34",
  "points allowed 35+ points": "pts_allow_35p",
  "extra point returned": "def_2pt",
  // "Yards Allowed" is deliberately NOT mapped to pts_allow (points allowed
  // is a materially different concept from yards allowed) or to any of the
  // canonical yds_allow_* bucket keys (yds_allow_0_100 ... yds_allow_550p):
  // a generic "Yards Allowed" name does not itself say which bucket
  // threshold Yahoo means. Falls through to yahoo_stat_<id> + warning until
  // live Rogers Park settings prove the exact Yahoo semantics.
};

// Normalize the table with the SAME function used on Yahoo's live names. This
// matters for punctuation-heavy categories such as "Points Allowed 1-6
// points": the live name normalizes to "points allowed 1 6 points", so an
// un-normalized literal table would miss despite containing the right concept.
const YAHOO_STAT_NAME_TO_CANONICAL: Record<string, string> = Object.fromEntries(
  Object.entries(YAHOO_STAT_NAME_TO_CANONICAL_RAW).map(([name, key]) => [normalizeStatName(name), key]),
);

export interface YahooStatCategory {
  stat_id: string;
  name: string | null;
  display_name: string | null;
  /** Yahoo `position_type`: "O" offense, "K" kicker, "DT" team defense, "DP" defensive player. */
  position_type?: string | null;
}

/**
 * Yahoo categories that are the exact SUM of several canonical buckets. Applying
 * the same per-unit value to every bucket scores identically to Yahoo
 * (points = value x (a + b + ...) = value x a + value x b + ...). Expansion
 * never overwrites a bucket the league already scores via a more specific
 * category, and a category whose scope depends on `position_type` stays
 * unmapped (warning) when the position type is absent or unexpected.
 */
const YAHOO_COMBINED_CATEGORIES: Record<string, (positionType: string | null) => string[] | null> = {
  // Generic offensive 2-PT conversions: Yahoo credits every involved player
  // (passer, receiver, rusher), exactly the canonical pass/rec/rush split.
  [normalizeStatName("2-Point Conversions")]: (pt) => (pt === null || pt === "O" ? ["pass_2pt", "rush_2pt", "rec_2pt"] : null),
  // Return yardage = kickoff + punt return yards; player (O) vs team defense (DT).
  [normalizeStatName("Return Yards")]: (pt) =>
    pt === "O" ? ["kr_yd", "pr_yd"] : pt === "DT" ? ["def_kr_yd", "def_pr_yd"] : null,
};

export interface YahooStatModifier {
  stat_id: string;
  value: number;
}

export interface MappedYahooScoring {
  /** Canonical-keyed scoring map, ready for `raw_scoring` / `scoring_rules`. */
  raw_scoring: Record<string, number>;
  /** Yahoo stats whose name did not match the known table. Never dropped silently. */
  unmapped: Array<{ stat_id: string; name: string | null; value: number }>;
}

/**
 * Join `stat_categories` (id -> name) with `stat_modifiers` (id -> point value)
 * and translate every recognized name to its canonical key. Unrecognized stats
 * are kept, namespaced, in `raw_scoring` (inert to the scoring engine, which
 * ignores keys it doesn't recognize) AND listed in `unmapped` so callers can
 * emit a warning.
 */
export function mapYahooScoringSettings(
  categories: YahooStatCategory[],
  modifiers: YahooStatModifier[],
): MappedYahooScoring {
  const nameById = new Map<string, string | null>();
  const positionTypeById = new Map<string, string | null>();
  for (const c of categories) {
    nameById.set(c.stat_id, c.name ?? c.display_name);
    positionTypeById.set(c.stat_id, c.position_type ?? null);
  }

  const raw_scoring: Record<string, number> = {};
  const unmapped: MappedYahooScoring["unmapped"] = [];
  const combined: Array<{ m: YahooStatModifier; name: string; keys: string[] }> = [];

  // Pass 1: one-to-one names. Pass 2 (below) expands combined categories only
  // into buckets pass 1 did not already set, so a specific category always wins.
  for (const m of modifiers) {
    if (!Number.isFinite(m.value) || m.value === 0) continue;
    const name = nameById.get(m.stat_id) ?? null;
    const normalized = name ? normalizeStatName(name) : null;
    const canonicalKey = normalized ? YAHOO_STAT_NAME_TO_CANONICAL[normalized] : undefined;
    const expand = normalized ? YAHOO_COMBINED_CATEGORIES[normalized] : undefined;
    const keys = !canonicalKey && expand ? expand(positionTypeById.get(m.stat_id) ?? null) : null;
    if (canonicalKey) {
      raw_scoring[canonicalKey] = m.value;
    } else if (keys && name) {
      combined.push({ m, name, keys });
    } else {
      raw_scoring[`yahoo_stat_${m.stat_id}`] = m.value;
      unmapped.push({ stat_id: m.stat_id, name, value: m.value });
    }
  }
  for (const { m, keys } of combined) {
    for (const k of keys) if (!(k in raw_scoring)) raw_scoring[k] = m.value;
  }

  return { raw_scoring, unmapped };
}
