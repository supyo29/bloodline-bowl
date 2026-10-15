/**
 * Phase 4.5 — structural integrity of a MarketSnapshot. Pure. The builder runs it and turns any violation into a BLOCKING
 * `OWNERSHIP_INTEGRITY_VIOLATION` readiness reason, so an internally contradictory market is never served as actionable.
 */
import { PLAYER_MARKET_STATUSES, type MarketSnapshot, type PlayerMarketState } from "./contract";

export interface IntegrityViolation { code: string; player_key: string | null; detail: string }

export function validatePlayerState(p: PlayerMarketState): IntegrityViolation[] {
  const v: IntegrityViolation[] = []; const bad = (code: string, detail: string) => v.push({ code, player_key: p.player_key, detail });
  if (p.status === "ROSTERED") {
    if (p.ownership !== "ROSTERED" || !p.owner_team_id) bad("ROSTERED_WITHOUT_OWNER", "ROSTERED requires ownership ROSTERED and an owner");
    if (p.eligible_to_add) bad("ROSTERED_ADDABLE", "a rostered player cannot be addable");
  } else if (p.owner_team_id || p.ownership === "ROSTERED") bad("OWNED_BUT_NOT_ROSTERED_STATUS", `status ${p.status} carries an owner`);
  if (p.status === "AVAILABLE_FREE_AGENT") {
    if (p.ownership !== "UNROSTERED") bad("AVAILABLE_NOT_VERIFIED_UNROSTERED", "AVAILABLE requires ownership UNROSTERED (verified), never UNKNOWN");
    if (!p.eligible_to_add) bad("AVAILABLE_NOT_ADDABLE", "AVAILABLE requires eligible_to_add");
    if (p.acquisition.status !== "FREE_AGENT" || p.acquisition.mechanism !== "FREE_AGENT_ADD") bad("AVAILABLE_WRONG_MECHANISM", "AVAILABLE requires FREE_AGENT / FREE_AGENT_ADD");
    if (p.waiver_window) bad("AVAILABLE_IN_WAIVER_WINDOW", "a player inside a waiver window is not a plain free agent");
  }
  if (p.status === "ON_WAIVERS" && (p.acquisition.status !== "WAIVER" || (!p.waiver_window && !p.availability_evidence))) bad("WAIVER_WITHOUT_WINDOW", "ON_WAIVERS requires WAIVER and a provable drop window (Sleeper) or provider status evidence (Yahoo)");
  if (p.status !== "ON_WAIVERS" && p.status !== "WAIVER_CLAIM_PENDING" && p.waiver_window) bad("WINDOW_ON_NON_WAIVER", "a waiver window is attached to a non-waiver status");
  // Provider-evidence markets: a player is verified FA / WAIVERS ONLY by the provider's own status for that player. Unrostered is never enough.
  if (p.provider === "yahoo") {
    const ev = p.availability_evidence;
    if (p.status === "AVAILABLE_FREE_AGENT" && (!ev || ev.basis !== "PROVIDER_STATUS" || ev.provider_status !== "FA")) bad("AVAILABLE_WITHOUT_PROVIDER_EVIDENCE", "a Yahoo free agent needs Yahoo's own FA status for that player (unrostered is not evidence)");
    if (p.status === "ON_WAIVERS" && (!ev || ev.basis !== "PROVIDER_STATUS" || ev.provider_status !== "W")) bad("WAIVER_WITHOUT_PROVIDER_EVIDENCE", "a Yahoo waiver player needs Yahoo's own W status for that player");
    if (p.status === "ROSTERED" && ev && ev.provider_status !== "T") bad("ROSTERED_WITH_NON_OWNED_EVIDENCE", "a rostered player cannot carry FA/W evidence");
  }
  if (p.claimable && !p.availability_evidence) bad("CLAIMABLE_WITHOUT_EVIDENCE", "claimable requires provider status evidence");
  if (p.claimable && p.status !== "ON_WAIVERS") bad("CLAIMABLE_NOT_ON_WAIVERS", "only a player on waivers is claimable");
  if (p.waiver_clears_at) bad("CLEAR_TIME_FABRICATED_RISK", "waiver_clears_at is only legal when a provider exposes it (none supported)");
  if (p.status === "WAIVER_CLAIM_PENDING") {
    // only a provider that exposes the connected account's own pending claims (Yahoo) may emit it, and only on top of provider W evidence
    const okPending = p.provider === "yahoo" && !!p.pending_claim && p.availability_evidence?.provider_status === "W" && p.acquisition.status === "WAIVER" && !p.eligible_to_add && !p.claimable;
    if (!okPending) bad("PENDING_CLAIM_UNSUPPORTED", "WAIVER_CLAIM_PENDING needs a provider that exposes the account's own claim (Yahoo), W evidence, and no claimable/addable flag");
  }
  if (p.pending_claim && p.status !== "WAIVER_CLAIM_PENDING") bad("PENDING_CLAIM_ON_NON_PENDING", "a pending claim is attached to a non-pending status");
  if (p.status === "UNKNOWN_AVAILABILITY" && (p.eligible_to_add || p.acquisition.status !== "UNKNOWN")) bad("UNKNOWN_ASSERTS_KNOWN", "UNKNOWN_AVAILABILITY must not assert an acquisition");
  if (p.status === "LOCKED" && p.eligible_to_add) bad("LOCKED_ADDABLE", "LOCKED cannot be addable");
  if (p.status === "INELIGIBLE" && (p.eligible_to_add || !p.reason)) bad("INELIGIBLE_INCONSISTENT", "INELIGIBLE needs a reason and cannot be addable");
  if (p.status === "SOURCE_UNAVAILABLE" && p.eligible_to_add) bad("SOURCE_UNAVAILABLE_ADDABLE", "SOURCE_UNAVAILABLE cannot be addable");
  if (p.entity === "TEAM_DEFENSE" && p.position !== "DEF") bad("DEF_ENTITY_POSITION", "a team-defense entity must be position DEF");
  return v;
}

export function validateMarketSnapshot(s: MarketSnapshot): IntegrityViolation[] {
  const v: IntegrityViolation[] = []; const seen = new Map<string, string | null>(); const counts: Record<string, number> = Object.fromEntries(PLAYER_MARKET_STATUSES.map((k) => [k, 0]));
  for (const p of s.players) {
    if (seen.has(p.player_key)) v.push({ code: "DUPLICATE_PLAYER_KEY", player_key: p.player_key, detail: "two entries share an identity (two owners or AVAILABLE+OWNED)" });
    seen.set(p.player_key, p.owner_team_id); counts[p.status] = (counts[p.status] ?? 0) + 1; v.push(...validatePlayerState(p));
  }
  for (const k of PLAYER_MARKET_STATUSES) if (s.counts[k] !== counts[k]) v.push({ code: "COUNT_MISMATCH", player_key: null, detail: `${k}: declared ${s.counts[k]} != actual ${counts[k]}` });
  if (s.identities.market_content_id === s.identities.request_id) v.push({ code: "IDENTITY_CONFLATION", player_key: null, detail: "content id equals request id" });
  return v;
}
