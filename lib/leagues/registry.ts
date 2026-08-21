/**
 * Multi-league registry.
 *
 * This bridge fetches everything live from Sleeper per request — there is no
 * database and no background sync job, so "registering" a league here is
 * purely a naming/addressing convenience: it gives a stable, memorable `key`
 * (e.g. `devoted-to-the-game`) to a Sleeper `league_id`, and documents which
 * Sleeper account each league belongs to. A league never HAS to be listed
 * here to be reachable — any numeric Sleeper league id can be requested
 * directly via `?league=<id>` (see `resolveLeagueId` in `lib/sleeper/service.ts`)
 * — but a registry entry is what makes a league discoverable by name and
 * lets the status page and README describe it.
 *
 * Each configured league is completely isolated: every route resolves one
 * `league_id` per request and fetches that league's own scoring settings,
 * rosters, and matchups from Sleeper fresh. Nothing here merges data across
 * leagues; the only cross-league surface in this codebase is the shared
 * `/players/nfl` metadata cache, which is player identity, not scoring or
 * roster context, and carries no per-league state.
 *
 * To add another league: append one object to {@link LEAGUE_TARGETS} below.
 * No other file needs to change.
 */

export interface LeagueTarget {
  /** Stable, URL-safe handle used in `?league=<key>`. Lowercase, hyphenated. */
  key: string;
  /** Only Sleeper is supported today; kept explicit so a future provider is additive. */
  provider: "sleeper";
  /** The Sleeper league id this key resolves to. */
  league_id: string;
  /**
   * Fallback label for this bridge's own UI/logs. `/api/league` and friends
   * always prefer the live `name` Sleeper returns for the league itself —
   * this is never used to override that.
   */
  display_name: string;
  /** The Sleeper account that owns/commissions this league, for documentation. */
  sleeper_username: string | null;
  /** Sleeper user_id of `sleeper_username`, when known. */
  sleeper_user_id: string | null;
  /** Disabled entries are kept in source for record-keeping but never resolve. */
  enabled: boolean;
}

/**
 * The known leagues this bridge can address by name.
 *
 * Add a league by appending an entry — nothing else needs to change. `key`
 * must be unique; `league_id` is deduplicated by `provider:league_id` at load
 * time (see {@link getLeagueRegistry}), so listing the same Sleeper league
 * twice under two keys keeps only the first.
 */
const LEAGUE_TARGETS: LeagueTarget[] = [
  {
    key: "bloodline-bowl",
    provider: "sleeper",
    league_id: "1395549281678532608",
    display_name: "Bloodline Bowl",
    sleeper_username: "supyo29",
    sleeper_user_id: "1308955807408230400",
    enabled: true,
  },
  {
    key: "devoted-to-the-game",
    provider: "sleeper",
    league_id: "1389735763649761280",
    display_name: "Devoted to the Game",
    sleeper_username: "darthmarker",
    sleeper_user_id: "1265419589680910336",
    enabled: true,
  },
];

/** The registry key resolved when no `?league=` selector is given at all. */
export const DEFAULT_LEAGUE_KEY = "bloodline-bowl";

export interface LeagueRegistryResult {
  /** Enabled, deduplicated, validated targets — what routes may resolve. */
  targets: LeagueTarget[];
  /** Disabled entries, kept visible for `/api/health`-style introspection. */
  disabled: LeagueTarget[];
  /** Non-fatal problems found while loading the registry (never thrown). */
  warnings: string[];
}

function isValidLeagueId(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

/**
 * Validate, deduplicate, and split the static target list into
 * enabled/disabled buckets. A malformed entry (missing/non-numeric
 * `league_id`, empty `key`) is dropped with a warning rather than allowed to
 * crash route resolution — the same "fail safe, never throw" contract every
 * other config-shaped input in this bridge follows.
 *
 * Exported (not just used internally) so tests can exercise the validation
 * and deduplication rules against synthetic target lists — including
 * malformed entries, disabled entries, and duplicate league ids — without
 * depending on what happens to be in the real static list at test time.
 */
export function validateAndDedupeTargets(
  rawTargets: LeagueTarget[],
): LeagueRegistryResult {
  const warnings: string[] = [];
  const seenKeys = new Set<string>();
  const seenLeagueIds = new Set<string>();
  const targets: LeagueTarget[] = [];
  const disabled: LeagueTarget[] = [];

  for (const raw of rawTargets) {
    if (!raw.key || typeof raw.key !== "string") {
      warnings.push(`Dropped a league target with a missing or invalid key.`);
      continue;
    }
    if (!isValidLeagueId(raw.league_id)) {
      warnings.push(
        `Dropped league target "${raw.key}": league_id "${String(raw.league_id)}" is not a valid numeric Sleeper league id.`,
      );
      continue;
    }
    if (seenKeys.has(raw.key)) {
      warnings.push(`Dropped duplicate league target key "${raw.key}".`);
      continue;
    }
    const dedupeId = `${raw.provider}:${raw.league_id}`;
    if (seenLeagueIds.has(dedupeId)) {
      warnings.push(
        `Dropped league target "${raw.key}": ${raw.provider} league ${raw.league_id} is already registered under another key.`,
      );
      continue;
    }
    seenKeys.add(raw.key);
    seenLeagueIds.add(dedupeId);

    if (raw.enabled) {
      targets.push(raw);
    } else {
      disabled.push(raw);
    }
  }

  return { targets, disabled, warnings };
}

/** Validate and deduplicate the real, static league target list. */
export function getLeagueRegistry(): LeagueRegistryResult {
  return validateAndDedupeTargets(LEAGUE_TARGETS);
}

/**
 * Look up an enabled league target by its registry `key`. Disabled and
 * malformed entries never resolve here, even if the key matches.
 */
export function findLeagueTarget(key: string): LeagueTarget | null {
  const { targets } = getLeagueRegistry();
  return targets.find((target) => target.key === key) ?? null;
}

/** Every enabled target, for listing endpoints like the status page. */
export function listLeagueTargets(): LeagueTarget[] {
  return getLeagueRegistry().targets;
}
