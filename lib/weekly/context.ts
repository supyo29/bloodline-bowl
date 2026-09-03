/**
 * Weekly Context Engine — the single shared input for the matchup, lineup and
 * waiver decision layers.
 *
 * `buildWeeklyTeamContext(league, manager, week?)` assembles ONE
 * `WeeklyTeamContext` from canonical current-state, canonical matchups, the
 * `ProjectionProvider`, the shared replacement framework, and league-scoped
 * availability. Each analytics module reads this object — none of them rebuilds
 * league context.
 *
 * Canonical only. A provider outage / auth gap / missing projections all degrade
 * EXPLICITLY (`status`, `data_quality`, `warnings`); a missing source never
 * becomes a silent zero. Historical persistence being down does NOT block this —
 * analytics run entirely from canonical current-state.
 */

import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { resolveManager } from "@/lib/canonical/manager-context";
import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import { defaultCrosswalkSource } from "@/lib/persistence/supabase/crosswalk-source";
import { getProvider } from "@/lib/providers/registry";
import { resolveLeagueStrict } from "@/lib/leagues/resolve";
import { getWeeklyProjectionProvider } from "./projections/registry";
import { getScheduleProvider } from "./schedule/registry";
import type { ScheduleProvider } from "./schedule/types";
import { RosterIntelSeasonSignalProvider, type RiSeasonSignalProvider } from "./projections-ri";
import { assembleRosSignals, type RosAssemblyResult } from "./ros";
import { buildLeagueAvailability } from "./availability";
import { computeWeeklyReplacement, type ReplacementFrontier } from "./replacement";
import {
  WEEKLY_ENGINE_VERSION,
  type ByeInfo,
  type DataQualityStatus,
  type PositionalNeed,
  type RosterConstraints,
  type WeeklyTeamContext,
  type WeeklyWarning,
} from "./schema";
import type {
  CanonicalMatchup,
  CanonicalPlayer,
  CanonicalRoster,
} from "@/lib/canonical/schema";

import { BASE_STARTING, FLEX_ELIGIBILITY, isFlexSlot, maxSlotMatching, slotEligiblePositions } from "./slots";
import { buildOptimalLineup } from "./lineup";

export interface WeeklyContextResult {
  ok: boolean;
  status: number;
  code?: string;
  detail?: string;
  context: WeeklyTeamContext | null;
}

export interface BuildWeeklyContextOptions {
  week?: number;
  /** tests inject these */
  crosswalkOverride?: PlayerCrosswalk;
  providerOverride?: ReturnType<typeof getProvider>;
  projectionProviderOverride?: ReturnType<typeof getWeeklyProjectionProvider>;
  scheduleProviderOverride?: ScheduleProvider;
  /** Inject the RI season-signal provider (tests). `null` disables it. */
  riSeasonProviderOverride?: RiSeasonSignalProvider | null;
  wantRestOfSeason?: boolean;
  /** Skip the RI season signal entirely (default: attempt it best-effort). */
  skipRiSeasonSignal?: boolean;
  /** Override the replacement-frontier strategy (default `{nth_best_available, n:1}`). */
  replacementFrontier?: ReplacementFrontier;
  /**
   * Assemble the weekly context from an ALREADY-BUILT canonical snapshot instead
   * of performing a fresh `buildCanonicalLeagueState` read. This is the
   * single-provider-read path used by the trade engine (Phase 2A): the caller
   * reads league state ONCE and threads the same immutable snapshot into every
   * derived context, so two reads can never disagree mid-analysis. When set,
   * `providerOverride` / `crosswalkOverride` are not consulted for the read (the
   * snapshot is authoritative); everything downstream (projections, replacement,
   * byes, positional needs) is derived from this snapshot exactly as normal.
   */
  snapshotOverride?: import("@/lib/canonical/schema").CanonicalLeagueSnapshot;
}

export async function buildWeeklyTeamContext(
  leagueSlug: string,
  managerSlug: string,
  options: BuildWeeklyContextOptions = {},
): Promise<WeeklyContextResult> {
  const resolution = resolveLeagueStrict(leagueSlug);
  if (!resolution.ok) {
    return { ok: false, status: resolution.status, code: resolution.code, detail: resolution.detail, context: null };
  }
  const league = resolution.league;

  const crosswalk =
    options.crosswalkOverride ??
    (defaultCrosswalkSource() ? new PlayerCrosswalk(defaultCrosswalkSource()!) : new PlayerCrosswalk(NoCrosswalk));

  const state = options.snapshotOverride
    ? { ok: true, status: 200, code: undefined as string | undefined, detail: undefined as string | undefined, snapshot: options.snapshotOverride }
    : await buildCanonicalLeagueState(leagueSlug, {
        includeMatchups: true,
        includeRecentTransactions: true,
        reportPersistence: true,
        providerOverride: options.providerOverride,
        crosswalkOverride: crosswalk,
      });
  if (!state.snapshot) {
    return {
      ok: false,
      status: state.status,
      code: state.code ?? "league_state_unavailable",
      detail: state.detail,
      context: null,
    };
  }
  const snap = state.snapshot;
  const warnings: WeeklyWarning[] = snap.warnings.map((w) => ({ code: w.code, message: w.message, severity: "warning" }));

  // ---- Distinguish three pre-manager-resolution states:
  //   (a) auth / configuration degradation  -> honest 200 "configure me"
  //   (b) provider FAILURE (PROVIDER_ERROR, upstream 5xx, malformed bundle)
  //       -> came back as a degraded SHELL with an empty manager list. Propagate
  //          it as the infrastructure failure it is. It must NEVER fall through
  //          to manager resolution, which would mis-report it as a 404
  //          `manager_not_in_league`.
  //   (c) usable canonical live state (READY / PARTIAL with real managers) -> continue.
  if (snap.live_provider_status === "NOT_CONFIGURED" || snap.live_provider_status === "AUTH_REQUIRED") {
    return {
      ok: true,
      status: 200,
      code: snap.live_provider_status,
      detail: `Provider "${league.provider}" is ${snap.live_provider_status}; weekly analytics need live league state.`,
      context: null,
    };
  }
  const providerFailed =
    !state.ok ||
    snap.live_provider_status === "PROVIDER_ERROR" ||
    (snap.managers.length === 0 && (snap.teams.length === 0 || snap.rosters.length === 0));
  if (providerFailed) {
    const code =
      snap.live_provider_status && snap.live_provider_status !== "READY" && snap.live_provider_status !== "PARTIAL"
        ? snap.live_provider_status
        : state.code ?? "provider_unavailable";
    return {
      ok: false,
      status: state.ok ? 502 : state.status,
      code,
      detail:
        state.detail ??
        `Provider "${league.provider}" could not serve live league state (live_provider_status=${snap.live_provider_status}).`,
      context: null,
    };
  }

  const manager = resolveManager(snap.managers, managerSlug);
  if (!manager) {
    return {
      ok: false,
      status: 404,
      code: "manager_not_in_league",
      detail: `Manager "${managerSlug}" is not in "${leagueSlug}". Known: ${snap.managers.map((m) => m.manager_slug).join(", ")}.`,
      context: null,
    };
  }
  const team = snap.teams.find((t) => t.canonical_manager_ids.includes(manager.canonical_manager_id));
  const roster = team ? snap.rosters.find((r) => r.canonical_team_id === team.canonical_team_id) ?? null : null;
  if (!team || !roster) {
    return { ok: false, status: 404, code: "manager_has_no_team", detail: `No team/roster for ${manager.manager_slug}.`, context: null };
  }

  const currentWeek = snap.week && snap.week > 0 ? snap.week : 1;

  // ---- Temporal consistency: Post-Draft Intelligence I only serves the current
  // canonical league week. A non-current week would mix that week's matchup with
  // TODAY's roster / ownership / free-agent / standings state — a temporally
  // inconsistent context. Historical / future week intelligence needs a complete
  // week-specific snapshot (roster, starters, ownership, waiver state) and
  // belongs to the retrospective/history phase. The `/{week}` route shape is
  // kept for that future expansion.
  if (options.week != null && options.week !== currentWeek) {
    return {
      ok: false,
      status: 400,
      code: "NON_CURRENT_WEEK_UNSUPPORTED",
      detail:
        `Week ${options.week} was requested but the league's current week is ${currentWeek}. ` +
        `Phase I weekly intelligence is only defined for the current week; historical/future week ` +
        `hydration (a complete week-specific roster + ownership snapshot) is not implemented yet.`,
      context: null,
    };
  }
  const week = currentWeek;

  // Matchups always come from the current-week snapshot (the only week whose
  // roster/ownership state is consistent with `week`).
  const matchups: CanonicalMatchup[] = snap.matchups;

  const myMatchup = matchups.find((mu) => mu.sides.some((s) => s.canonical_team_id === team.canonical_team_id)) ?? null;
  const oppSide = myMatchup?.sides.find((s) => s.canonical_team_id !== team.canonical_team_id) ?? null;
  const oppTeam = oppSide ? snap.teams.find((t) => t.canonical_team_id === oppSide.canonical_team_id) ?? null : null;
  const oppRoster = oppTeam ? snap.rosters.find((r) => r.canonical_team_id === oppTeam.canonical_team_id) ?? null : null;

  const playerById = new Map<string, CanonicalPlayer>(snap.players.map((p) => [p.canonical_player_id, p]));
  const lookup = (ids: string[]): CanonicalPlayer[] =>
    ids.map((id) => playerById.get(id)).filter((p): p is CanonicalPlayer => Boolean(p));

  // Roster constraints (with FLEX resolution).
  const rs = snap.league.roster_settings;
  const flexPositions = uniq(
    rs.starting_slots.filter((s) => isFlexSlot(s)).flatMap((s) => FLEX_ELIGIBILITY[s]!),
  );
  const constraints: RosterConstraints = {
    starting_slots: rs.starting_slots,
    slot_requirements: rs.slot_requirements,
    bench_slots: rs.bench_slots,
    ir_slots: rs.ir_slots,
    taxi_slots: rs.taxi_slots,
    roster_size_limit: rs.starting_slots.length + rs.bench_slots + rs.ir_slots + rs.taxi_slots || null,
    active_roster_capacity: rs.starting_slots.length + rs.bench_slots,
    reserve_ir_capacity: rs.ir_slots,
    taxi_capacity: rs.taxi_slots,
    flex_positions: flexPositions.length ? flexPositions : ["RB", "WR", "TE"],
    flex_slots: rs.starting_slots.filter((s) => isFlexSlot(s)).length,
  };

  // Projections for everyone rostered in the league (roster + candidate universe).
  const allRosteredIds = uniq(snap.rosters.flatMap((r) => r.all_players));
  const projProvider = options.projectionProviderOverride ?? getWeeklyProjectionProvider(league.provider);
  const projections = await projProvider.getWeeklyProjections({
    league: {
      league_slug: league.league_slug,
      season: league.season,
      raw_scoring: snap.league.raw_scoring,
      scoring_rules: snap.league.scoring_rules,
    },
    week,
    crosswalk,
    canonical_player_ids: allRosteredIds,
    want_rest_of_season: options.wantRestOfSeason ?? true,
  });

  // ---- Rest-of-season signal: external (Sleeper) absolute + Roster Intel ORDINAL.
  // Best-effort — weekly analytics run unchanged if RI is unavailable.
  let ros_meta: RosAssemblyResult | null = null;
  if ((options.skipRiSeasonSignal ?? false) === false && projections.by_player.size > 0) {
    const riProvider =
      options.riSeasonProviderOverride === null
        ? null
        : options.riSeasonProviderOverride ?? new RosterIntelSeasonSignalProvider();
    const ri = riProvider
      ? await riProvider.getSeasonSignal({ league_slug: league.league_slug, league_id: league.external_league_id }).catch(() => ({
          status: "UNAVAILABLE" as const,
          model_version: null,
          by_sleeper_id: new Map(),
          warning: "RI season signal threw",
        }))
      : { status: "UNAVAILABLE" as const, model_version: null, by_sleeper_id: new Map(), warning: null };
    ros_meta = assembleRosSignals(projections, ri, week);
    for (const w of ros_meta.warnings) warnings.push({ code: "ros_signal", message: w, severity: "info" });
  }

  // ---- Bye detection: ONLY from an authoritative schedule, never from feed absence.
  const scheduleProvider = options.scheduleProviderOverride ?? getScheduleProvider();
  const schedule = await scheduleProvider.getWeekSchedule(league.season, week);
  for (const w of schedule.warnings) warnings.push(w);

  const byeByPlayer: Record<string, number | null> = {};
  const startersOnBye: string[] = [];

  for (const p of lookup(allRosteredIds)) {
    const t = (p.nfl_team ?? "").toUpperCase();
    const projected = projections.by_player.get(p.canonical_player_id);
    const scheduleProvenBye = schedule.status === "READY" && t.length > 0 && schedule.teams_on_bye.has(t);

    byeByPlayer[p.canonical_player_id] = scheduleProvenBye ? week : null;

    if (scheduleProvenBye) {
      // A bye is a genuine 0 (the player will not play). Overrides any stale
      // feed entry.
      projections.by_player.set(p.canonical_player_id, {
        canonical_player_id: p.canonical_player_id,
        week,
        season: league.season,
        position: p.position,
        nfl_team: p.nfl_team,
        opponent: null,
        is_home: null,
        projected_points: 0,
        floor_points: 0,
        ceiling_points: 0,
        std_dev: 0,
        projection_status: "bye",
        expected_availability: 0,
        is_bye: true,
        injury_status: p.injury_status,
        rest_of_season_points: projected?.rest_of_season_points ?? null,
        ros: projected?.ros ?? null,
        source: projections.source,
        model_version: projections.model_version,
        uncertainty_source: "none",
        warnings: ["bye_verified_by_schedule"],
      });
      if (roster.starters.includes(p.canonical_player_id)) startersOnBye.push(p.canonical_player_id);
    } else if (!projected || projected.projected_points == null) {
      // No projection AND not a proven bye -> UNKNOWN. Stays null / "unavailable".
      // We do NOT fabricate a 0 just because the team is absent from the feed.
      if (projected && projected.projection_status !== "unavailable") {
        projections.by_player.set(p.canonical_player_id, { ...projected, projection_status: "unavailable" });
      }
    }
  }

  if (schedule.status !== "READY") {
    warnings.push({
      code: "BYE_STATUS_UNVERIFIED",
      message:
        "No authoritative NFL schedule this run — bye weeks are NOT asserted; unprojected players are left 'unavailable', not zeroed.",
      severity: "warning",
    });
  }

  // Anything still without a usable projection after bye handling is genuinely
  // unknown — it stays null, never 0.
  const stillMissing = allRosteredIds.filter(
    (id) => (projections.by_player.get(id)?.projected_points ?? null) == null && projections.by_player.get(id)?.projection_status !== "bye",
  );
  projections.missing = stillMissing;

  // Availability — candidate universe is every player projected this week + rostered.
  const candidates: CanonicalPlayer[] = uniq([
    ...allRosteredIds,
    ...[...projections.by_player.keys()],
  ])
    .map((id) => projections.resolved_players.get(id) ?? playerById.get(id))
    .filter((p): p is CanonicalPlayer => Boolean(p));
  const startablePositions = new Set(
    constraints.starting_slots.flatMap((s) => (BASE_STARTING.has(s) ? [s] : FLEX_ELIGIBILITY[s] ?? [])),
  );
  const availability = buildLeagueAvailability({
    snapshot: snap,
    manager_team_id: team.canonical_team_id,
    week,
    candidates,
    startable_positions: startablePositions,
  });

  // Replacement framework (shared by lineup + waiver engines).
  const replacement = computeWeeklyReplacement({
    league_slug: league.league_slug,
    week,
    team_count: snap.league.team_count,
    constraints,
    projections,
    availability,
    frontier: options.replacementFrontier,
  });

  // Positional needs.
  const positional_needs = computePositionalNeeds({
    roster,
    constraints,
    teamCount: snap.league.team_count,
    week,
    projections,
    replacement,
    lookup,
  });

  const byes: ByeInfo = {
    bye_status: schedule.status === "READY" ? "VERIFIED" : "UNVERIFIED",
    schedule_source: schedule.status === "READY" ? schedule.source : null,
    by_player: byeByPlayer,
    starters_on_bye_this_week: startersOnBye,
    teams_on_bye: [...schedule.teams_on_bye],
  };

  const rosterProjected = roster.all_players.filter(
    (id) => projections.by_player.get(id)?.projected_points != null || projections.by_player.get(id)?.projection_status === "bye",
  ).length;

  let status: DataQualityStatus = "READY";
  if (projections.status === "PROJECTIONS_UNAVAILABLE") status = "PROJECTIONS_UNAVAILABLE";
  else if (projections.status === "PROJECTIONS_PARTIAL" || stillMissing.length > 0) status = "PROJECTIONS_PARTIAL";
  else if (!oppTeam) status = "NO_OPPONENT";
  if (snap.unresolved_players.length > 0 && status === "READY") status = "PLAYER_IDENTITY_UNRESOLVED";

  for (const w of projections.warnings) warnings.push(w);
  for (const w of availability.warnings) warnings.push(w);
  for (const w of replacement.warnings) warnings.push(w);
  if (stillMissing.length > 0) {
    warnings.push({
      code: "roster_projection_gap",
      message: `${stillMissing.length} rostered player(s) have no weekly projection and no bye — treated as unknown (null), never 0.`,
      severity: "warning",
    });
  }
  if (!oppTeam) warnings.push({ code: "no_opponent", message: `No week ${week} opponent found for this team.`, severity: "info" });

  const context: WeeklyTeamContext = {
    engine_version: WEEKLY_ENGINE_VERSION,
    generated_at: new Date().toISOString(),
    league: {
      slug: league.league_slug,
      name: snap.league.name,
      provider: snap.league.provenance.provider,
      season: league.season,
      week,
      scoring_rules: snap.league.scoring_rules,
      raw_scoring: snap.league.raw_scoring,
      roster_constraints: constraints,
      waiver_settings: snap.league.waiver_settings,
    },
    manager,
    fantasy_team: team,
    standing: snap.standings.find((s) => s.canonical_team_id === team.canonical_team_id) ?? null,
    roster,
    starters: lookup(roster.starters),
    bench: lookup(roster.bench),
    reserve_ir: lookup(roster.ir),
    taxi: lookup(roster.taxi),
    all_rostered: lookup(roster.all_players),
    opponent: oppTeam
      ? {
          fantasy_team: oppTeam,
          manager_ids: oppTeam.canonical_manager_ids,
          roster: oppRoster,
          starters: oppRoster ? lookup(oppRoster.starters) : [],
          all_rostered: oppRoster ? lookup(oppRoster.all_players) : [],
        }
      : null,
    projections,
    replacement,
    availability,
    ros_signal: ros_meta
      ? {
          status: ros_meta.ri_status,
          ri_model_version: ros_meta.ri_model_version,
          external_source: ros_meta.external_source,
          players_with_ri: ros_meta.players_with_ri,
          players_with_disagreement: ros_meta.players_with_disagreement,
        }
      : null,
    byes,
    positional_needs,
    status,
    persistence_status: snap.history_persistence_status,
    data_quality: {
      projections: projections.status,
      roster_players_projected: rosterProjected,
      roster_players_total: roster.all_players.length,
      identity_unresolved: snap.unresolved_players.length,
      opponent_available: Boolean(oppTeam),
    },
    warnings,
  };

  return { ok: true, status: 200, context };
}

/* ------------------------------------------------------------ positional needs */

export function computePositionalNeeds(input: {
  roster: CanonicalRoster;
  constraints: RosterConstraints;
  teamCount: number;
  week: number;
  projections: WeeklyTeamContext["projections"];
  replacement: WeeklyTeamContext["replacement"];
  lookup: (ids: string[]) => CanonicalPlayer[];
}): PositionalNeed[] {
  const { roster, constraints, week, projections, replacement, lookup } = input;
  // ACTIVE players only — an RB/WR/TE on IR or taxi cannot fill a starter slot.
  const reserve = new Set([...roster.ir, ...roster.taxi]);
  const activeIds = roster.all_players.filter((id) => !reserve.has(id));
  const activePlayers = lookup(activeIds);
  const out: PositionalNeed[] = [];
  const ptsOf = (id: string) => projections.by_player.get(id)?.projected_points ?? null;
  const startLabels = constraints.starting_slots;

  // ---- Projection-aware optimal lineup on the ACTIVE roster. This gives the
  // MARGINAL required starter for every slot (value) and the genuinely
  // unfillable slots (`empty_slots`, structural — known + unknown considered).
  const playerMap = new Map(activePlayers.map((p) => [p.canonical_player_id, p]));
  const lineup = buildOptimalLineup({ week, roster, constraints, players: playerMap, projections });
  const emptyLabels = new Set(lineup.empty_slots);

  // ---- Which CANDIDATE positions would reduce the structural deficit? Not just
  // the unfilled label's own eligibility — in a SUPER_FLEX/FLEX league adding a
  // QB fills SUPER_FLEX and frees a WR for FLEX, so QB "helps" even though the
  // unfilled label is FLEX. Tested with the shared (structural) matching.
  const matchCands = activePlayers.map((p) => ({ id: p.canonical_player_id, positions: uniq([p.position, ...p.eligible_positions]) }));
  const baseUnfilled = maxSlotMatching(startLabels, matchCands).unfilled.length;
  const helps = new Set<string>();
  if (baseUnfilled > 0) {
    for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
      const withHypo = maxSlotMatching(startLabels, [...matchCands, { id: "__hypo", positions: [pos] }]);
      if (withHypo.unfilled.length < baseUnfilled) helps.add(pos);
    }
  }

  // per-flex-label replacement level — `computeWeeklyReplacement` builds one per
  // DISTINCT flex slot label from the configured frontier applied to the union
  // of that label's eligible free agents (a SUPER_FLEX QB never sets the
  // ordinary FLEX bar).
  const labelReplacement = (label: string): number | null =>
    replacement.by_position[label]?.replacement_points ?? replacement.by_position.FLEX?.replacement_points ?? null;

  for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
    const atPos = activePlayers.filter((p) => p.position === pos || p.eligible_positions.includes(pos as never));
    const pts = atPos
      .map((p) => ptsOf(p.canonical_player_id))
      .filter((x): x is number => x != null)
      .sort((a, b) => b - a);
    const rep = replacement.by_position[pos]?.replacement_points ?? null;
    const need = constraints.slot_requirements[pos] ?? 0;
    const startable = rep == null ? atPos.length : pts.filter((p) => p >= rep).length;
    // MARGINAL REQUIRED starter — the `need`-th best (index need-1), NOT the best.
    const marginal = need > 0 ? pts[need - 1] ?? pts.at(-1) ?? null : pts[0] ?? null;
    const gap = marginal != null && rep != null ? Math.round((marginal - rep) * 100) / 100 : null;
    const lowBackupValue = pos === "K" || pos === "DEF" || (pos === "QB" && (constraints.slot_requirements.QB ?? 0) <= 1);
    const depthCount = pts.filter((p) => rep == null || p >= rep).length;

    const isKD = pos === "K" || pos === "DEF";
    let severity: PositionalNeed["severity"] = "adequate";
    if (emptyLabels.has(pos)) severity = "critical"; // this base slot itself is unfillable
    else if (need > 0 && startable < need) severity = isKD ? "adequate" : "critical";
    else if (!lowBackupValue && need > 0 && startable === need && (gap == null || gap < 2)) severity = "weak";
    else if (gap != null && gap > 6 && depthCount >= need + 2) severity = "strong";

    out.push({
      position: pos,
      eligible_positions: [pos],
      have_startable: startable,
      need: Math.round(need * 100) / 100,
      current_best_points: marginal,
      gap_vs_replacement: gap,
      severity,
    });
  }

  // ---- One need PER DISTINCT flex slot label, each with its OWN eligibility.
  const flexLabels = uniq(startLabels.filter((l) => isFlexSlot(l)));
  // The optimizer's total is invariant to which slot (base OR flex) an
  // interchangeable starter occupies, so the flex "starters" are NOT just whoever
  // the optimizer parked in a flex slot. Take EVERY optimal starter, remove the
  // top `slot_requirements[p]` at each base position (the players a base slot
  // genuinely dedicates), and what remains is the pool that only starts because
  // of flex demand. Then run the eligibility-preserving max-min assignment of
  // that pool to the flex slots.
  const optimalStarters = lineup.slots
    .filter((s) => s.recommended_player_id != null && s.recommended_projected != null)
    .map((s) => {
      const pl = playerMap.get(s.recommended_player_id!);
      return {
        id: s.recommended_player_id!,
        pts: s.recommended_projected!,
        positions: new Set(pl ? [pl.position, ...pl.eligible_positions] : [s.slot]),
      };
    });
  const baseConsumed = new Set<string>();
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
    const req = constraints.slot_requirements[pos] ?? 0;
    const atPos = optimalStarters
      .filter((x) => !baseConsumed.has(x.id) && x.positions.has(pos))
      .sort((a, b) => b.pts - a.pts);
    for (let i = 0; i < req && i < atPos.length; i += 1) baseConsumed.add(atPos[i]!.id);
  }
  const flexStarters = optimalStarters
    .filter((x) => !baseConsumed.has(x.id))
    .map((x) => ({ pts: x.pts, positions: x.positions }));
  const flexSlotList = startLabels
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => isFlexSlot(l))
    .map(({ l }) => ({ label: l, rep: labelReplacement(l) ?? 0, eligible: new Set(slotEligiblePositions(l)) }));

  const marginalByLabel = new Map<string, number | null>();
  {
    let best: number[] | null = null;
    let bestMin = -Infinity;
    const used = new Array(flexSlotList.length).fill(false);
    const cur: number[] = [];
    const rec = (si: number): void => {
      if (si === flexStarters.length) {
        let m = Infinity;
        for (let k = 0; k < flexStarters.length; k += 1) {
          m = Math.min(m, flexStarters[k]!.pts - flexSlotList[cur[k]!]!.rep);
        }
        if (m > bestMin) {
          bestMin = m;
          best = [...cur];
        }
        return;
      }
      for (let j = 0; j < flexSlotList.length; j += 1) {
        if (used[j]) continue;
        if (![...flexStarters[si]!.positions].some((p) => flexSlotList[j]!.eligible.has(p))) continue;
        used[j] = true;
        cur.push(j);
        rec(si + 1);
        cur.pop();
        used[j] = false;
      }
    };
    if (flexStarters.length > 0 && flexSlotList.length >= flexStarters.length) rec(0);
    for (const label of flexLabels) marginalByLabel.set(label, null);
    if (best) {
      for (let k = 0; k < flexStarters.length; k += 1) {
        const label = flexSlotList[(best as number[])[k]!]!.label;
        marginalByLabel.set(label, Math.min(marginalByLabel.get(label) ?? Infinity, flexStarters[k]!.pts));
      }
    }
  }

  for (const label of flexLabels) {
    const labelNeed = startLabels.filter((l) => l === label).length;
    const eligible = slotEligiblePositions(label);
    const eligSet = new Set(eligible);
    const flexEligiblePlayers = activePlayers.filter(
      (p) => eligSet.has(p.position) || p.eligible_positions.some((e) => eligSet.has(e)),
    );
    const labelSlots = lineup.slots.filter((s) => s.slot === label);
    const marginal = marginalByLabel.get(label) ?? null;
    const rep = labelReplacement(label);
    const gap = marginal != null && rep != null ? Math.round((marginal - rep) * 100) / 100 : null;
    const emptyOfLabel = labelSlots.filter((s) => s.recommended_player_id == null).length;

    let severity: PositionalNeed["severity"] = "adequate";
    if (emptyOfLabel > 0) severity = "critical"; // this flex slot itself is unfillable
    else if (gap != null && gap < 2) severity = "weak";
    else if (gap != null && gap > 4 && flexEligiblePlayers.length >= labelNeed + 2) severity = "strong";

    out.push({
      position: label,
      eligible_positions: eligible,
      have_startable: labelSlots.filter((s) => s.recommended_player_id != null).length,
      need: labelNeed,
      current_best_points: marginal,
      gap_vs_replacement: gap,
      severity,
    });
  }

  // ---- A single STRUCTURAL need when the active roster cannot field a legal
  // lineup. `eligible_positions` is EXACTLY the set of positions that would
  // reduce the deficit (a QB in a SUPER_FLEX/FLEX hole, or an RB/WR/TE), so the
  // waiver engine credits only genuinely helpful acquisitions.
  if (helps.size > 0) {
    out.push({
      position: "STRUCTURAL",
      eligible_positions: [...helps],
      have_startable: startLabels.length - lineup.empty_slots.length,
      need: startLabels.length,
      current_best_points: null,
      gap_vs_replacement: null,
      severity: "critical",
    });
  }

  return out.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

function severityRank(s: PositionalNeed["severity"]): number {
  return { critical: 0, weak: 1, adequate: 2, strong: 3 }[s];
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
