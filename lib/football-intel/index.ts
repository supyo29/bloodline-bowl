/**
 * Football Intelligence Engine — read-only TypeScript surface (Phase 3).
 *
 * NOT wired into Team-State or any recommendation engine (spec §32). Import
 * from here in Phase 4+ when a consumer is ready to join fantasy roster
 * players to NFL football intelligence.
 */
export * from "./schema";
export { loadFootballIntelligence, __resetFootballIntelligenceCache } from "./read";
export type { FootballIntelligence } from "./read";
