/**
 * The SINGLE resolver for `league identity` and `manager identity`.
 *
 * Two identity dimensions that must never be conflated:
 *   1. Which LEAGUE is being requested?   -> resolveLeagueStrict / resolveLeagueId
 *   2. Which MANAGER inside it is asking?  -> resolveManagerInLeague
 *
 * League resolution shares one implementation with the legacy `?league=` routes:
 * both go through `findLeagueTarget` in `lib/leagues/registry.ts` plus the same
 * "raw numeric Sleeper id is always allowed" rule. The only difference is the
 * fallback: the path form (`/api/leagues/:slug`) REQUIRES a slug and 404s on an
 * unknown one; the legacy query form keeps falling back to the default league
 * when `?league=` is omitted (backward compatibility).
 *
 * ============================ CRITICAL MANAGER RULES ============================
 * Manager identity MUST NEVER be inferred from: commissioner status, league
 * ownership, the first roster/manager Sleeper returns, array ordering, a previous
 * request, an env var, a hard-coded user, roster number alone, or draft slot
 * alone. A personalized route that cannot resolve an explicit manager returns a
 * documented league-wide response OR an explicit error — it never silently picks
 * Supyo29, BijiMac, the commissioner, roster 1, or "the first manager".
 * =============================================================================
 */

import {
  SleeperError,
  getLeague,
  getLeagueDrafts,
  getLeagueRosters,
  getLeagueUsers,
  getSleeperUser,
} from "@/lib/sleeper/client";
import { selectActiveDraft } from "@/lib/sleeper/draft";
import type { RawDraft, RawLeagueUser, RawRoster } from "@/lib/sleeper/types";
import {
  DEFAULT_LEAGUE_KEY,
  findLeagueTarget,
  listLeagueTargets,
} from "./registry";
import {
  findRegisteredManager,
  managerSlugFromUsername,
  type ManagerIdentity,
} from "./managers";

/* -------------------------------------------------------------------------- */
/* League resolution                                                           */
/* -------------------------------------------------------------------------- */

export interface ResolvedLeague {
  /** Canonical registered slug, or the numeric id itself for raw-id access. */
  league_slug: string;
  league_id: string;
  /** Whether the league is in `lib/leagues/registry.ts`. */
  registered: boolean;
  display_name: string;
}

export type LeagueResolution =
  | { ok: true; league: ResolvedLeague }
  | { ok: false; status: number; code: string; detail: string };

const NUMERIC_ID = /^\d+$/;

function knownLeagueSlugs(): string[] {
  return listLeagueTargets().map((t) => t.key);
}

/**
 * Path form: a league slug is REQUIRED and must resolve to a registered league
 * or a raw numeric Sleeper id. No env var, no default fallback.
 */
export function resolveLeagueStrict(
  slug: string | null | undefined,
): LeagueResolution {
  const raw = slug?.trim();
  if (!raw) {
    return {
      ok: false,
      status: 400,
      code: "league_slug_required",
      detail: "A league slug is required on this route.",
    };
  }

  const target = findLeagueTarget(raw) ?? findLeagueTarget(raw.toLowerCase());
  if (target) {
    return {
      ok: true,
      league: {
        league_slug: target.key,
        league_id: target.league_id,
        registered: true,
        display_name: target.display_name,
      },
    };
  }

  if (NUMERIC_ID.test(raw)) {
    return {
      ok: true,
      league: {
        league_slug: raw,
        league_id: raw,
        registered: false,
        display_name: `Sleeper league ${raw}`,
      },
    };
  }

  return {
    ok: false,
    status: 404,
    code: "league_not_found",
    detail: `No league matches "${raw}". Known league slugs: ${knownLeagueSlugs().join(
      ", ",
    )}. A raw numeric Sleeper league id also works.`,
  };
}

/**
 * Query form (legacy `?league=`): shares the same registry + numeric-id rule as
 * `resolveLeagueStrict`, but keeps falling back to the default league when the
 * selector is empty. `parseLeagueSelector` in `lib/analytics/query.ts` still
 * rejects an unknown non-numeric selector with a 400 before this is reached.
 */
export function resolveLeagueForQuery(
  selector: string | null | undefined,
): ResolvedLeague {
  const raw = selector?.trim();
  if (raw) {
    const strict = resolveLeagueStrict(raw);
    if (strict.ok) return strict.league;
  }
  const fallback =
    findLeagueTarget(DEFAULT_LEAGUE_KEY) ?? findLeagueTarget("bloodline-bowl");
  return {
    league_slug: fallback?.key ?? DEFAULT_LEAGUE_KEY,
    league_id: fallback?.league_id ?? "1395549281678532608",
    registered: true,
    display_name: fallback?.display_name ?? "Bloodline Bowl",
  };
}

/* -------------------------------------------------------------------------- */
/* Manager resolution                                                          */
/* -------------------------------------------------------------------------- */

export interface ResolvedManager {
  manager_slug: string;
  /** The slug exactly as it appeared in the URL (may differ only in case). */
  requested_slug: string;
  /** Exact-cased Sleeper username (registry form when known, else Sleeper's). */
  sleeper_username: string;
  sleeper_user_id: string;
  /** Sleeper league-user display name in THIS league. */
  display_name: string | null;
  team_name: string | null;
  league_slug: string;
  league_id: string;
  /** Verified: this manager owns exactly this roster in this league. */
  roster_id: number;
  /** From THIS league's active draft only. Null if no draft / not seeded. */
  draft_slot: number | null;
  draft_id: string | null;
  draft_status: string | null;
  /** True when matched via `co_owners` rather than `owner_id`. */
  is_co_owner: boolean;
  registered: boolean;
}

export type ManagerResolution =
  | { ok: true; manager: ResolvedManager }
  | { ok: false; status: number; code: string; detail: string };

interface ManagerSeed {
  user_id: string;
  username: string;
  slug: string;
  registered: boolean;
}

/** Turn a manager slug/username into a Sleeper user_id — WITHOUT touching any league. */
async function seedManagerIdentity(
  managerSlug: string,
): Promise<ManagerSeed | { error: { status: number; code: string; detail: string } }> {
  const registered: ManagerIdentity | null = findRegisteredManager(managerSlug);
  if (registered) {
    return {
      user_id: registered.sleeper_user_id,
      username: registered.sleeper_username,
      slug: registered.manager_slug,
      registered: true,
    };
  }

  // Not registered — treat the slug as a Sleeper username and resolve it live.
  const user = await getSleeperUser(managerSlug);
  if (!user) {
    return {
      error: {
        status: 404,
        code: "manager_not_found",
        detail: `No registered manager and no Sleeper account named "${managerSlug}".`,
      },
    };
  }
  const username = user.username ?? managerSlug;
  return {
    user_id: user.user_id,
    username,
    slug: managerSlugFromUsername(username),
    registered: false,
  };
}

/**
 * Resolve a manager INSIDE an already-resolved league, validating every link:
 *   slug -> user_id  (registry or live Sleeper user lookup)
 *   user_id belongs to a roster in THIS league  (owner_id or co_owners)
 *   roster_id + draft_slot come from THIS league's data only
 *
 * Never falls back to another manager. An unresolved or non-member manager is
 * an explicit non-200.
 */
export async function resolveManagerInLeague(
  league: ResolvedLeague,
  managerSlug: string,
): Promise<ManagerResolution> {
  const requested = managerSlug?.trim();
  if (!requested) {
    return {
      ok: false,
      status: 400,
      code: "manager_slug_required",
      detail: "A manager slug is required on this route.",
    };
  }

  const seed = await seedManagerIdentity(requested);
  if ("error" in seed) {
    return { ok: false, ...seed.error };
  }

  let rosters: RawRoster[];
  let users: RawLeagueUser[];
  try {
    // Make sure the league actually exists before validating membership.
    await getLeague(league.league_id);
    [rosters, users] = await Promise.all([
      getLeagueRosters(league.league_id),
      getLeagueUsers(league.league_id),
    ]);
  } catch (error) {
    if (error instanceof SleeperError && error.status === 404) {
      return {
        ok: false,
        status: 404,
        code: "league_not_found",
        detail: `Sleeper has no league with id ${league.league_id}.`,
      };
    }
    return {
      ok: false,
      status: 502,
      code: "sleeper_upstream_error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const ownedRoster = rosters.find((r) => r.owner_id === seed.user_id);
  const coOwnedRoster = ownedRoster
    ? undefined
    : rosters.find((r) => (r.co_owners ?? []).includes(seed.user_id));
  const roster = ownedRoster ?? coOwnedRoster;

  if (!roster) {
    return {
      ok: false,
      status: 404,
      code: "manager_not_in_league",
      detail:
        `Manager "${seed.slug}" (Sleeper user ${seed.user_id}) is not a member of ` +
        `league "${league.league_slug}" (${league.league_id}). This combination is ` +
        `rejected rather than falling back to another manager.`,
    };
  }

  const leagueUser = users.find((u) => u.user_id === seed.user_id) ?? null;

  // Draft slot: from THIS league's active draft, keyed by this user_id only.
  let draft: RawDraft | null = null;
  try {
    draft = selectActiveDraft(await getLeagueDrafts(league.league_id));
  } catch {
    draft = null;
  }
  const draftSlot =
    draft?.draft_order && typeof draft.draft_order[seed.user_id] === "number"
      ? draft.draft_order[seed.user_id]!
      : null;

  return {
    ok: true,
    manager: {
      manager_slug: seed.slug,
      requested_slug: requested,
      sleeper_username: seed.username,
      sleeper_user_id: seed.user_id,
      display_name: leagueUser?.display_name ?? null,
      team_name:
        (leagueUser?.metadata?.team_name as string | undefined) ??
        (roster.metadata?.team_name as string | undefined) ??
        null,
      league_slug: league.league_slug,
      league_id: league.league_id,
      roster_id: roster.roster_id,
      draft_slot: draftSlot,
      draft_id: draft?.draft_id ?? null,
      draft_status: draft?.status ?? null,
      is_co_owner: Boolean(coOwnedRoster),
      registered: seed.registered,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Response context objects (AI-facing identity metadata)                      */
/* -------------------------------------------------------------------------- */

export interface LeagueContext {
  scope: "league";
  league_slug: string;
  league_id: string;
  registered: boolean;
  canonical_url: string;
}

export interface ManagerContext {
  scope: "manager";
  league_slug: string;
  league_id: string;
  manager_slug: string;
  sleeper_username: string;
  sleeper_user_id: string;
  roster_id: number;
  draft_slot: number | null;
  draft_id: string | null;
  canonical_url: string;
}

export function leagueContext(league: ResolvedLeague): LeagueContext {
  return {
    scope: "league",
    league_slug: league.league_slug,
    league_id: league.league_id,
    registered: league.registered,
    canonical_url: `/api/leagues/${league.league_slug}`,
  };
}

export function managerContext(manager: ResolvedManager): ManagerContext {
  return {
    scope: "manager",
    league_slug: manager.league_slug,
    league_id: manager.league_id,
    manager_slug: manager.manager_slug,
    sleeper_username: manager.sleeper_username,
    sleeper_user_id: manager.sleeper_user_id,
    roster_id: manager.roster_id,
    draft_slot: manager.draft_slot,
    draft_id: manager.draft_id,
    canonical_url: `/api/leagues/${manager.league_slug}/managers/${manager.manager_slug}`,
  };
}
