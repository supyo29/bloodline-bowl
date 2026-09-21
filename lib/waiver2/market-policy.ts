/**
 * Phase 4.5 — Waiver 2.0's EXPLICIT policy toward the canonical market state. Waiver 2.0 consumes the pool; it does not interpret
 * ownership itself. Every readiness code is either blocking (the snapshot's own BLOCKING set, always) or listed here.
 *   - GAME_LOCK_UNVERIFIABLE      tolerated: the capture layer classifies such a decision LIVE_UNVERIFIED (never pristine).
 *   - FAAB_CONTEXT_UNAVAILABLE    tolerated: FAAB ranges degrade to UNKNOWN; a genuinely available player is never hidden by it.
 *   - IDENTITY_INCOMPLETE         tolerated: it concerns rostered ids only (still owned), never a pool candidate.
 *   - PENDING_CLAIMS_NOT_EXPOSED / WAIVER_CLEAR_TIME_NOT_EXPOSED  permanent provider limits, disclosed, never blocking.
 * Nothing is added to `also_blocking` today; adding a code here is how a stricter stance would be taken, deliberately.
 */
import type { ConsumerPolicy } from "@/lib/market-state/pool";
export const WAIVER2_MARKET_POLICY: ConsumerPolicy = { consumer: "waiver-intelligence-2", also_blocking: [] };
