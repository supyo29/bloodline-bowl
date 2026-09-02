/**
 * Weekly Intelligence — the coherent shared decision layer.
 *
 * `buildWeeklyIntelligence(league, manager, week?)` builds ONE
 * `WeeklyTeamContext` and runs the lineup, start/sit, matchup, leverage and
 * waiver engines off it (no engine rebuilds context, no route duplicates
 * logic). It also produces `top_actions` — the few decisions that actually
 * matter this week — and a manager-facing `summary`.
 */

import { buildWeeklyTeamContext, type BuildWeeklyContextOptions } from "./context";
import { buildOptimalLineup } from "./lineup";
import { buildMatchup, buildLeverage } from "./matchup";
import { buildWaiverRecommendations } from "./waivers";
import { compareStartSit, type StartSitComparison } from "./start-sit";
import { buildWeeklySummary, type WeeklySummary } from "./summary";
import { WEEKLY_ENGINE_VERSION, type DataQualityStatus, type Priority, type WeeklyTeamContext, type WeeklyWarning } from "./schema";
import type { LineupResult } from "./lineup";
import type { MatchupResult, LeverageItem } from "./matchup";
import type { WaiverResult } from "./waivers";

export interface TopAction {
  type: "LINEUP" | "WAIVER" | "ALERT";
  priority: Priority;
  message: string;
  projected_gain?: number;
  net_roster_gain?: number;
  detail_route: string;
}

export interface WeeklyIntelligence {
  engine_version: typeof WEEKLY_ENGINE_VERSION;
  generated_at: string;
  league_slug: string;
  manager_slug: string;
  week: number;
  status: DataQualityStatus;
  data_quality: WeeklyTeamContext["data_quality"];
  persistence_status: string;

  top_actions: TopAction[];
  summary: WeeklySummary;

  lineup: LineupResult;
  start_sit: StartSitComparison[];
  matchup: MatchupResult;
  matchup_leverage: LeverageItem[];
  waivers: WaiverResult;
  positional_needs: WeeklyTeamContext["positional_needs"];

  warnings: WeeklyWarning[];
}

export interface IntelligenceResult {
  ok: boolean;
  status: number;
  code?: string;
  detail?: string;
  intelligence: WeeklyIntelligence | null;
  /** When live state is fine but the provider is not authed (Yahoo pre-auth). */
  degraded_context?: { code: string; detail: string };
}

export interface ContextView<T> {
  ok: boolean;
  status: number;
  code?: string;
  detail?: string;
  data: T | null;
  context_meta?: {
    engine_version: typeof WEEKLY_ENGINE_VERSION;
    league_slug: string;
    manager_slug: string;
    week: number;
    status: DataQualityStatus;
    data_quality: WeeklyTeamContext["data_quality"];
    persistence_status: string;
    warnings: WeeklyWarning[];
  };
}

/**
 * Run one engine over a freshly-built `WeeklyTeamContext`. Every sub-route uses
 * this so context assembly + degraded-state handling live in exactly one place.
 */
export async function runWithWeeklyContext<T>(
  leagueSlug: string,
  managerSlug: string,
  options: BuildWeeklyContextOptions,
  fn: (ctx: WeeklyTeamContext) => T,
): Promise<ContextView<T>> {
  const built = await buildWeeklyTeamContext(leagueSlug, managerSlug, options);
  if (!built.context) {
    return { ok: built.ok && (built.code === "AUTH_REQUIRED" || built.code === "NOT_CONFIGURED"), status: built.status, code: built.code, detail: built.detail, data: null };
  }
  const ctx = built.context;
  return {
    ok: true,
    status: 200,
    data: fn(ctx),
    context_meta: {
      engine_version: WEEKLY_ENGINE_VERSION,
      league_slug: ctx.league.slug,
      manager_slug: ctx.manager.manager_slug,
      week: ctx.league.week,
      status: ctx.status,
      data_quality: ctx.data_quality,
      persistence_status: ctx.persistence_status,
      warnings: ctx.warnings,
    },
  };
}

export async function buildWeeklyIntelligence(
  leagueSlug: string,
  managerSlug: string,
  options: BuildWeeklyContextOptions = {},
): Promise<IntelligenceResult> {
  const built = await buildWeeklyTeamContext(leagueSlug, managerSlug, options);
  if (!built.context) {
    if (built.ok && built.code && (built.code === "AUTH_REQUIRED" || built.code === "NOT_CONFIGURED")) {
      return {
        ok: false,
        status: 200,
        code: built.code,
        detail: built.detail,
        intelligence: null,
        degraded_context: { code: built.code, detail: built.detail ?? "" },
      };
    }
    return { ok: false, status: built.status, code: built.code, detail: built.detail, intelligence: null };
  }
  const ctx = built.context;

  const lineup = buildLineup(ctx);
  const matchup = buildMatchup(ctx);
  const matchup_leverage = buildLeverage(matchup);
  const waivers = buildWaiverRecommendations(ctx);
  const start_sit = buildCloseCalls(ctx, lineup);
  const summary = buildWeeklySummary({ ctx, lineup, matchup, waivers });

  const base = `/api/intelligence/${leagueSlug}/${managerSlug}/week/${ctx.league.week}`;
  const top_actions = buildTopActions({ ctx, lineup, matchup, matchup_leverage, waivers, base });

  return {
    ok: true,
    status: 200,
    intelligence: {
      engine_version: WEEKLY_ENGINE_VERSION,
      generated_at: new Date().toISOString(),
      league_slug: ctx.league.slug,
      manager_slug: ctx.manager.manager_slug,
      week: ctx.league.week,
      status: ctx.status,
      data_quality: ctx.data_quality,
      persistence_status: ctx.persistence_status,
      top_actions,
      summary,
      lineup,
      start_sit,
      matchup,
      matchup_leverage,
      waivers,
      positional_needs: ctx.positional_needs,
      warnings: ctx.warnings,
    },
  };
}

export function buildLineup(ctx: WeeklyTeamContext): LineupResult {
  const players = new Map(ctx.all_rostered.map((p) => [p.canonical_player_id, p]));
  return buildOptimalLineup({
    week: ctx.league.week,
    roster: ctx.roster,
    constraints: ctx.league.roster_constraints,
    players,
    projections: ctx.projections,
  });
}

/** Close lineup calls worth surfacing as explicit start/sit comparisons. */
function buildCloseCalls(ctx: WeeklyTeamContext, lineup: LineupResult): StartSitComparison[] {
  const out: StartSitComparison[] = [];
  for (const s of lineup.slots) {
    if (!s.recommended_player_id || !s.current_player_id) continue;
    if (s.recommended_player_id === s.current_player_id) continue;
    // Only genuine starter-set changes — a slot reshuffle of the same starters
    // is not a start/sit decision.
    if (!s.is_starter_set_change) continue;
    out.push(
      compareStartSit({
        slot: s.slot,
        a: ctx.projections.by_player.get(s.recommended_player_id) ?? null,
        b: ctx.projections.by_player.get(s.current_player_id) ?? null,
        a_id: s.recommended_player_id,
        b_id: s.current_player_id,
        replacement: ctx.replacement,
      }),
    );
  }
  // Also the single closest same-position bench-vs-starter call, if any.
  return out.sort((a, b) => Math.abs(b.projection_edge ?? 0) - Math.abs(a.projection_edge ?? 0));
}

function buildTopActions(input: {
  ctx: WeeklyTeamContext;
  lineup: LineupResult;
  matchup: MatchupResult;
  matchup_leverage: LeverageItem[];
  waivers: WaiverResult;
  base: string;
}): TopAction[] {
  const { ctx, lineup, matchup, matchup_leverage, waivers, base } = input;
  const actions: TopAction[] = [];
  const nameOf = (id: string | null) =>
    (id && (ctx.all_rostered.find((p) => p.canonical_player_id === id)?.full_name ?? ctx.projections.resolved_players.get(id)?.full_name)) || "(empty)";

  for (const c of lineup.changes_recommended.slice(0, 3)) {
    const lev = matchup_leverage.find((l) => l.slot === c.slot);
    const priority: Priority = lev?.leverage === "HIGH" || c.gain >= 3 ? "HIGH" : c.gain >= 1.25 ? "MEDIUM" : "LOW";
    actions.push({
      type: "LINEUP",
      priority,
      message: `Start ${nameOf(c.in)} over ${nameOf(c.out)} in ${c.slot} (+${c.gain.toFixed(1)} projected)`,
      projected_gain: c.gain,
      detail_route: `${base}`,
    });
  }
  if (lineup.empty_slots.length > 0) {
    actions.push({ type: "ALERT", priority: "HIGH", message: `Empty starter slot(s): ${lineup.empty_slots.join(", ")}`, detail_route: base });
  }
  for (const s of lineup.illegal_situations.slice(0, 1)) {
    actions.push({ type: "ALERT", priority: "HIGH", message: `Illegal lineup: ${s}`, detail_route: base });
  }
  for (const b of ctx.byes.starters_on_bye_this_week) {
    actions.push({ type: "ALERT", priority: "MEDIUM", message: `${nameOf(b)} is on bye and currently starting`, detail_route: base });
  }
  for (const sw of matchup.swing_players.filter((x) => x.side === "team").slice(0, 1)) {
    actions.push({ type: "ALERT", priority: "MEDIUM", message: `${nameOf(sw.canonical_player_id)}: ${sw.swing_note}`, detail_route: base });
  }
  for (const w of waivers.recommendations.filter((r) => r.priority === "HIGH" || r.priority === "MEDIUM").slice(0, 2)) {
    actions.push({
      type: "WAIVER",
      priority: w.priority as Priority,
      message: `Add ${w.add_name}${w.drop_name ? `, drop ${w.drop_name}` : ""} (${w.immediate_role})`,
      net_roster_gain: w.net_roster_gain,
      detail_route: `/api/waivers/${ctx.league.slug}/${ctx.manager.manager_slug}/week/${ctx.league.week}`,
    });
  }

  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  return actions
    .sort((a, b) => rank[a.priority] - rank[b.priority] || (b.projected_gain ?? b.net_roster_gain ?? 0) - (a.projected_gain ?? a.net_roster_gain ?? 0))
    .slice(0, 6);
}
