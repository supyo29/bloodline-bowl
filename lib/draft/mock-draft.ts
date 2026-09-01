/**
 * REHEARSAL-ONLY — standalone Sleeper mock-draft override for the recommendation
 * pipeline.
 *
 * PURE mapping + validation from a Sleeper mock draft's raw metadata + picks into
 * the exact draft-state shape the frozen `recommendDraft` engine consumes, so a
 * draft-night rehearsal can point the Bloodline engine at a LIVE mock draft board
 * WITHOUT touching:
 *
 *   - the Bloodline league id / registry / the real Bloodline draft id
 *   - projections, scoring, market, survival, tiers, replacement levels
 *   - the frozen decision weights, the pair optimiser, or K/DST policy
 *   - production defaults (the override is opt-in via `?draft_id=`, preview-only)
 *
 * The engine runs on the BLOODLINE geometry FRAME — this league's team count and
 * round count. The mock supplies ONLY which players have been drafted and which
 * of those are this manager's. A mock with more rounds than Bloodline (Sleeper
 * mocks are often 16 rounds; Bloodline is 15) is CLAMPED to the Bloodline frame:
 * picks beyond `numTeams * rounds` are invisible to the engine — they must not
 * affect availability, roster, terminal state, turn geometry, or counts.
 *
 * `validateMockDraftState` classifies the source payload VALID / DEGRADED /
 * INVALID; an INVALID source must PREVENT recommendations, not feed corrupt
 * state into the engine.
 */

import type { FantasyPosition } from "@/lib/projections/schema";
import { slimPlayer } from "@/lib/sleeper/client";
import type { NormalizedPlayer, RawDraft, RawDraftPick } from "@/lib/sleeper/types";

import { computeSnakeTurnState } from "./geometry";
import type { CompletedPick } from "./engine";
import type { RecommendationResponse } from "./schema";

const SKILL = new Set<FantasyPosition>(["QB", "RB", "WR", "TE", "K", "DEF"]);

function asSkill(pos: string | null | undefined): FantasyPosition | null {
  return pos && SKILL.has(pos as FantasyPosition) ? (pos as FantasyPosition) : null;
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function playerName(playerId: string | null, playerIndex: ReadonlyMap<string, NormalizedPlayer>): string {
  if (!playerId) return "(empty)";
  return playerIndex.get(playerId)?.full_name ?? playerId;
}

export type MockSlotSource = "mock_draft_order" | "explicit_request" | "default_slot_7";
export type MockStateValidation = "VALID" | "DEGRADED" | "INVALID";

export interface MockDraftInfo {
  draft_id: string;
  status: string;
  type: string;
  mock_teams: number | null;
  mock_rounds: number | null;
  /** framed picks with a player (== `diagnostics.framed_pick_count`) */
  picks_loaded: number;
  applied_slot: number;
  slot_source: MockSlotSource;
  applied_teams: number;
  applied_rounds: number;
}

export interface MockDraftDiagnostics {
  draft_id: string;
  requested_draft_id: string;
  source_status: string;
  source_type: string;
  source_teams: number | null;
  source_rounds: number | null;
  source_created_iso: string | null;
  source_last_picked_iso: string | null;

  applied_teams: number;
  applied_rounds: number;
  frame_limit: number;

  raw_pick_count: number;
  framed_pick_count: number;
  raw_max_pick_no: number;
  framed_max_pick_no: number;
  picks_discarded_outside_frame: number;

  applied_slot: number;
  slot_source: MockSlotSource;

  manager_expected_pick_numbers: number[];
  manager_source_picks: number[];
  manager_roster_count: number;

  recent_picks: Array<{
    pick_no: number;
    draft_slot: number;
    player_id: string | null;
    player_name: string;
  }>;

  state_validation: MockStateValidation;
  validation_reasons: string[];
}

export interface MockDraftState {
  draft_type: string | null;
  completed_picks: CompletedPick[];
  roster_players: NormalizedPlayer[];
  applied_slot: number;
  info: MockDraftInfo;
  diagnostics: MockDraftDiagnostics;
}

/* ------------------------------------------------------------------ slot */

function resolveSlot(
  meta: RawDraft,
  managerUserId: string,
  requestedSlot: number | null,
): { applied_slot: number; slot_source: MockSlotSource } {
  const orderSlot =
    meta.draft_order && typeof meta.draft_order[managerUserId] === "number"
      ? meta.draft_order[managerUserId]!
      : null;
  if (orderSlot != null && orderSlot >= 1) return { applied_slot: orderSlot, slot_source: "mock_draft_order" };
  if (requestedSlot != null && requestedSlot >= 1)
    return { applied_slot: requestedSlot, slot_source: "explicit_request" };
  return { applied_slot: 7, slot_source: "default_slot_7" };
}

/* -------------------------------------------------------------- validation */

/**
 * Classify a mock draft payload before it can reach the engine.
 *
 * INVALID  — the payload is internally impossible or not the draft we asked for.
 *            Recommendations MUST be withheld.
 * DEGRADED — usable, but the source disagrees with itself or with the Bloodline
 *            frame (e.g. a completed draft, or a different round count). The
 *            engine runs; the response makes the caveat loud.
 * VALID    — internally consistent and in-progress against the Bloodline frame.
 */
export function validateMockDraftState(args: {
  meta: RawDraft;
  requestedDraftId: string;
  numTeams: number;
  rounds: number;
  frameLimit: number;
  rawPickCount: number;
  framedPickCount: number;
  framedMaxPickNo: number;
  framedPickNumbers: number[];
  rawHasNonPositiveIntPickNo: boolean;
  managerSourcePicks: number[];
  managerExpectedPickNumbers: number[];
}): { state_validation: MockStateValidation; validation_reasons: string[] } {
  const reasons: string[] = [];
  let level: MockStateValidation = "VALID";
  const bump = (to: MockStateValidation) => {
    const rank = { VALID: 0, DEGRADED: 1, INVALID: 2 } as const;
    if (rank[to] > rank[level]) level = to;
  };

  // ---- INVALID: internally impossible / wrong draft ----------------------
  if (args.meta.draft_id && args.meta.draft_id !== args.requestedDraftId) {
    reasons.push(
      `draft id mismatch: requested ${args.requestedDraftId}, Sleeper returned ${args.meta.draft_id}`,
    );
    bump("INVALID");
  }
  if (typeof args.meta.type !== "string" || args.meta.type.trim() === "") {
    reasons.push(`mock draft type is missing or malformed (${JSON.stringify(args.meta.type)})`);
    bump("INVALID");
  }
  if (args.rawHasNonPositiveIntPickNo) {
    reasons.push("at least one Sleeper pick has a non-positive or non-integer pick_no");
    bump("INVALID");
  }
  const dupFramed = args.framedPickNumbers.length !== new Set(args.framedPickNumbers).size;
  if (dupFramed) {
    reasons.push("duplicate overall pick numbers within the Bloodline frame");
    bump("INVALID");
  }
  if (args.framedPickCount > args.frameLimit) {
    reasons.push(
      `framed pick count ${args.framedPickCount} exceeds the Bloodline frame (${args.numTeams}×${args.rounds} = ${args.frameLimit})`,
    );
    bump("INVALID");
  }
  if (args.framedMaxPickNo > args.frameLimit) {
    reasons.push(`a framed pick number (${args.framedMaxPickNo}) exceeds the Bloodline frame limit ${args.frameLimit}`);
    bump("INVALID");
  }
  if (args.managerSourcePicks.length > args.rounds) {
    reasons.push(
      `this manager owns ${args.managerSourcePicks.length} framed picks — snake geometry permits at most ${args.rounds}`,
    );
    bump("INVALID");
  }
  const expected = new Set(args.managerExpectedPickNumbers);
  const offGeometry = args.managerSourcePicks.filter((n) => !expected.has(n));
  if (offGeometry.length > 0) {
    reasons.push(
      `this manager has selections at pick number(s) ${offGeometry.join(", ")}, which cannot belong to slot ${
        args.managerExpectedPickNumbers.length ? "geometry" : "?"
      } (expected ${args.managerExpectedPickNumbers.join(", ")})`,
    );
    bump("INVALID");
  }

  // ---- DEGRADED: usable but self-inconsistent / off-frame ---------------
  if (args.meta.settings?.rounds != null && args.meta.settings.rounds !== args.rounds) {
    reasons.push(
      `mock is configured for ${args.meta.settings.rounds} rounds; Bloodline is ${args.rounds} — picks in rounds ${
        args.rounds + 1
      }+ are clamped out`,
    );
    bump("DEGRADED");
  }
  if (args.meta.settings?.teams != null && args.meta.settings.teams !== args.numTeams) {
    reasons.push(`mock is configured for ${args.meta.settings.teams} teams; Bloodline is ${args.numTeams}`);
    bump("DEGRADED");
  }
  if (args.meta.status === "complete") {
    reasons.push(
      "source draft status is 'complete' — this draft is finished and cannot be followed pick-by-pick; " +
        "start a fresh in-progress Sleeper draft and pass its id",
    );
    bump("DEGRADED");
  }
  if (args.meta.status === "pre_draft" && args.framedPickCount > 0) {
    reasons.push(`source status is 'pre_draft' but ${args.framedPickCount} picks are present`);
    bump("DEGRADED");
  }
  if (
    (args.meta.status === "drafting" || args.meta.status === "paused" || args.meta.status === "complete") &&
    args.rawPickCount === 0
  ) {
    reasons.push(`source status is '${args.meta.status}' but Sleeper returned zero picks`);
    bump("DEGRADED");
  }

  return { state_validation: level, validation_reasons: reasons };
}

/* ---------------------------------------------------------------- derive */

/**
 * Derive the engine's draft-state inputs from a Sleeper mock draft, CLAMPED to
 * the Bloodline geometry frame.
 */
export function deriveMockDraftState(params: {
  meta: RawDraft;
  picks: RawDraftPick[];
  playerIndex: ReadonlyMap<string, NormalizedPlayer>;
  managerUserId: string;
  requestedDraftId: string;
  requestedSlot: number | null;
  /** BLOODLINE team count (geometry frame) */
  numTeams: number;
  /** BLOODLINE round count (geometry frame) */
  rounds: number;
}): MockDraftState {
  const { meta, picks, playerIndex, managerUserId, requestedDraftId, requestedSlot, numTeams, rounds } = params;

  const frameLimit = numTeams * rounds;
  const { applied_slot, slot_source } = resolveSlot(meta, managerUserId, requestedSlot);

  // ---- raw-source shape (for diagnostics + validation) ------------------
  const rawWithPlayer = picks.filter((p) => typeof p.player_id === "string" && p.player_id.length > 0);
  const rawPickNos = rawWithPlayer.map((p) => p.pick_no);
  const rawMaxPickNo = rawPickNos.length ? Math.max(...rawPickNos) : 0;
  const rawHasNonPositiveIntPickNo = rawWithPlayer.some((p) => !isPositiveInt(p.pick_no));

  // ---- FRAME CLAMP: a pick enters the engine's state ONLY when its overall
  //      pick number is a positive integer within the Bloodline frame. The
  //      16th mock round is completely invisible to the 15-round engine.
  const framed = rawWithPlayer.filter((p) => isPositiveInt(p.pick_no) && p.pick_no <= frameLimit);
  const framedPickNos = framed.map((p) => p.pick_no);
  const framedMaxPickNo = framedPickNos.length ? Math.max(...framedPickNos) : 0;
  const picksDiscardedOutsideFrame = rawWithPlayer.length - framed.length;

  const completed_picks: CompletedPick[] = framed
    .slice()
    .sort((a, b) => a.pick_no - b.pick_no)
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

  // ---- this manager's roster: their slot's FRAMED picks -----------------
  const managerFramed = framed
    .filter((p) => p.draft_slot === applied_slot)
    .sort((a, b) => a.pick_no - b.pick_no);
  const roster_players: NormalizedPlayer[] = managerFramed.map(
    (p) => playerIndex.get(p.player_id!) ?? slimPlayer(p.player_id!, undefined),
  );
  const managerSourcePicks = managerFramed.map((p) => p.pick_no);

  // ---- geometry: this manager's expected pick numbers ------------------
  const fullTurn = computeSnakeTurnState({
    slot: applied_slot,
    teamCount: numTeams,
    rounds,
    overallPicksMade: 0,
    order: meta.type === "linear" ? "linear" : "snake",
  });
  const managerExpectedPickNumbers = fullTurn.all_picks.map((p) => p.overall);

  // ---- validate --------------------------------------------------------
  const validation = validateMockDraftState({
    meta,
    requestedDraftId,
    numTeams,
    rounds,
    frameLimit,
    rawPickCount: rawWithPlayer.length,
    framedPickCount: framed.length,
    framedMaxPickNo,
    framedPickNumbers: framedPickNos,
    rawHasNonPositiveIntPickNo,
    managerSourcePicks,
    managerExpectedPickNumbers,
  });

  // ---- recent picks (framed, last 5) ----------------------------------
  const recent_picks = framed
    .slice()
    .sort((a, b) => a.pick_no - b.pick_no)
    .slice(-5)
    .map((p) => ({
      pick_no: p.pick_no,
      draft_slot: p.draft_slot,
      player_id: p.player_id,
      player_name: playerName(p.player_id, playerIndex),
    }));

  const diagnostics: MockDraftDiagnostics = {
    draft_id: meta.draft_id,
    requested_draft_id: requestedDraftId,
    source_status: meta.status,
    source_type: meta.type,
    source_teams: meta.settings?.teams ?? null,
    source_rounds: meta.settings?.rounds ?? null,
    source_created_iso: iso(meta.created),
    source_last_picked_iso: iso(meta.last_picked),
    applied_teams: numTeams,
    applied_rounds: rounds,
    frame_limit: frameLimit,
    raw_pick_count: rawWithPlayer.length,
    framed_pick_count: framed.length,
    raw_max_pick_no: rawMaxPickNo,
    framed_max_pick_no: framedMaxPickNo,
    picks_discarded_outside_frame: picksDiscardedOutsideFrame,
    applied_slot,
    slot_source,
    manager_expected_pick_numbers: managerExpectedPickNumbers,
    manager_source_picks: managerSourcePicks,
    manager_roster_count: roster_players.length,
    recent_picks,
    state_validation: validation.state_validation,
    validation_reasons: validation.validation_reasons,
  };

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
      picks_loaded: framed.length,
      applied_slot,
      slot_source,
      applied_teams: numTeams,
      applied_rounds: rounds,
    },
    diagnostics,
  };
}

/**
 * Wrap a FROZEN engine response in the rehearsal presentation layer WITHOUT
 * mutating it — `recommendDraft()`'s result is never touched after it returns.
 *
 *   - VALID / DEGRADED: append the banner + diagnostics; the engine's decision is
 *     preserved exactly.
 *   - INVALID: additionally blank every actionable field and force BLOCKED. A
 *     rejected source state must never surface a pick.
 */
export function assembleRehearsalResponse(
  engineResponse: RecommendationResponse,
  diagnostics: MockDraftDiagnostics,
  invalid: boolean,
): RecommendationResponse {
  const warnings = [mockOverrideWarning(diagnostics), ...engineResponse.warnings];

  // VALID / DEGRADED mock state: preserve the frozen engine response exactly and
  // only append rehearsal metadata.
  if (!invalid) {
    return { ...engineResponse, warnings, mock_draft_diagnostics: diagnostics };
  }

  // INVALID mock state: never expose recommendations derived from a rejected
  // source state.
  return {
    ...engineResponse,
    readiness: {
      ...engineResponse.readiness,
      snake_engine_status: "BLOCKED",
      blocked_reasons: [
        `mock draft ${diagnostics.draft_id} failed source-integrity validation — ` +
          `recommendations withheld: ${diagnostics.validation_reasons.join("; ")}`,
        ...engineResponse.readiness.blocked_reasons,
      ],
    },
    primary_recommendation: null,
    alternates: [],
    wait_candidates: [],
    do_not_reach: [],
    primary_pair: null,
    alternate_pairs: [],
    warnings,
    mock_draft_diagnostics: diagnostics,
  };
}

/** Human-readable banner pushed onto `response.warnings` when the override is live. */
export function mockOverrideWarning(d: MockDraftDiagnostics): string {
  const framing =
    d.picks_discarded_outside_frame > 0
      ? ` ${d.raw_pick_count} raw picks → ${d.framed_pick_count} framed (${d.picks_discarded_outside_frame} beyond the ${d.frame_limit}-pick Bloodline frame discarded).`
      : ` ${d.framed_pick_count} framed picks.`;
  const caveat =
    d.state_validation === "VALID"
      ? ""
      : ` STATE ${d.state_validation}: ${d.validation_reasons.join("; ")}.`;
  return (
    `REHEARSAL MOCK-DRAFT OVERRIDE ACTIVE — pick state from Sleeper draft ${d.draft_id} ` +
    `(status: ${d.source_status}, type: ${d.source_type}; mock configured for ${d.source_teams ?? "?"} teams / ` +
    `${d.source_rounds ?? "?"} rounds). Applied BLOODLINE ${d.applied_teams}-team / ${d.applied_rounds}-round snake ` +
    `geometry at slot ${d.applied_slot} (source: ${d.slot_source}).${framing}${caveat} ` +
    `Bloodline scoring, projections, market consensus, survival model, tiers, replacement levels, K/DEF policy ` +
    `and decision weights are UNCHANGED. This is NOT the real Bloodline draft.`
  );
}
