/**
 * Canonical current-league-state service.
 *
 * `buildCanonicalLeagueState(leagueSlug)` is the one code path behind
 * `GET /api/league/{league}/state`, the snapshot capture job, and (soon) every
 * analytical engine. It:
 *   1. resolves the slug -> provider + external id via the registry
 *   2. asks that provider for a canonical league-state bundle
 *   3. layers on current-week matchups + recent transactions (best effort)
 *   4. reports LIVE_PROVIDER_STATUS and HISTORY_PERSISTENCE_STATUS separately —
 *      a persistence outage never blocks a live read
 *
 * Nothing here is Sleeper- or Yahoo-specific: it only touches `FantasyProvider`
 * and the canonical schema.
 */

import { PlayerCrosswalk, NoCrosswalk } from "./players";
import {
  CANONICAL_SCHEMA_VERSION,
  type CanonicalLeagueSnapshot,
  type CanonicalWarning,
  type DegradedStatus,
} from "./schema";
import { getProvider } from "@/lib/providers/registry";
import type { FantasyProvider, ProviderLeagueContext } from "@/lib/providers/types";
import { resolveLeagueStrict, type ResolvedLeague } from "@/lib/leagues/resolve";
import { getPersistence } from "@/lib/persistence";
import { defaultCrosswalkSource } from "@/lib/persistence/supabase/crosswalk-source";

export interface CanonicalStateResult {
  ok: boolean;
  status: number;
  code?: string;
  detail?: string;
  snapshot: CanonicalLeagueSnapshot | null;
}

export interface BuildStateOptions {
  /** Skip the extra matchup + transaction reads (snapshot job wants them; some callers don't). */
  includeMatchups?: boolean;
  includeRecentTransactions?: boolean;
  /** Inject a provider (tests). Defaults to the registry factory. */
  providerOverride?: FantasyProvider;
  /** Inject a crosswalk (tests). Defaults to Supabase source, else NoCrosswalk. */
  crosswalkOverride?: PlayerCrosswalk;
  /** Report persistence status in the snapshot (default true). */
  reportPersistence?: boolean;
}

export async function buildCanonicalLeagueState(
  leagueSlug: string,
  options: BuildStateOptions = {},
): Promise<CanonicalStateResult> {
  const resolution = resolveLeagueStrict(leagueSlug);
  if (!resolution.ok) {
    return { ok: false, status: resolution.status, code: resolution.code, detail: resolution.detail, snapshot: null };
  }
  const league = resolution.league;

  const provider = options.providerOverride ?? getProvider(league.provider);
  const crosswalk =
    options.crosswalkOverride ??
    (defaultCrosswalkSource() ? new PlayerCrosswalk(defaultCrosswalkSource()!) : new PlayerCrosswalk(NoCrosswalk));

  const ctx: ProviderLeagueContext = {
    league_slug: league.league_slug,
    external_league_id: league.external_league_id,
    season: league.season,
    crosswalk,
  };

  const warnings: CanonicalWarning[] = [];
  const stateResult = await provider.getLeagueState(ctx);

  if (!stateResult.data) {
    // Provider could not serve live state — return an explicit degraded snapshot
    // shell rather than a 200 with fabricated data.
    return {
      ok: stateResult.status === "AUTH_REQUIRED" || stateResult.status === "NOT_CONFIGURED",
      status: providerHttpStatus(stateResult.status),
      code: stateResult.warnings[0]?.code ?? "provider_unavailable",
      detail: stateResult.warnings[0]?.message ?? "Provider returned no data.",
      snapshot: degradedShell(
        league,
        stateResult.status,
        warnings.concat(stateResult.warnings),
        await persistenceStatusSafe(options.reportPersistence ?? true),
      ),
    };
  }

  warnings.push(...stateResult.warnings);
  const bundle = stateResult.data;
  const week = bundle.league.current_week ?? 0;

  // Attach manager ids to team refs where the provider left them empty.
  const teamManagerIds = new Map(bundle.teams.map((t) => [t.canonical_team_id, t.canonical_manager_ids]));

  let matchups: CanonicalLeagueSnapshot["matchups"] = [];
  if ((options.includeMatchups ?? true) && week > 0 && provider.capabilities().matchups) {
    const m = await provider.getMatchups(ctx, week);
    if (m.data) {
      matchups = m.data.map((mu) => ({
        ...mu,
        sides: mu.sides.map((s) => ({
          ...s,
          canonical_manager_ids: teamManagerIds.get(s.canonical_team_id) ?? [],
        })),
      }));
    } else {
      warnings.push(...m.warnings);
    }
  }

  let recentTransactions: CanonicalLeagueSnapshot["recent_transactions"] = [];
  if ((options.includeRecentTransactions ?? true) && provider.capabilities().transactions) {
    const t = await provider.getTransactions(ctx, { week: week > 0 ? week : null, limit: 25 });
    if (t.data) recentTransactions = t.data;
    else warnings.push(...t.warnings);
  }

  // LIVE status is decided by the provider read ONLY — persistence warnings
  // (added below) must never degrade it. That separation is the whole point.
  const liveStatus: DegradedStatus =
    stateResult.status === "READY" && warnings.length === 0 ? "READY" : "PARTIAL";

  // Persistence status is reported, never required.
  const historyStatus = await persistenceStatusSafe(options.reportPersistence ?? true);
  if (historyStatus !== "READY") {
    warnings.push({
      code: "HISTORY_PERSISTENCE_UNAVAILABLE",
      message: `Historical persistence is ${historyStatus}. Live league state is unaffected.`,
    });
  }

  const snapshot: CanonicalLeagueSnapshot = {
    schema_version: CANONICAL_SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    provider_synced_at: stateResult.provider_synced_at,
    league: bundle.league,
    season: league.season,
    week,
    managers: bundle.managers,
    teams: bundle.teams,
    rosters: bundle.rosters,
    standings: bundle.standings,
    matchups,
    recent_transactions: recentTransactions,
    draft_picks: bundle.draft_picks,
    waiver_state: null,
    players: bundle.players,
    unresolved_players: bundle.unresolved_players,
    live_provider_status: liveStatus,
    history_persistence_status: historyStatus,
    warnings,
  };

  return { ok: true, status: 200, snapshot };
}

async function persistenceStatusSafe(enabled: boolean): Promise<DegradedStatus> {
  if (!enabled) return "READY";
  try {
    return await getPersistence().status();
  } catch {
    return "PERSISTENCE_ERROR";
  }
}

function providerHttpStatus(status: DegradedStatus): number {
  switch (status) {
    case "NOT_CONFIGURED":
    case "AUTH_REQUIRED":
      return 200; // an honest "configure me" state, not a server failure
    case "PROVIDER_ERROR":
      return 502;
    default:
      return 503;
  }
}

function degradedShell(
  league: ResolvedLeague,
  status: DegradedStatus,
  warnings: CanonicalWarning[],
  historyStatus: DegradedStatus,
): CanonicalLeagueSnapshot {
  return {
    schema_version: CANONICAL_SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    provider_synced_at: null,
    league: {
      canonical_league_id: `league:${league.league_slug}`,
      league_slug: league.league_slug,
      name: league.display_name,
      season: league.season,
      status: "unknown",
      sport: "nfl",
      team_count: 0,
      current_week: null,
      scoring_rules: [],
      raw_scoring: {},
      roster_settings: { starting_slots: [], bench_slots: 0, ir_slots: 0, taxi_slots: 0, slot_requirements: {} },
      playoff_settings: { playoff_team_count: null, playoff_start_week: null, championship_week: null },
      waiver_settings: { type: "unknown", faab_budget: null, waiver_day: null },
      provenance: { provider: league.provider, provider_id: league.external_league_id, provider_synced_at: null },
    },
    season: league.season,
    week: 0,
    managers: [],
    teams: [],
    rosters: [],
    standings: [],
    matchups: [],
    recent_transactions: [],
    draft_picks: [],
    waiver_state: null,
    players: [],
    unresolved_players: [],
    live_provider_status: status,
    history_persistence_status: historyStatus,
    warnings,
  };
}
