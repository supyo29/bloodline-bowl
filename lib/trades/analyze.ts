/**
 * Trade analysis orchestrator — the one code path behind `POST /api/trades/analyze`.
 *
 *   1. Load ONE canonical league snapshot (managers, teams, rosters, players).
 *   2. Resolve every participant through canonical manager resolution and every
 *      transferred player through the snapshot's identifier crosswalk.
 *   3. Validate the proposal (explicit failure codes, never silent correction).
 *   4. Build ONE shared `WeeklyTeamContext` (projections + replacement frontier +
 *      roster constraints) — the SAME inputs the lineup / waiver engines use.
 *   5. Evaluate every participating roster before/after (`evaluateTrade`).
 *
 * Degradation is explicit: a provider outage, an auth gap, or missing
 * projections surface as `status` / `diagnostics`, never as an optimistic
 * default.
 */

import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { resolveManager } from "@/lib/canonical/manager-context";
import { buildWeeklyTeamContext, type BuildWeeklyContextOptions } from "@/lib/weekly/context";
import type { CanonicalPlayer } from "@/lib/canonical/schema";

import { resolveTradeConfig, type PartialTradeConfig } from "./config";
import { validateTrade, type TradeResolution } from "./validate";
import { evaluateTrade } from "./evaluate";
import {
  TRADE_ENGINE_VERSION,
  type TradeAnalysis,
  type TradeDiagnostic,
  type TradeProposal,
  type TradeParticipantInput,
} from "./schema";

export interface AnalyzeTradeOptions extends BuildWeeklyContextOptions {
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
    league_slug: leagueSlug,
    week: 0,
    config,
    validation: { ok: false, failures: [] },
    normalized: null,
    participants: {},
    trade_summary: null,
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

  const state = await buildCanonicalLeagueState(leagueSlug, {
    includeMatchups: false,
    includeRecentTransactions: false,
    providerOverride: options.providerOverride,
    crosswalkOverride: options.crosswalkOverride,
  });
  if (!state.snapshot) {
    diagnostics.push({ code: "TRADE_ANALYSIS_DEGRADED", message: state.detail ?? `Canonical league state for "${leagueSlug}" is unavailable (${state.code}).`, severity: "error" });
    return base({ status: "CONTEXT_UNAVAILABLE" });
  }
  const snap = state.snapshot;

  // ---- identity resolution -------------------------------------------------
  const playerById = new Map<string, CanonicalPlayer>(snap.players.map((p) => [p.canonical_player_id, p]));
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

  // ownership (whole league, pre-trade): canonical_player_id -> owning team id
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
  // `maxSlotMatching`, which derives FLEX eligibility from the slot label itself
  // through `slotEligiblePositions`). `flex_positions` below is a coarse default
  // and is NOT consulted by the structural check. The EVALUATION path uses the
  // fully-resolved `wctx.league.roster_constraints` from the weekly context.
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
    flex_slots: snap.league.roster_settings.starting_slots.filter((s) => !["QB", "RB", "WR", "TE", "K", "DEF", "BN", "IR"].includes(s)).length,
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
    return base({ status: "VALIDATION_FAILED", validation, week: snap.week });
  }

  // ---- shared weekly context (projections + replacement + real constraints) ----
  const primarySlug = resolvedParticipants[0]!.manager_slug!;
  const ctxResult = await buildWeeklyTeamContext(leagueSlug, primarySlug, {
    ...options,
    week: options.week,
  });
  if (!ctxResult.context) {
    diagnostics.push({
      code: "TRADE_ANALYSIS_DEGRADED",
      message:
        ctxResult.detail ??
        `Weekly context for "${leagueSlug}" is unavailable (${ctxResult.code}) — projections and replacement levels cannot be assembled.`,
      severity: "error",
    });
    return base({ status: "CONTEXT_UNAVAILABLE", validation, normalized, week: snap.week });
  }
  const wctx = ctxResult.context;

  // Consistency guard between the two league-state reads (the snapshot above and
  // the one buildWeeklyTeamContext builds internally). `evaluateTrade` itself is
  // pure/deterministic; this catches the provider changing state mid-request.
  const primaryManagerId = resolvedParticipants[0]!.canonical_manager_id!;
  const snapPrimaryRoster = roster_by_manager.get(primaryManagerId);
  if (snapPrimaryRoster) {
    const a = [...snapPrimaryRoster.all_players].sort().join(",");
    const b = [...wctx.roster.all_players].sort().join(",");
    if (a !== b) {
      diagnostics.push({
        code: "TRADE_ANALYSIS_DEGRADED",
        message:
          "Two league-state reads during analysis disagreed on the primary participant's roster — the underlying provider state changed mid-request. Re-run for a consistent result.",
        severity: "warning",
      });
    }
  }

  const players_by_id = new Map<string, CanonicalPlayer>(playerById);
  for (const [id, p] of wctx.projections.resolved_players) if (!players_by_id.has(id)) players_by_id.set(id, p);

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
    week: wctx.league.week,
    constraints: wctx.league.roster_constraints,
    team_count: snap.league.team_count,
    projections: wctx.projections,
    replacement: wctx.replacement,
    players_by_id,
    participants,
    config,
    projections_status: wctx.projections.status,
  });

  return base({
    status: "OK",
    week: wctx.league.week,
    validation,
    normalized,
    participants: evaluation.participants,
    trade_summary: evaluation.trade_summary,
    diagnostics: [...diagnostics, ...evaluation.diagnostics],
  });
}
