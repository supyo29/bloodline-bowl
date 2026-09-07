/**
 * Structured observability for the real-time state layer.
 *
 * One line of JSON per event on stdout — greppable in Vercel logs and parseable
 * by any log drain. Never logs secrets: field keys that look sensitive are
 * dropped, and callers pass IDs (league_slug, snapshot_id), never tokens or
 * payloads.
 */

export type BridgeEvent =
  | "refresh_started"
  | "refresh_completed"
  | "refresh_failed"
  | "source_changed"
  | "source_unchanged"
  | "snapshot_created"
  | "snapshot_rejected"
  | "snapshot_published"
  | "snapshot_reused"
  | "cross_surface_discrepancy"
  | "recommendation_invalidated"
  | "recommendation_regenerated"
  | "draft_pick_detected"
  | "transaction_detected"
  | "source_unavailable"
  | "stale_snapshot_served"
  | "pointer_race_lost";

export type EventField = string | number | boolean | null;

const SENSITIVE = /(secret|token|key|authorization|password|apikey|bearer)/i;

function sanitize(fields: Record<string, EventField>): Record<string, EventField> {
  const out: Record<string, EventField> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SENSITIVE.test(k)) continue;
    out[k] = typeof v === "string" && v.length > 512 ? `${v.slice(0, 512)}…` : v;
  }
  return out;
}

/** Emit one structured event. Best-effort; never throws into the caller. */
export function emitBridgeEvent(
  event: BridgeEvent,
  fields: Record<string, EventField> = {},
): void {
  try {
    console.log(
      JSON.stringify({
        evt: `bridge.${event}`,
        at: new Date().toISOString(),
        ...sanitize(fields),
      }),
    );
  } catch {
    /* logging must never break a request */
  }
}
