/**
 * Multi-league, multi-provider registry (v2).
 *
 * A registry entry gives a stable, memorable `key` (slug) to a provider-native
 * league id, records which provider serves it, the season, and the known
 * manager contexts. Adding a league is one appended object — no route code
 * changes, and the analytical engine is provider-agnostic.
 *
 * BACKWARD COMPATIBILITY: the v1 fields (`league_id`, `display_name`,
 * `sleeper_username`, `sleeper_user_id`, `enabled`) are all still here with the
 * same meaning for Sleeper leagues, so `lib/sleeper/service.ts#resolveLeagueId`,
 * `parseLeagueSelector`, and every `?league=` route keep working unchanged. New
 * fields (`external_league_id`, `season`, `known_managers`) are additive.
 *
 * Isolation: every route resolves exactly ONE league per request and fetches
 * that league's own data from its own provider. Nothing here merges leagues.
 */

import type { ProviderName } from "@/lib/canonical/schema";

/** Human-facing readiness of a registry entry's provider integration. */
export type LeagueConfigStatus = "READY" | "AWAITING_CREDENTIALS" | "PROVIDER_UNIMPLEMENTED";

/**
 * Authored registry entry. The v1 fields are required; the v2 fields are
 * optional and filled by {@link normalizeEntry} (so hand-written and test
 * entries stay terse). {@link findLeagueTarget} / {@link listLeagueTargets}
 * always return the normalized form where every field is populated.
 */
export interface LeagueTarget {
  /** Stable, URL-safe handle. Lowercase, hyphenated. */
  key: string;
  /** Which provider serves this league. Drives adapter + auth selection. */
  provider: ProviderName;
  /**
   * Provider-native league id.
   *  - Sleeper: the numeric Sleeper `league_id`.
   *  - Yahoo:   the human-facing numeric league id (e.g. `82713`). The full
   *             `nfl.l.82713` game/league key is resolved and persisted once
   *             authenticated access exists — see `yahoo_league_key` below.
   */
  league_id: string;
  /** Alias of `league_id`, provider-neutral name used by canonical code. */
  external_league_id?: string;
  /** Fantasy season this entry addresses. Defaults to 2026. */
  season?: number;
  /** Fallback label for this bridge's own UI/logs; live provider name wins. */
  display_name: string;
  /**
   * Known manager slugs for this league. These are TEST FIXTURES for the
   * generic manager-context system — never hard-coded branches. Any other
   * manager still resolves generically via live provider lookup.
   */
  known_managers?: string[];
  /** Sleeper only: the account that commissions this league, for docs. */
  sleeper_username: string | null;
  /** Sleeper only: verified Sleeper `user_id` of `sleeper_username`. */
  sleeper_user_id: string | null;
  /** Yahoo only: full `game.l.id` key once resolved via the API. Null until then. */
  yahoo_league_key?: string | null;
  /** Disabled entries are kept in source for record-keeping but never resolve. */
  enabled: boolean;
}

/** Normalized registry entry — every field guaranteed present. */
export interface RegisteredLeague extends LeagueTarget {
  external_league_id: string;
  season: number;
  known_managers: string[];
  yahoo_league_key: string | null;
}

/**
 * The known leagues this bridge can address by name. Append to add a league.
 */
const LEAGUE_TARGETS: LeagueTarget[] = [
  {
    key: "bloodline-bowl",
    provider: "sleeper",
    league_id: "1395549281678532608",
    external_league_id: "1395549281678532608",
    season: 2026,
    display_name: "Bloodline Bowl",
    known_managers: ["supyo29", "bijimac"],
    sleeper_username: "supyo29",
    sleeper_user_id: "1308955807408230400",
    yahoo_league_key: null,
    enabled: true,
  },
  {
    key: "devoted-to-the-game",
    provider: "sleeper",
    league_id: "1389735763649761280",
    external_league_id: "1389735763649761280",
    season: 2026,
    display_name: "Devoted to the Game",
    known_managers: ["darthmarker"],
    sleeper_username: "darthmarker",
    sleeper_user_id: "1265419589680910336",
    yahoo_league_key: null,
    enabled: true,
  },
  {
    key: "maclin-on-chicks-xvi",
    provider: "yahoo",
    league_id: "82713",
    external_league_id: "82713",
    season: 2026,
    display_name: "Maclin on Chick's XVI",
    known_managers: [],
    sleeper_username: null,
    sleeper_user_id: null,
    // The human-facing id only. The real `game.l.id` key (e.g. `nfl.l.82713`)
    // MUST be resolved from the authenticated API before any Yahoo call trusts
    // it, and it may differ per season — the `key` slug stays stable regardless.
    yahoo_league_key: null,
    enabled: true,
  },
  {
    key: "rogers-park",
    provider: "yahoo",
    league_id: "287140",
    external_league_id: "287140",
    season: 2026,
    display_name: "Rogers Park",
    known_managers: [],
    sleeper_username: null,
    sleeper_user_id: null,
    // Human-facing id only; full provider key resolved post-auth. Independent of
    // maclin-on-chicks-xvi — a separate Yahoo league under the same provider.
    yahoo_league_key: null,
    enabled: true,
  },
];

/** The registry key resolved when no `?league=` selector is given at all. */
export const DEFAULT_LEAGUE_KEY = "bloodline-bowl";

export interface LeagueRegistryResult {
  targets: RegisteredLeague[];
  disabled: RegisteredLeague[];
  warnings: string[];
}

function isNumericId(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

/**
 * Validate, deduplicate, and split targets into enabled/disabled buckets.
 * Malformed entries are dropped with a warning rather than crashing route
 * resolution — the same "fail safe, never throw" contract as v1.
 */
export function validateAndDedupeTargets(rawTargets: LeagueTarget[]): LeagueRegistryResult {
  const warnings: string[] = [];
  const seenKeys = new Set<string>();
  const seenLeagueIds = new Set<string>();
  const targets: RegisteredLeague[] = [];
  const disabled: RegisteredLeague[] = [];

  for (const raw of rawTargets) {
    const entry = normalizeEntry(raw);

    if (!entry.key || typeof entry.key !== "string") {
      warnings.push(`Dropped a league target with a missing or invalid key.`);
      continue;
    }
    const externalId = entry.external_league_id || entry.league_id;
    if (!externalId || typeof externalId !== "string") {
      warnings.push(`Dropped league target "${entry.key}": no external league id.`);
      continue;
    }
    // Sleeper league ids are always numeric. Other providers set their own rules.
    if (entry.provider === "sleeper" && !isNumericId(externalId)) {
      warnings.push(
        `Dropped league target "${entry.key}": league_id "${externalId}" is not a valid numeric Sleeper league id.`,
      );
      continue;
    }
    if (!Number.isInteger(entry.season) || entry.season < 2000 || entry.season > 2100) {
      warnings.push(`Dropped league target "${entry.key}": season "${String(entry.season)}" is invalid.`);
      continue;
    }
    if (seenKeys.has(entry.key)) {
      warnings.push(`Dropped duplicate league target key "${entry.key}".`);
      continue;
    }
    const dedupeId = `${entry.provider}:${externalId}:${entry.season}`;
    if (seenLeagueIds.has(dedupeId)) {
      warnings.push(
        `Dropped league target "${entry.key}": ${entry.provider} league ${externalId} (${entry.season}) is already registered under another key.`,
      );
      continue;
    }
    seenKeys.add(entry.key);
    seenLeagueIds.add(dedupeId);
    (entry.enabled ? targets : disabled).push(entry);
  }

  return { targets, disabled, warnings };
}

/** Fill v2 fields from v1 shorthand so hand-written / test entries stay terse. */
function normalizeEntry(raw: LeagueTarget): RegisteredLeague {
  return {
    ...raw,
    provider: raw.provider ?? "sleeper",
    external_league_id: raw.external_league_id || raw.league_id,
    league_id: raw.league_id || raw.external_league_id || "",
    season: raw.season ?? 2026,
    known_managers: raw.known_managers ?? [],
    yahoo_league_key: raw.yahoo_league_key ?? null,
  };
}

export function getLeagueRegistry(): LeagueRegistryResult {
  return validateAndDedupeTargets(LEAGUE_TARGETS);
}

export function findLeagueTarget(key: string): RegisteredLeague | null {
  const { targets } = getLeagueRegistry();
  return targets.find((target) => target.key === key) ?? null;
}

export function listLeagueTargets(): RegisteredLeague[] {
  return getLeagueRegistry().targets;
}

/** Readiness of a target's provider integration — backs `/api/providers` + docs. */
export function leagueConfigStatus(target: Pick<RegisteredLeague, "provider" | "yahoo_league_key">): LeagueConfigStatus {
  if (target.provider === "sleeper") return "READY";
  if (target.provider === "yahoo") {
    return target.yahoo_league_key ? "READY" : "AWAITING_CREDENTIALS";
  }
  return "PROVIDER_UNIMPLEMENTED";
}
