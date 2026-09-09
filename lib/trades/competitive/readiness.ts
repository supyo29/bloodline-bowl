/**
 * Competitive Trade Intelligence — readiness contract (Checkpoint B).
 *
 * The waiver-readiness lesson, applied to trades: analytical desirability is
 * NOT transaction feasibility. This helper fails closed — if a REQUIRED
 * capability is UNAVAILABLE the whole competitive block is downgraded and no
 * fabricated market value / edge is produced.
 *
 * Checkpoint B required capabilities: `private_projection`, `market_data`,
 * `player_identity`, `ownership`. `scoring_compatible` is informational at B
 * (the provider benchmark is already in league scoring); it will gate harder
 * once ADP-derived value is used directly.
 */

import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { WeeklyProjectionBatch } from "@/lib/weekly/schema";
import type { PlayerMarketSnapshot, PprMode } from "./market/snapshot";
import type { CompetitiveCapability, CompetitiveCapabilityState, CompetitiveReadiness } from "./schema";

function cap(state: CompetitiveCapabilityState, reasons: string[] = []): CompetitiveCapability {
  return { state, reasons };
}

export interface AssessReadinessInput {
  projections: WeeklyProjectionBatch;
  market_snapshots: Map<string, PlayerMarketSnapshot>;
  players_by_id: Map<string, CanonicalPlayer>;
  /** the players actually in this analysis (trade assets, or the whole league for the boards) */
  focus_player_ids: string[];
  ownership_known: boolean;
  manager_identity_known: boolean;
  ppr_mode: PprMode;
}

const WORST_ORDER: CompetitiveCapabilityState[] = ["READY", "PARTIAL", "UNAVAILABLE"];
const worst = (a: CompetitiveCapabilityState, b: CompetitiveCapabilityState): CompetitiveCapabilityState =>
  WORST_ORDER.indexOf(a) >= WORST_ORDER.indexOf(b) ? a : b;

export function assessCompetitiveTradeReadiness(input: AssessReadinessInput): CompetitiveReadiness {
  const { projections, market_snapshots, players_by_id, focus_player_ids } = input;

  // ---- private projection --------------------------------------------------
  let privateProjection: CompetitiveCapability;
  if (projections.status === "PROJECTIONS_UNAVAILABLE") {
    privateProjection = cap("UNAVAILABLE", ["weekly projections unavailable for this league/week"]);
  } else {
    const projected = focus_player_ids.filter((id) => projections.by_player.get(id)?.projected_points != null).length;
    const frac = focus_player_ids.length > 0 ? projected / focus_player_ids.length : 0;
    privateProjection =
      frac >= 0.999
        ? cap("READY")
        : frac > 0
          ? cap("PARTIAL", [`${projected}/${focus_player_ids.length} focus players have a private projection`])
          : cap("UNAVAILABLE", ["no focus player has a private projection"]);
  }

  // ---- market data --------------------------------------------------------
  let currentOrPartial = 0;
  let anyStale = false;
  for (const id of focus_player_ids) {
    const ms = market_snapshots.get(id);
    if (!ms || ms.primary_basis === "unavailable") continue;
    if (ms.readiness === "CURRENT" || ms.readiness === "PARTIAL") currentOrPartial += 1;
    if (ms.readiness === "STALE") anyStale = true;
  }
  const marketFrac = focus_player_ids.length > 0 ? currentOrPartial / focus_player_ids.length : 0;
  let marketData: CompetitiveCapability;
  if (marketFrac >= 0.999) marketData = cap("READY");
  else if (marketFrac > 0)
    marketData = cap("PARTIAL", [
      `${currentOrPartial}/${focus_player_ids.length} focus players have current/partial market data${anyStale ? " (some only STALE)" : ""}`,
    ]);
  else marketData = cap("UNAVAILABLE", ["no focus player has current or partial outside-market data"]);

  // ---- scoring compatible -------------------------------------------------
  const scoringCompatible = cap(
    "READY",
    ["provider benchmark is taken directly in league scoring; ADP consensus used for rank/dispersion only"],
  );

  // ---- player identity --------------------------------------------------
  const unresolved = focus_player_ids.filter((id) => {
    const p = players_by_id.get(id);
    return !p || p.resolution.method === "unresolved";
  });
  const playerIdentity: CompetitiveCapability =
    unresolved.length === 0
      ? cap("READY")
      : unresolved.length < focus_player_ids.length
        ? cap("PARTIAL", [`${unresolved.length} focus player id(s) unresolved`])
        : cap("UNAVAILABLE", ["no focus player id resolved"]);

  // ---- ownership -------------------------------------------------------
  const ownership: CompetitiveCapability = input.ownership_known
    ? cap("READY")
    : cap("UNAVAILABLE", ["roster ownership is not known for this league snapshot"]);

  // ---- overall (required set) -----------------------------------------
  const required = [privateProjection, marketData, playerIdentity, ownership];
  let overall: CompetitiveCapabilityState = "READY";
  for (const c of required) overall = worst(overall, c.state);

  const summary =
    overall === "UNAVAILABLE"
      ? "Competitive analysis failed closed — a required capability is unavailable. No market value or edge is produced; only the private baseline evaluation is returned."
      : overall === "PARTIAL"
        ? "Competitive analysis is PARTIAL — edges are produced only where private and market data both exist; gaps are marked INSUFFICIENT_DATA, never zero."
        : "All required competitive capabilities are available.";

  return {
    overall,
    private_projection: privateProjection,
    market_data: marketData,
    scoring_compatible: scoringCompatible,
    player_identity: playerIdentity,
    ownership,
    summary,
  };
}
