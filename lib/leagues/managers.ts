/**
 * Canonical MANAGER identity registry.
 *
 * This is deliberately separate from `lib/leagues/registry.ts` (which addresses
 * *leagues*). A manager's identity is: a stable URL slug, the exact Sleeper
 * username, and the Sleeper `user_id`. Nothing here binds a manager to a league
 * — league membership is always validated live against Sleeper data by
 * `lib/leagues/resolve.ts` (see the CRITICAL rules in that file).
 *
 * The three entries below exist so the known managers get a stable canonical
 * slug and the exact-cased username they asked to preserve. Any *other* Sleeper
 * username still resolves generically: `resolveManagerInLeague` falls back to a
 * live Sleeper user lookup, so the architecture stays `league -> manager ->
 * resource` for managers who are not listed here.
 *
 * Every `sleeper_user_id` below was verified against the live Sleeper API
 * (`GET /v1/user/<username>`), not inferred from a human name.
 */

export interface ManagerIdentity {
  /** Stable, lowercase, URL-safe slug. The canonical identifier in links. */
  manager_slug: string;
  /**
   * Exact Sleeper username as the owner wants it preserved in identity
   * metadata. Sleeper itself lowercases usernames internally; both forms
   * resolve to the same `sleeper_user_id`.
   */
  sleeper_username: string;
  /** Sleeper `user_id` — verified live, never invented. */
  sleeper_user_id: string;
}

const MANAGER_REGISTRY: ManagerIdentity[] = [
  {
    manager_slug: "supyo29",
    sleeper_username: "Supyo29",
    sleeper_user_id: "1308955807408230400",
  },
  {
    manager_slug: "bijimac",
    sleeper_username: "BijiMac",
    sleeper_user_id: "1395574107612942336",
  },
  {
    manager_slug: "darthmarker",
    sleeper_username: "DarthMarker",
    sleeper_user_id: "1265419589680910336",
  },
];

/** Turn any Sleeper username into a stable lowercase URL slug. */
export function managerSlugFromUsername(username: string): string {
  return username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Look up a registered manager by canonical slug OR by Sleeper username,
 * case-insensitively. Returns null for anything not explicitly registered —
 * callers then fall back to a live Sleeper user lookup.
 */
export function findRegisteredManager(
  slugOrUsername: string | null | undefined,
): ManagerIdentity | null {
  if (!slugOrUsername) return null;
  const needle = slugOrUsername.trim().toLowerCase();
  if (!needle) return null;
  for (const manager of MANAGER_REGISTRY) {
    if (manager.manager_slug.toLowerCase() === needle) return { ...manager };
    if (manager.sleeper_username.toLowerCase() === needle) return { ...manager };
  }
  return null;
}

/** Look up a registered manager by Sleeper `user_id`. */
export function findRegisteredManagerByUserId(
  userId: string | null | undefined,
): ManagerIdentity | null {
  if (!userId) return null;
  return (
    MANAGER_REGISTRY.find((m) => m.sleeper_user_id === userId) ?? null
  );
}

export function listRegisteredManagers(): ManagerIdentity[] {
  return MANAGER_REGISTRY.map((m) => ({ ...m }));
}
