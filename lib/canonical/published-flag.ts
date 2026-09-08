/**
 * Feature flag for the published-snapshot READ path (Stage F).
 *
 * `BRIDGE_PUBLISHED_SNAPSHOT` values:
 *   (unset) / "off" / "0"   — every eligible route serves LEGACY_LIVE_PATH (default)
 *   "wave1"                  — Wave 1 routes prefer the published snapshot
 *   "wave2"                  — Waves 1–2
 *   "wave3"                  — Waves 1–3
 *   "1" / "on" / "all"       — every eligible wave
 *
 * The flag ONLY governs whether an eligible read prefers the published snapshot.
 * It never affects: the publication path (Stage E), Draft Live, waiver / free-agent
 * surfaces, history, or `/api/health`. Rollback is a one-line env change — no
 * migration, no cache flush, no redeploy-specific cleanup, and the legacy path is
 * never removed.
 */

export type ReadWave = 1 | 2 | 3;

function raw(env: NodeJS.ProcessEnv): string {
  return (env.BRIDGE_PUBLISHED_SNAPSHOT ?? "").trim().toLowerCase();
}

/** Does the current flag level enable published reads for `wave`? */
export function publishedReadEnabled(
  wave: ReadWave,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = raw(env);
  if (v === "1" || v === "on" || v === "all") return true;
  const m = /^wave([123])$/.exec(v);
  return m ? wave <= Number(m[1]) : false;
}

/** True when ANY wave is enabled — for display / health only. */
export function publishedSnapshotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return publishedReadEnabled(3, env) || publishedReadEnabled(1, env);
}

/** Human-readable flag state for diagnostics. */
export function publishedFlagState(env: NodeJS.ProcessEnv = process.env): string {
  const v = raw(env);
  if (!v || v === "off" || v === "0") return "OFF";
  if (v === "1" || v === "on" || v === "all") return "ALL_WAVES";
  if (/^wave[123]$/.test(v)) return v.toUpperCase();
  return `UNKNOWN(${v})`;
}
