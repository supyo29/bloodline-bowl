/**
 * REHEARSAL-ONLY — standalone Sleeper mock-draft override for the recommendation
 * pipeline.
 *
 * This module contains the SMALL, PURE mapping from a Sleeper mock draft's raw
 * metadata + picks into the exact draft-state shape the frozen `recommendDraft`
 * engine already consumes. It exists so draft-night rehearsal can point the
 * Bloodline engine at a live mock draft board WITHOUT touching:
 *
 *   - the Bloodline league id / registry
 *   - the real Bloodline draft id
 *   - projections, scoring, market, survival, tiers, replacement levels
 *   - the frozen decision weights or snake geometry
 *   - production defaults (the override is opt-in via `?draft_id=`)
 *
 * The engine still runs on BLOODLINE geometry (this league's team count + round
 * count). The mock supplies only "who has been drafted" and "which of those are
 * this manager's". Everything else stays Bloodline.
 *
 * NOT wired into any production code path unless a caller explicitly passes a
 * mock draft id, and the route only honours that on non-production deployments.
 */

import type { FantasyPosition } from "@/lib/projections/schema";
import { slimPlayer } from "@/lib/sleeper/client";
import type { NormalizedPlayer, RawDraft, RawDraftPick } from "@/lib/sleeper/types";

import type { CompletedPick } from "./engine";

const SKILL = new Set<FantasyPosition>(["QB", "RB", "WR", "TE", "K", "DEF"]);

function asSkill(pos: string | null | undefined): FantasyPosition | null {
  return pos && SKILL.has(pos as FantasyPosition) ? (pos as FantasyPosition) : null;
}

export interface MockDraftInfo {
  draft_id: string;
  /** Sleeper mock status: pre_draft | drafting | paused | complete */
  status: string;
  /** Sleeper mock draft type — the SNAKE_ONLY gate still applies. */
  type: string;
  /** what the MOCK is configured for (reported for transparency, not applied) */
  mock_teams: number | null;
  mock_rounds: number | null;
  /** picks with a player, loaded from the mock */
  picks_loaded: number;
  /** the slot used for this manager, and how it was chosen */
  applied_slot: number;
  slot_source: "mock_draft_order" | "explicit_request" | "default_slot_7";
  /** the geometry frame actually applied (Bloodline's, not the mock's) */
  applied_teams: number;
  applied_rounds: number;
}

export interface MockDraftState {
  draft_type: string | null;
  completed_picks: CompletedPick[];
  roster_players: NormalizedPlayer[];
  applied_slot: number;
  info: MockDraftInfo;
}

/**
 * Derive the engine's draft-state inputs from a Sleeper mock draft.
 *
 * @param meta          `GET /v1/draft/<id>` payload
 * @param picks         `GET /v1/draft/<id>/picks` payload
 * @param playerIndex   the shared Sleeper player index (for position lookup)
 * @param managerUserId this manager's Sleeper user id (for the draft_order lookup)
 * @param requestedSlot an explicit `?slot=` override, or null
 * @param numTeams      BLOODLINE team count (geometry frame)
 * @param rounds        BLOODLINE round count (geometry frame)
 */
export function deriveMockDraftState(params: {
  meta: RawDraft;
  picks: RawDraftPick[];
  playerIndex: ReadonlyMap<string, NormalizedPlayer>;
  managerUserId: string;
  requestedSlot: number | null;
  numTeams: number;
  rounds: number;
}): MockDraftState {
  const { meta, picks, playerIndex, managerUserId, requestedSlot, numTeams, rounds } = params;

  // slot resolution: mock's own draft_order wins; then an explicit request; then
  // the documented rehearsal default (supyo29 == slot 7).
  const orderSlot =
    meta.draft_order && typeof meta.draft_order[managerUserId] === "number"
      ? meta.draft_order[managerUserId]!
      : null;
  let applied_slot: number;
  let slot_source: MockDraftInfo["slot_source"];
  if (orderSlot != null && orderSlot >= 1) {
    applied_slot = orderSlot;
    slot_source = "mock_draft_order";
  } else if (requestedSlot != null && requestedSlot >= 1) {
    applied_slot = requestedSlot;
    slot_source = "explicit_request";
  } else {
    applied_slot = 7;
    slot_source = "default_slot_7";
  }

  const completed_picks: CompletedPick[] = picks
    .filter((p) => typeof p.player_id === "string" && p.player_id.length > 0)
    .map((p) => ({
      overall: p.pick_no,
      roster_id:
        typeof p.roster_id === "number"
          ? p.roster_id
          : typeof p.roster_id === "string" && p.roster_id.length > 0
            ? Number.parseInt(p.roster_id, 10)
            : null,
      player_id: p.player_id,
      position: asSkill(playerIndex.get(p.player_id ?? "")?.position ?? null),
    }));

  // This manager's roster = their slot's picks, clamped to the Bloodline frame
  // (a 16-round mock must not hand a 15-round league a 16-man roster).
  const frameLimit = numTeams * rounds;
  const roster_players: NormalizedPlayer[] = picks
    .filter(
      (p) =>
        p.draft_slot === applied_slot &&
        typeof p.player_id === "string" &&
        p.player_id.length > 0 &&
        p.pick_no <= frameLimit,
    )
    .sort((a, b) => a.pick_no - b.pick_no)
    .map((p) => playerIndex.get(p.player_id!) ?? slimPlayer(p.player_id!, undefined));

  return {
    draft_type: meta.type ?? null,
    completed_picks,
    roster_players,
    applied_slot,
    info: {
      draft_id: meta.draft_id,
      status: meta.status,
      type: meta.type,
      mock_teams: meta.settings?.teams ?? null,
      mock_rounds: meta.settings?.rounds ?? null,
      picks_loaded: completed_picks.length,
      applied_slot,
      slot_source,
      applied_teams: numTeams,
      applied_rounds: rounds,
    },
  };
}

/** Human-readable banner pushed onto `response.warnings` when the override is live. */
export function mockOverrideWarning(info: MockDraftInfo): string {
  return (
    `REHEARSAL MOCK-DRAFT OVERRIDE ACTIVE — pick state consumed from Sleeper mock draft ` +
    `${info.draft_id} (status: ${info.status}, type: ${info.type}; mock configured for ` +
    `${info.mock_teams ?? "?"} teams / ${info.mock_rounds ?? "?"} rounds). Applied BLOODLINE ` +
    `${info.applied_teams}-team / ${info.applied_rounds}-round snake geometry at slot ` +
    `${info.applied_slot} (source: ${info.slot_source}); ${info.picks_loaded} picks loaded. ` +
    `Bloodline scoring, projections, market consensus, survival model, tiers, replacement ` +
    `levels, K/DEF policy and decision weights are UNCHANGED. This is NOT the real Bloodline draft.`
  );
}
