/**
 * Trade analysis orchestrator — the one code path behind `POST /api/trades/analyze`.
 *
 *   1. Assemble ONE immutable `TradeAnalysisContext` from a SINGLE league-state
 *      read (Phase 2A) — snapshot, projections, replacement frontier, byes and
 *      the rest-of-season week range all come from that one snapshot, so BEFORE
 *      and AFTER can never be computed from disagreeing state.
 *   2. Resolve every participant through canonical manager resolution and every
 *      transferred player through the snapshot's identifier crosswalk.
 *   3. Validate the proposal (explicit failure codes, never silent correction).
 *   4. `evaluateTrade` — Phase 1 (frozen `ri-trade-foundation-2026.2`) plus the
 *      additive Phase 2 contextual valuation (`ri-trade-contextual-2026.2`) and
 *      the additive, SHADOW-MODE Phase 3 calibration/player-intelligence layer
 *      (`ri-trade-calibrated-2026.2`) — see `lib/trades/phase3.ts`.
 *
 * Degradation is explicit: a provider outage, an auth gap, missing projections
 * or a partial ROS/schedule surface as `status` / `diagnostics`. A Phase 2 or
 * Phase 3 failure never destroys the frozen Phase 1 output.
 */

import { resolveManager } from "@/lib/canonical/manager-context";
import type { CanonicalPlayer } from "@/lib/canonical/schema";

import { resolveTradeConfig, type PartialTradeConfig } from "./config";
import { validateTrade, type TradeResolution } from "./validate";
import { evaluateTrade } from "./evaluate";
import {
  buildTradeAnalysisContext,
  TRADE_CONTEXT_VERSION,
  type BuildTradeContextOptions,
} from "./context";
import { TRADE_CALIBRATED_VERSION } from "./phase3";
import { TRADE_DATA_LAYER_VERSION } from "./data-readiness";
import {
  TRADE_ENGINE_VERSION,
  type TradeAnalysis,
  type TradeDiagnostic,
  type TradeProposal,
  type TradeParticipantInput,
} from "./schema";

export interface AnalyzeTradeOptions extends BuildTradeContextOptions {
  config?: PartialTradeConfig;
}

export async function analyzeTrade(
  proposal: TradeProposal,
  options: AnalyzeTradeOptions = {},
): Promise<TradeAnalysis> {
  const config = resolveTradeConfig(options.config);
  const now = new Date().toISOString();
  const leagueSlug = (proposal.league ?? "").trim();
  const diagnostics: TradeDiagnostic[] = [];

  const base = (extra: Partial<TradeAnalysis>): TradeAnalysis => ({
    status: "OK",
    trade_version: TRADE_ENGINE_VERSION,
    trade_foundation_version: TRADE_ENGINE_VERSION,
    trade_context_version: null,
    trade_calibrated_version: null,
    versions: { foundation: TRADE_ENGINE_VERSION, contextual: null, calibrated: null, data: null },
    league_slug: leagueSlug,
    week: 0,
    config,
    validation: { ok: false, failures: [] },
    normalized: null,
    participants: {},
    trade_summary: null,
    phase2_summary: null,
    phase3_summary: null,
    diagnostics,
    generated_at: now,
    ...extra,
  });

  if (!leagueSlug) {
    return base({
      status: "VALIDATION_FAILED",
      validation: { ok: false, failures: [{ code: "UNKNOWN_MANAGER", message: "A `league` slug is required." }] },
    });
  }

  // ---- ONE league-state read -> immutable context (Phase 2A) ----------------
  const ctxResult = await buildTradeAnalysisContext(leagueSlug, options);
  if (!ctxResult.context) {
    diagnostics.push({
      code: "TRADE_ANALYSIS_DEGRADED",
      message: ctxResult.detail ?? `Trade-analysis context for "${leagueSlug}" is unavailable (${ctxResult.code}).`,
      severity: "error",
    });
    return base({ status: "CONTEXT_UNAVAILABLE" });
  }
  const tctx = ctxResult.context;
  const snap = tctx.snapshot;
  for (const d of tctx.diagnostics) diagnostics.push(d);

  // ---- identity resolution -------------------------------------------------
  const playerById = tctx.players_by_id;
  const bySleeper = new Map<string, CanonicalPlayer>();
  const byNameKey = new Map<string, CanonicalPlayer>();
  for (const p of snap.players) {
    if (p.identifiers.sleeper_id) bySleeper.set(p.identifiers.sleeper_id, p);
    if (p.identifiers.yahoo_id) bySleeper.set(`yahoo:${p.identifiers.yahoo_id}`, p);
    if (p.identifiers.name_key) byNameKey.set(p.identifiers.name_key.toLowerCase(), p);
  }
  const resolvePlayer = (raw: string): CanonicalPlayer | null =>
    playerById.get(raw) ??
    bySleeper.get(raw) ??
    bySleeper.get(`yahoo:${raw}`) ??
    byNameKey.get(raw.toLowerCase()) ??
    null;

  const ownership = new Map<string, string>();
  for (const r of snap.rosters) for (const id of r.all_players) ownership.set(id, r.canonical_team_id);

  const player_positions = new Map<string, string[]>(
    snap.players.map((p) => [p.canonical_player_id, [p.position, ...p.eligible_positions]]),
  );

  const resolvedParticipants = proposal.participants.map((part) => {
    const m = resolveManager(snap.managers, part.manager_id);
    const team = m ? snap.teams.find((t) => t.canonical_manager_ids.includes(m.canonical_manager_id)) ?? null : null;
    return {
      input_id: part.manager_id,
      canonical_manager_id: m?.canonical_manager_id ?? null,
      manager_slug: m?.manager_slug ?? null,
      canonical_team_id: team?.canonical_team_id ?? null,
    };
  });
  const managerIdByInput = new Map(resolvedParticipants.map((p) => [p.input_id, p.canonical_manager_id]));

  const roster_by_manager = new Map(
    resolvedParticipants
      .filter((p) => p.canonical_manager_id && p.canonical_team_id)
      .map((p) => {
        const roster = snap.rosters.find((r) => r.canonical_team_id === p.canonical_team_id)!;
        return [p.canonical_manager_id!, roster] as const;
      })
      .filter(([, r]) => Boolean(r)),
  );

  const resolvedTransfers = proposal.transfers.map((t) => {
    const pl = resolvePlayer(t.asset.player_id);
    return {
      from_input: t.from_manager_id,
      to_input: t.to_manager_id,
      from_manager_id: managerIdByInput.get(t.from_manager_id) ?? null,
      to_manager_id: managerIdByInput.get(t.to_manager_id) ?? null,
      input_player_id: t.asset.player_id,
      canonical_player_id: pl?.canonical_player_id ?? null,
    };
  });

  // Constraints for VALIDATION ONLY (roster size + structural fieldability via
  // `maxSlotMatching`, which derives FLEX eligibility from the slot label). The
  // EVALUATION path uses the fully-resolved `tctx.constraints`.
  const constraintsFromSnap = {
    starting_slots: snap.league.roster_settings.starting_slots,
    slot_requirements: snap.league.roster_settings.slot_requirements,
    bench_slots: snap.league.roster_settings.bench_slots,
    ir_slots: snap.league.roster_settings.ir_slots,
    taxi_slots: snap.league.roster_settings.taxi_slots,
    roster_size_limit:
      snap.league.roster_settings.starting_slots.length +
        snap.league.roster_settings.bench_slots +
        snap.league.roster_settings.ir_slots +
        snap.league.roster_settings.taxi_slots || null,
    active_roster_capacity: snap.league.roster_settings.starting_slots.length + snap.league.roster_settings.bench_slots,
    reserve_ir_capacity: snap.league.roster_settings.ir_slots,
    taxi_capacity: snap.league.roster_settings.taxi_slots,
    flex_positions: ["RB", "WR", "TE"],
    flex_slots: snap.league.roster_settings.starting_slots.filter(
      (s) => !["QB", "RB", "WR", "TE", "K", "DEF", "BN", "IR"].includes(s),
    ).length,
  };

  const resolution: TradeResolution = {
    league_slug: leagueSlug,
    participants: resolvedParticipants,
    transfers: resolvedTransfers,
    ownership,
    roster_by_manager,
    constraints: constraintsFromSnap,
    player_positions,
  };

  const { result: validation, normalized } = validateTrade(resolution);
  if (!validation.ok || !normalized) {
    return base({
      status: "VALIDATION_FAILED",
      validation,
      week: snap.week,
      trade_context_version: TRADE_CONTEXT_VERSION,
      versions: { foundation: TRADE_ENGINE_VERSION, contextual: TRADE_CONTEXT_VERSION, calibrated: null, data: null },
    });
  }

  const players_by_id = new Map<string, CanonicalPlayer>(playerById);

  const participants: TradeParticipantInput[] = normalized.participant_manager_ids.map((mid) => {
    const rp = resolvedParticipants.find((p) => p.canonical_manager_id === mid)!;
    return {
      manager: snap.managers.find((m) => m.canonical_manager_id === mid)!,
      team: snap.teams.find((t) => t.canonical_team_id === rp.canonical_team_id)!,
      roster: roster_by_manager.get(mid)!,
    };
  });

  const evaluation = evaluateTrade({
    normalized,
    week: tctx.week,
    constraints: tctx.constraints,
    team_count: tctx.team_count,
    projections: tctx.projections,
    replacement: tctx.replacement,
    players_by_id,
    participants,
    config,
    projections_status: tctx.projections.status,
    context: tctx,
  });

  return base({
    status: "OK",
    week: tctx.week,
    trade_context_version: TRADE_CONTEXT_VERSION,
    trade_calibrated_version: TRADE_CALIBRATED_VERSION,
    versions: { foundation: TRADE_ENGINE_VERSION, contextual: TRADE_CONTEXT_VERSION, calibrated: TRADE_CALIBRATED_VERSION, data: TRADE_DATA_LAYER_VERSION },
    validation,
    normalized,
    participants: evaluation.participants,
    trade_summary: evaluation.trade_summary,
    phase2_summary: evaluation.phase2_summary,
    phase3_summary: evaluation.phase3_summary,
    diagnostics: [...diagnostics, ...evaluation.diagnostics],
  });
}
