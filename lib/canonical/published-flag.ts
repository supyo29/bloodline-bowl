/**
 * Feature flag for the published-snapshot read path.
 *
 * `BRIDGE_PUBLISHED_SNAPSHOT=1` makes routes resolve league state through the
 * authoritative published pointer (Stage E onward). Unset / any other value ⇒
 * routes keep calling `buildCanonicalLeagueState` directly, exactly as today.
 *
 * The primitive (`getPublishedLeagueSnapshot`) itself is ALWAYS callable — the
 * flag only governs whether production routes adopt it. That is what makes
 * rollback a one-line env change with no code revert.
 */
export function publishedSnapshotEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.BRIDGE_PUBLISHED_SNAPSHOT?.trim() === "1";
}
