/**
 * Yahoo connection health — credential-free by construction.
 *
 * Output contains ONLY timestamps, enums, booleans and counts. It never touches `access_token`/`refresh_token` fields of its result, and the
 * source objects are reduced to those scalars before they leave this module (tests scan the serialized output for token material).
 */
import { getYahooLifecycleRecord, REFRESH_SKEW_MS, type YahooFailureKind, type YahooTokenStore } from "./oauth";

export type YahooConnectionStatus = "HEALTHY" | "DEGRADED" | "REAUTHORIZATION_REQUIRED" | "NOT_CONNECTED" | "STORE_UNAVAILABLE";
export type YahooTokenExpiryState = "VALID" | "EXPIRING_SOON" | "EXPIRED" | "UNKNOWN";

export interface YahooConnectionHealth {
  connection_id: string;
  status: YahooConnectionStatus;
  token_expiry: { state: YahooTokenExpiryState; expires_in_seconds: number | null; auto_refresh_on_next_use: boolean };
  last_successful_refresh_at: string | null;
  last_refresh_failure: { at: string; kind: YahooFailureKind } | null;
  last_successful_authenticated_read_at: string | null;
  rotation_count: number | null;
  persist_pending: boolean;
  reauthorization_required: boolean;
  /** Plain-language reason; never contains credentials. */
  detail: string;
}

const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString());

export async function getYahooConnectionHealth(connectionId: string, store: YahooTokenStore, now = Date.now()): Promise<YahooConnectionHealth> {
  const life = getYahooLifecycleRecord(connectionId);
  const base = { connection_id: connectionId, persist_pending: life.persist_pending, last_refresh_failure: life.last_refresh_failure_at && life.last_refresh_failure_kind ? { at: iso(life.last_refresh_failure_at) as string, kind: life.last_refresh_failure_kind } : null };
  let v: Awaited<ReturnType<NonNullable<YahooTokenStore["getVersioned"]>>> = null;
  try {
    v = store.getVersioned ? await store.getVersioned() : null;
    if (!store.getVersioned) { const t = await store.get(); v = t ? { token: t, seq: 0, last_refreshed_at: null, last_used_at: null } : null; }
  } catch {
    return { ...base, status: "STORE_UNAVAILABLE", token_expiry: { state: "UNKNOWN", expires_in_seconds: null, auto_refresh_on_next_use: false }, last_successful_refresh_at: iso(life.last_refresh_ok_at), last_successful_authenticated_read_at: iso(life.last_authenticated_read_at), rotation_count: null, reauthorization_required: false, detail: "The encrypted token store could not be read." };
  }
  if (!v) return { ...base, status: "NOT_CONNECTED", token_expiry: { state: "UNKNOWN", expires_in_seconds: null, auto_refresh_on_next_use: false }, last_successful_refresh_at: null, last_successful_authenticated_read_at: iso(life.last_authenticated_read_at), rotation_count: null, reauthorization_required: true, detail: "No Yahoo account has been authorized for this connection." };
  const left = v.token.expires_at - now;
  const state: YahooTokenExpiryState = left <= 0 ? "EXPIRED" : left <= REFRESH_SKEW_MS ? "EXPIRING_SOON" : "VALID";
  const reauth = life.reauthorization_required;
  const failureNewer = !!life.last_refresh_failure_at && life.last_refresh_failure_at > (life.last_refresh_ok_at ?? 0);
  const status: YahooConnectionStatus = reauth ? "REAUTHORIZATION_REQUIRED" : failureNewer || life.persist_pending ? "DEGRADED" : "HEALTHY";
  return {
    ...base, status,
    token_expiry: { state, expires_in_seconds: Math.max(0, Math.round(left / 1000)), auto_refresh_on_next_use: state !== "VALID" },
    last_successful_refresh_at: iso(Math.max(v.last_refreshed_at ?? 0, life.last_refresh_ok_at ?? 0) || null),
    last_successful_authenticated_read_at: iso(Math.max(v.last_used_at ?? 0, life.last_authenticated_read_at ?? 0) || null),
    rotation_count: v.seq, reauthorization_required: reauth,
    detail: reauth ? "Yahoo rejected the stored refresh token; the account must be re-authorized once." : state === "VALID" ? "Access token valid; refresh is automatic." : "Access token is expired or expiring; it is refreshed automatically on the next Yahoo read.",
  };
}
