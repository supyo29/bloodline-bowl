/**
 * Draft Bridge — per-league profiles.
 *
 * The Bridge (the interactive draft-night board at `/bridge`) treats every
 * league as a completely separate draft environment. This file is the single
 * source of truth for each league's IDENTITY, RULES, and MODEL PROFILE — the
 * three things that must never be shared or inferred across leagues.
 *
 * What lives here is the frozen, human-authored config. Anything that can drift
 * on Sleeper (roster positions, draft order, scoring) is ALSO fetched live by
 * `lib/bridge/board.ts`, which compares the two and emits a warning on any
 * mismatch rather than silently trusting either side.
 *
 * IMPORTANT — model identity honesty:
 *   This repository does not contain a frozen projection/ranking/survival
 *   "candidate" artifact for either league. The `model` block below records
 *   what actually exists (Sleeper's own ordering + a hash of the league's live
 *   scoring) plus any owner-declared candidate id, explicitly marked
 *   `candidate_verified: false`. Nothing here fabricates a hash.
 */

export type DraftType = "snake" | "auction";

export interface BridgeManagerProfile {
  /** Stable handle for this manager within this league. */
  manager_key: string;
  /** Sleeper display name, as it appears in the live league. */
  display_name: string;
  /** Informal name the owner uses for themselves, when different. */
  also_known_as: string | null;
  sleeper_user_id: string;
  team_name: string | null;
  /** Live-confirmed roster id, or null if not yet resolvable. */
  roster_id: number | null;
  /**
   * Best-known draft slot. Pre-filled from Sleeper's live `draft_order` where
   * available; the Bridge UI always lets the user override and confirm it,
   * because a slot can still change before a draft locks.
   */
  draft_slot: number | null;
  draft_slot_source: "sleeper_draft_order" | "unconfirmed";
}

export interface BridgeModelProfile {
  /**
   * Owner-declared frozen-candidate id, or null. NOT verified against a repo
   * artifact — see `candidate_verified`.
   */
  candidate_id: string | null;
  candidate_verified: boolean;
  candidate_source:
    | "league_owner_declared_unverified"
    | "rosterintel_ranking_pack"
    | "none";
  /** Owner-declared survival engine id, or null. */
  survival_engine: string | null;
  /** Owner-declared hashes, kept verbatim and clearly marked as declared. */
  declared_projection_sha: string | null;
  declared_scoring_sha: string | null;
  declared_config_sha: string | null;
  /** The ranking source used when the user has not loaded their own file. */
  default_ranking_source: "sleeper_search_rank";
  notes: string;
}

export interface BridgeRosterRules {
  /** Full Sleeper roster-position list, e.g. ["QB","RB","RB",...,"BN","BN"]. */
  roster_positions: string[];
  /** Strict + flex starting slots as counts, e.g. { QB: 1, RB: 2, FLEX: 3 }. */
  starters: Record<string, number>;
  bench: number;
  reserve: number;
  /** Positions a FLEX slot accepts in this league. */
  flex_positions: string[];
}

export interface BridgeLeagueProfile {
  /** Distinct, snake_case league key. Never shared between leagues. */
  league_key: string;
  /** The `lib/leagues/registry.ts` key this profile maps to. */
  registry_key: string;
  /** Extra selectors that resolve to this profile (e.g. an owner nickname). */
  aliases: string[];
  /** Live Sleeper league name. */
  league_name: string;
  /** Label for the league selector and the always-visible active-league banner. */
  display_label: string;
  /** Compact ALL-CAPS label for the top bar. */
  short_label: string;
  season: number;
  platform: "sleeper";
  platform_league_id: string;
  platform_draft_id: string;
  previous_league_id: string | null;
  /**
   * Id of a vendored ranking pack (`lib/bridge/ranking-packs/`) that should
   * rank this league's board by default. `null` = rank by Sleeper `search_rank`.
   * A pack that fails validation falls back to Sleeper order with a loud flag —
   * it never silently ranks the wrong way.
   */
  ranking_pack_id: string | null;
  manager: BridgeManagerProfile;
  draft: {
    type: DraftType;
    team_count: number;
    rounds: number;
    /** ISO timestamp of the scheduled draft start. */
    starts_at: string;
  };
  roster_rules: BridgeRosterRules;
  model: BridgeModelProfile;
  opponent_modeling: {
    /**
     * When true, this manager's OWN historical drafting tendencies are excluded
     * from recommendation optimization — past behavior should not constrain the
     * current recommended strategy. (DarthMarker design decision, preserved.)
     */
    exclude_own_historical_profile: boolean;
    note: string;
  };
}

/** The Bridge schema version, embedded in every export for ChatGPT. */
export const BRIDGE_SCHEMA_VERSION = "bridge.snapshot.v1";

const PROFILES: BridgeLeagueProfile[] = [
  {
    league_key: "bloodline_bowl",
    registry_key: "bloodline-bowl",
    aliases: ["bloodline", "supyo29"],
    league_name: "Bloodline Bowl",
    display_label: "Bloodline Bowl",
    short_label: "BLOODLINE BOWL",
    season: 2026,
    platform: "sleeper",
    platform_league_id: "1395549281678532608",
    platform_draft_id: "1395549282349617152",
    previous_league_id: null,
    ranking_pack_id: null,
    manager: {
      manager_key: "supyo29",
      display_name: "supyo29",
      also_known_as: null,
      sleeper_user_id: "1308955807408230400",
      team_name: "Curry up & draft",
      roster_id: 1,
      // Sleeper's live draft_order currently puts supyo29 at slot 7. The
      // multi-league addendum referenced "Slot 12"; that is NOT what Sleeper
      // reports today, so the UI treats the slot as user-confirmable.
      draft_slot: 7,
      draft_slot_source: "sleeper_draft_order",
    },
    draft: {
      type: "snake",
      team_count: 12,
      rounds: 15,
      starts_at: "2026-09-02T02:00:00.000Z",
    },
    roster_rules: {
      roster_positions: [
        "QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF",
        "BN", "BN", "BN", "BN", "BN",
      ],
      starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DEF: 1 },
      bench: 5,
      reserve: 1,
      flex_positions: ["RB", "WR", "TE"],
    },
    model: {
      // Owner-declared in the multi-league addendum. No matching frozen
      // artifact exists in this repository, so it is recorded as declared and
      // unverified rather than fabricated as real.
      candidate_id: "bloodline_production_20260827113702",
      candidate_verified: false,
      candidate_source: "league_owner_declared_unverified",
      survival_engine: "canonical_stateful_survival_v1",
      declared_projection_sha:
        "f0eea7cfdd6cc1e4ebb0074ac363ca13fcc74b8615570a8b51217cd7751d3a65",
      declared_scoring_sha:
        "013307c2ec6564da5ee7430001ec89722df14fa8f1902b439eb10b43047b07fe",
      declared_config_sha:
        "148fca5b81008b4d65ed9c7d0a2c548c27d7f28283d6aae1ecd516bf5f1cdc8e",
      default_ranking_source: "sleeper_search_rank",
      notes:
        "candidate_id / survival_engine / declared_* hashes are owner-declared " +
        "from the multi-league addendum and are NOT verified against any " +
        "artifact in this repository. Live rankings default to Sleeper " +
        "search_rank; the user may load their own rankings file. The live " +
        "scoring hash the board computes each session is the authoritative " +
        "scoring identity for cross-checks.",
    },
    opponent_modeling: {
      exclude_own_historical_profile: false,
      note: "No opponent-history model is wired into the Bridge yet.",
    },
  },
  {
    league_key: "devoted_to_the_game",
    registry_key: "devoted-to-the-game",
    aliases: ["darthmarker", "mark", "devoted"],
    league_name: "Devoted to the Game",
    display_label: "DarthMarker — Devoted to the Game",
    short_label: "DARTHMARKER",
    season: 2026,
    platform: "sleeper",
    platform_league_id: "1389735763649761280",
    platform_draft_id: "1389735763649761281",
    previous_league_id: "1264616401079914496",
    ranking_pack_id: "darthmarker_2026",
    manager: {
      manager_key: "darthmarker",
      display_name: "DarthMarker",
      also_known_as: "Mark",
      sleeper_user_id: "1265419589680910336",
      team_name: "Confused Panzer",
      roster_id: 2,
      // Confirmed from Sleeper's live draft_order for draft 1389735763649761281.
      draft_slot: 4,
      draft_slot_source: "sleeper_draft_order",
    },
    draft: {
      type: "snake",
      team_count: 12,
      rounds: 16,
      starts_at: "2026-08-31T01:30:03.000Z",
    },
    roster_rules: {
      roster_positions: [
        "QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "FLEX", "K", "DEF",
        "BN", "BN", "BN", "BN", "BN",
      ],
      starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 3, K: 1, DEF: 1 },
      bench: 5,
      reserve: 2,
      flex_positions: ["RB", "WR", "TE"],
    },
    model: {
      // No DarthMarker draft model, ranking artifact, or survival engine
      // exists in this repository. Per the multi-league addendum this MUST NOT
      // silently fall back to Bloodline — the Bridge reports
      // DARTHMARKER_MODEL_PROFILE_MISSING wherever a frozen candidate is
      // required, and otherwise uses Sleeper's own ordering.
      candidate_id: "rosterintel_mark_darthmarker_v7",
      candidate_verified: true,
      candidate_source: "rosterintel_ranking_pack",
      survival_engine: null,
      declared_projection_sha: null,
      declared_scoring_sha: null,
      declared_config_sha: null,
      default_ranking_source: "sleeper_search_rank",
      notes:
        "Primary ranking source is the vendored DarthMarker ranking pack " +
        "(darthmarker_2026, Roster Intel v7 board), activated only when it " +
        "validates against live league identity, scoring, and roster rules. " +
        "If the pack fails to load or validate, the board falls back to " +
        "Sleeper search_rank and flags ranking_quality as FALLBACK — never " +
        "silently. No frozen survival/projection engine is ported here, and no " +
        "other league's model, scoring, or rankings may be applied.",
    },
    opponent_modeling: {
      exclude_own_historical_profile: true,
      note:
        "DarthMarker/Mark's own past drafting tendencies are excluded from " +
        "recommendation optimization by design — historical behavior should " +
        "not constrain the current recommended strategy.",
    },
  },
];

export function listBridgeProfiles(): BridgeLeagueProfile[] {
  return PROFILES.map((profile) => ({ ...profile }));
}

/** The league selected when the Bridge has no stored/explicit choice. */
export const DEFAULT_BRIDGE_LEAGUE_KEY = "bloodline_bowl";

/**
 * Resolve a selector to exactly one profile. Accepts the `league_key`, the
 * `registry_key`, or any configured alias — case-insensitively — and never
 * falls back to a different league on a miss (returns null instead).
 */
export function findBridgeProfile(
  selector: string | null | undefined,
): BridgeLeagueProfile | null {
  if (!selector) return null;
  const needle = selector.trim().toLowerCase();
  if (!needle) return null;

  for (const profile of PROFILES) {
    if (profile.league_key.toLowerCase() === needle) return { ...profile };
    if (profile.registry_key.toLowerCase() === needle) return { ...profile };
    if (profile.aliases.some((alias) => alias.toLowerCase() === needle)) {
      return { ...profile };
    }
  }
  return null;
}

/** Every distinct string that resolves to a profile, for validation messages. */
export function knownBridgeSelectors(): string[] {
  const selectors = new Set<string>();
  for (const profile of PROFILES) {
    selectors.add(profile.league_key);
  }
  return [...selectors].sort();
}
