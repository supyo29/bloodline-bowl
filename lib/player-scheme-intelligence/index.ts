/**
 * Player x Scheme Interaction Intelligence — read-only TypeScript surface (Phase 9).
 *
 * ADDITIVE. NOT wired into Team-State, the production projection, or any
 * recommendation engine (spec §1, §44). Consumed only by the dedicated
 * additive read-only surface `app/api/player-scheme/*` (spec §37).
 * SHADOW_PREDICTIVE interaction effects carry numeric_fantasy_adjustment = 0
 * until certified separately (spec §35).
 */
export * from "./schema";
export {
  loadPlayerSchemeIntelligence,
  __resetPlayerSchemeCache,
  resolvePlayer,
  qbMatrix,
  qbDirectional,
  receiverMatrix,
  rbRushMatrix,
  rbRushGap,
  defensePassMatrix,
  defenseRushProfile,
  leagueBaselines,
  qbCoverageProfile,
  qbCoverageFamily,
  qbPressureProfile,
  qbRusherCountProfile,
  qbFormationProfile,
  qbConceptProfile,
  qbProgressionProfile,
  receiverRouteProfile,
  receiverCoverageProfile,
  rbBoxProfile,
  tierBManifest,
  tierBFamilyMeta,
} from "./read";
export type {
  PlayerSchemeIntelligence,
  DirectoryEntry,
  SpatialCellRow,
  QbDirectionalRow,
  DefensePassCell,
  ProfileWindow,
  ChartingSplitRow,
  TierBAvailability,
  TierBManifest,
} from "./read";
export {
  buildQbProfile,
  buildReceivingProfile,
  buildRushingProfile,
  buildDefenseProfile,
  buildMatchupAlignment,
  resolveRef,
} from "./query";
