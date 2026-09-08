/**
 * Player x Scheme Interaction Intelligence — read-only TypeScript surface (Phase 9).
 *
 * ADDITIVE. NOT wired into Team-State, the production projection, or any
 * recommendation engine (spec §1, §44). Import from here only from a
 * dedicated additive read-only API surface (spec §37) once Phase 9 Part II
 * publishes data artifacts. SHADOW_PREDICTIVE interaction effects carry
 * numeric_fantasy_adjustment = 0 until certified separately (spec §35).
 */
export * from "./schema";
export {
  loadPlayerSchemeIntelligence,
  __resetPlayerSchemeCache,
} from "./read";
export type { PlayerSchemeIntelligence } from "./read";
