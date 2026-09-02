/**
 * SleeperProvider — the functional provider adapter for the Sleeper public API.
 *
 * Wraps the existing `lib/sleeper/client` (untouched) and the pure
 * `./canonical` adapter. Sleeper needs no authentication for the public
 * league/roster/transaction data this bridge reads, so every capability is
 * available and `healthCheck` is a live `/state/nfl` probe.
 */

import {
  SleeperError,
  getDraftPicks,
  getLeague,
  getLeagueDrafts,
  getLeagueRosters,
  getLeagueTransactions,
  getLeagueUsers,
  getMatchups,
  getNflState,
  getPlayerIndex,
} from "@/lib/sleeper/client";
import type { RawDraftPick } from "@/lib/sleeper/types";
import {
  toCanonicalDraftPicks,
  toCanonicalLeague,
  toCanonicalManagers,
  toCanonicalMatchups,
  toCanonicalRosters,
  toCanonicalStandings,
  toCanonicalTeams,
  toCanonicalTransactions,
} from "./canonical";
import {
  degraded,
  ok,
  type CanonicalLeagueStateBundle,
  type FantasyProvider,
  type ProviderCapabilities,
  type ProviderHealth,
  type ProviderLeagueContext,
  type ProviderResult,
  type TransactionQuery,
} from "../types";
import type {
  CanonicalDraftPick,
  CanonicalLeague,
  CanonicalManager,
  CanonicalMatchup,
  CanonicalRoster,
  CanonicalStanding,
  CanonicalTransaction,
  CanonicalWaiverState,
} from "@/lib/canonical/schema";

const MAX_WEEK = 18;

function describe(error: unknown): string {
  return error instanceof SleeperError || error instanceof Error ? error.message : String(error);
}

export class SleeperProvider implements FantasyProvider {
  readonly name = "sleeper" as const;
  readonly authentication = "NONE" as const;

  capabilities(): ProviderCapabilities {
    return {
      league: true,
      settings: true,
      managers: true,
      standings: true,
      rosters: true,
      matchups: true,
      transactions: true,
      players: true,
      free_agents: true,
      waivers: true,
      draft_results: true,
      live_authenticated_access: true,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const base = {
      provider: this.name,
      authentication: this.authentication,
      checked_at: new Date().toISOString(),
    };
    try {
      const state = await getNflState();
      return {
        ...base,
        status: "READY",
        detail: `Sleeper reachable; NFL ${state.season} week ${state.week}.`,
      };
    } catch (error) {
      return { ...base, status: "PROVIDER_ERROR", detail: describe(error) };
    }
  }

  async getLeagueState(
    ctx: ProviderLeagueContext,
  ): Promise<ProviderResult<CanonicalLeagueStateBundle>> {
    const syncedAt = new Date().toISOString();
    const warnings: ProviderResult<unknown>["warnings"] = [];

    let raw;
    try {
      raw = await this.#loadCore(ctx.external_league_id);
    } catch (error) {
      if (error instanceof SleeperError && error.status === 404) {
        return degraded("PROVIDER_ERROR", "league_not_found", `Sleeper has no league ${ctx.external_league_id}.`);
      }
      return degraded("PROVIDER_ERROR", "sleeper_upstream_error", describe(error));
    }

    const { league, users, rosters, drafts, nflState } = raw;
    const currentWeek = nflState?.week && nflState.week > 0 ? nflState.week : null;
    const canonLeague = toCanonicalLeague(ctx.league_slug, league, currentWeek, syncedAt);
    const faab = canonLeague.waiver_settings.faab_budget;

    await ctx.crosswalk.ensureLoaded();
    const playerIndex = await getPlayerIndex().catch(() => {
      warnings.push({ code: "player_database_unavailable", message: "Sleeper player DB unavailable; players are id-only stubs." });
      return new Map();
    });

    const rosterRes = toCanonicalRosters(
      ctx.league_slug,
      rosters,
      canonLeague.roster_settings.starting_slots,
      playerIndex,
      ctx.crosswalk,
      syncedAt,
    );

    const picksByDraft = new Map<string, RawDraftPick[]>();
    for (const d of drafts) {
      const picks = await getDraftPicks(d.draft_id).catch(() => [] as RawDraftPick[]);
      picksByDraft.set(d.draft_id, picks);
    }

    const bundle: CanonicalLeagueStateBundle = {
      league: canonLeague,
      managers: toCanonicalManagers(ctx.league_slug, users, rosters, syncedAt),
      teams: toCanonicalTeams(ctx.league_slug, rosters, faab, syncedAt),
      rosters: rosterRes.rosters,
      standings: toCanonicalStandings(ctx.league_slug, rosters),
      draft_picks: toCanonicalDraftPicks(
        ctx.league_slug,
        ctx.season,
        drafts,
        picksByDraft,
        playerIndex,
        ctx.crosswalk,
        users,
        syncedAt,
      ),
      players: rosterRes.players,
      unresolved_players: rosterRes.unresolved,
    };

    return ok(bundle, { warnings, provider_synced_at: syncedAt });
  }

  async getLeague(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalLeague>> {
    try {
      const [league, nflState] = await Promise.all([
        getLeague(ctx.external_league_id),
        getNflState().catch(() => null),
      ]);
      const week = nflState?.week && nflState.week > 0 ? nflState.week : null;
      return ok(toCanonicalLeague(ctx.league_slug, league, week, new Date().toISOString()));
    } catch (error) {
      return degraded("PROVIDER_ERROR", "sleeper_upstream_error", describe(error));
    }
  }

  async getManagers(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalManager[]>> {
    try {
      const [users, rosters] = await Promise.all([
        getLeagueUsers(ctx.external_league_id),
        getLeagueRosters(ctx.external_league_id),
      ]);
      return ok(toCanonicalManagers(ctx.league_slug, users, rosters, new Date().toISOString()));
    } catch (error) {
      return degraded("PROVIDER_ERROR", "sleeper_upstream_error", describe(error));
    }
  }

  async getStandings(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalStanding[]>> {
    try {
      const rosters = await getLeagueRosters(ctx.external_league_id);
      return ok(toCanonicalStandings(ctx.league_slug, rosters));
    } catch (error) {
      return degraded("PROVIDER_ERROR", "sleeper_upstream_error", describe(error));
    }
  }

  async getRosters(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalRoster[]>> {
    const state = await this.getLeagueState(ctx);
    if (!state.data) return degraded(state.status, "rosters_unavailable", state.warnings[0]?.message ?? "unavailable");
    return ok(state.data.rosters, { warnings: state.warnings, provider_synced_at: state.provider_synced_at });
  }

  async getMatchups(
    ctx: ProviderLeagueContext,
    week: number,
  ): Promise<ProviderResult<CanonicalMatchup[]>> {
    if (!Number.isInteger(week) || week < 1 || week > MAX_WEEK) {
      return degraded("PROVIDER_ERROR", "invalid_week", `week must be 1..${MAX_WEEK}.`);
    }
    try {
      await ctx.crosswalk.ensureLoaded();
      const [raw, playerIndex] = await Promise.all([
        getMatchups(ctx.external_league_id, week),
        getPlayerIndex().catch(() => new Map()),
      ]);
      return ok(
        toCanonicalMatchups(ctx.league_slug, week, raw, playerIndex, ctx.crosswalk, new Date().toISOString()),
      );
    } catch (error) {
      return degraded("PROVIDER_ERROR", "sleeper_upstream_error", describe(error));
    }
  }

  async getTransactions(
    ctx: ProviderLeagueContext,
    query: TransactionQuery = {},
  ): Promise<ProviderResult<CanonicalTransaction[]>> {
    const weeks =
      query.week != null ? [query.week] : Array.from({ length: MAX_WEEK }, (_, i) => i + 1);
    const warnings: ProviderResult<unknown>["warnings"] = [];
    try {
      const results = await Promise.all(
        weeks.map((w) =>
          getLeagueTransactions(ctx.external_league_id, w).catch((error) => {
            warnings.push({ code: "week_transactions_unavailable", message: `week ${w}: ${describe(error)}` });
            return [];
          }),
        ),
      );
      const raw = results.flat().filter((t) => t.status === "complete");
      let canon = toCanonicalTransactions(ctx.league_slug, ctx.season, raw, new Date().toISOString());
      if (query.limit && canon.length > query.limit) canon = canon.slice(0, query.limit);
      return ok(canon, { warnings, provider_synced_at: new Date().toISOString() });
    } catch (error) {
      return degraded("PROVIDER_ERROR", "sleeper_upstream_error", describe(error));
    }
  }

  async getDraftResults(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalDraftPick[]>> {
    const state = await this.getLeagueState(ctx);
    if (!state.data) return degraded(state.status, "draft_unavailable", state.warnings[0]?.message ?? "unavailable");
    return ok(state.data.draft_picks, { warnings: state.warnings, provider_synced_at: state.provider_synced_at });
  }

  async getWaiverState(
    ctx: ProviderLeagueContext,
  ): Promise<ProviderResult<CanonicalWaiverState>> {
    // Sleeper has no dedicated free-agent endpoint. Ownership is derived: every
    // player not on a roster in THIS league is a free agent. The full available
    // pool (12k players) is intentionally NOT materialized here in the
    // foundation phase — only rostered ownership is reported, which is
    // league-specific and never reused across leagues.
    try {
      await ctx.crosswalk.ensureLoaded();
      const [rosters, playerIndex] = await Promise.all([
        getLeagueRosters(ctx.external_league_id),
        getPlayerIndex().catch(() => new Map()),
      ]);
      const players: CanonicalWaiverState["players"] = [];
      for (const r of rosters) {
        for (const rawId of r.players ?? []) {
          if (!rawId || rawId === "0") continue;
          const slim = playerIndex.get(rawId);
          const { player } = ctx.crosswalk.resolve({
            provider: "sleeper",
            provider_player_id: rawId,
            full_name: slim?.full_name ?? null,
            position: slim?.position ?? null,
            nfl_team: slim?.team ?? null,
          });
          players.push({
            canonical_player_id: player.canonical_player_id,
            ownership: "rostered",
            canonical_team_id: `team:${ctx.league_slug}:${r.roster_id}`,
            waiver_clears_at: null,
          });
        }
      }
      return ok(
        {
          canonical_league_id: `league:${ctx.league_slug}`,
          league_slug: ctx.league_slug,
          players,
          provenance: { provider: "sleeper", provider_id: ctx.external_league_id, provider_synced_at: new Date().toISOString() },
        },
        {
          warnings: [
            {
              code: "free_agent_pool_not_materialized",
              message:
                "Foundation phase: only rostered ownership is reported. Full free-agent/waiver pool is deferred to the waiver analytics phase.",
            },
          ],
          status: "PARTIAL",
        },
      );
    } catch (error) {
      return degraded("PROVIDER_ERROR", "sleeper_upstream_error", describe(error));
    }
  }

  async #loadCore(leagueId: string) {
    const [league, users, rosters, drafts, nflState] = await Promise.all([
      getLeague(leagueId),
      getLeagueUsers(leagueId),
      getLeagueRosters(leagueId),
      getLeagueDrafts(leagueId).catch(() => []),
      getNflState().catch(() => null),
    ]);
    if (!league || !league.league_id) {
      throw new SleeperError(`Sleeper returned no league for ${leagueId}`, `/league/${leagueId}`, 404);
    }
    return { league, users, rosters, drafts, nflState };
  }
}
