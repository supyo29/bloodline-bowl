/**
 * Yahoo → canonical adapter.
 *
 * Yahoo's Fantasy API returns deeply nested positional arrays under
 * `fantasy_content`. A dedicated flattener (TODO, gated on real credentials)
 * will turn those into the `YahooFlat*` shapes below; THIS module then converts
 * those flattened shapes into the exact same canonical entities the Sleeper
 * adapter produces. The fixture in `test/fixtures/yahoo.ts` is written in the
 * `YahooFlat*` shape so the canonical conversion is testable now.
 */

import { leagueId, managerId, teamId, transactionId } from "@/lib/canonical/ids";
import type { PlayerCrosswalk } from "@/lib/canonical/players";
import type {
  CanonicalFantasyTeam,
  CanonicalLeague,
  CanonicalManager,
  CanonicalPlayer,
  CanonicalRoster,
  CanonicalStanding,
  CanonicalTransaction,
  Provenance,
  UnresolvedPlayer,
} from "@/lib/canonical/schema";

function prov(id: string | null, syncedAt: string | null): Provenance {
  return { provider: "yahoo", provider_id: id, provider_synced_at: syncedAt };
}

export interface YahooFlatPlayer {
  player_key: string;
  player_id: string;
  full_name: string;
  first_name?: string;
  last_name?: string;
  editorial_team_abbr: string | null;
  display_position: string | null;
  eligible_positions?: string[];
  status?: string | null;
}

export interface YahooFlatTeam {
  team_key: string;
  team_id: string;
  name: string;
  /** Yahoo manager records for this team. */
  managers: Array<{ guid: string; nickname: string; is_commissioner?: boolean; is_current_login?: boolean }>;
  wins: number;
  losses: number;
  ties: number;
  points_for: number;
  points_against: number;
  faab_balance: number | null;
  waiver_priority: number | null;
  rank: number | null;
  /** player_key -> roster slot label (e.g. "QB","BN","IR"). */
  roster: Array<{ player_key: string; selected_position: string }>;
}

export interface YahooFlatTransaction {
  transaction_key: string;
  transaction_id: string;
  type: string; // "add" | "drop" | "add/drop" | "trade" | "commish"
  status: string;
  timestamp: number; // epoch seconds
  week?: number | null;
  players: Array<{
    player_key: string;
    type: "add" | "drop";
    source_team_key?: string | null;
    destination_team_key?: string | null;
  }>;
  faab_bid?: number | null;
  trader_team_key?: string | null;
  tradee_team_key?: string | null;
}

export interface YahooFlatLeague {
  league_key: string;
  league_id: string;
  name: string;
  season: number;
  current_week: number | null;
  num_teams: number;
  scoring_type: string;
  /** Yahoo stat_id -> points value; already mapped to canonical keys upstream. */
  stat_modifiers: Record<string, number>;
  roster_positions: Array<{ position: string; count: number }>;
  playoff_start_week: number | null;
  num_playoff_teams: number | null;
  waiver_type: string | null;
  uses_faab: boolean;
}

export interface YahooFlatBundle {
  league: YahooFlatLeague;
  teams: YahooFlatTeam[];
  players: YahooFlatPlayer[];
  transactions: YahooFlatTransaction[];
}

const NON_STARTING = new Set(["BN", "IR", "IL", "NA", "TAXI"]);

export interface YahooCanonicalResult {
  league: CanonicalLeague;
  managers: CanonicalManager[];
  teams: CanonicalFantasyTeam[];
  rosters: CanonicalRoster[];
  standings: CanonicalStanding[];
  transactions: CanonicalTransaction[];
  players: CanonicalPlayer[];
  unresolved_players: UnresolvedPlayer[];
}

export function yahooBundleToCanonical(
  leagueSlug: string,
  bundle: YahooFlatBundle,
  crosswalk: PlayerCrosswalk,
  syncedAt: string | null,
): YahooCanonicalResult {
  const L = bundle.league;
  const startingSlots: string[] = [];
  for (const rp of L.roster_positions) {
    if (NON_STARTING.has(rp.position)) continue;
    for (let i = 0; i < rp.count; i += 1) startingSlots.push(rp.position);
  }
  const slotRequirements: Record<string, number> = {};
  for (const s of startingSlots) slotRequirements[s] = (slotRequirements[s] ?? 0) + 1;

  const league: CanonicalLeague = {
    canonical_league_id: leagueId(leagueSlug),
    league_slug: leagueSlug,
    name: L.name,
    season: L.season,
    status: L.current_week ? "in_season" : "pre_draft",
    sport: "nfl",
    team_count: L.num_teams,
    current_week: L.current_week,
    scoring_rules: Object.entries(L.stat_modifiers).map(([key, points]) => ({
      key,
      points,
      category: "misc" as const,
    })),
    raw_scoring: L.stat_modifiers,
    roster_settings: {
      starting_slots: startingSlots,
      bench_slots: L.roster_positions.find((p) => p.position === "BN")?.count ?? 0,
      ir_slots: L.roster_positions.find((p) => p.position === "IR" || p.position === "IL")?.count ?? 0,
      taxi_slots: 0,
      slot_requirements: slotRequirements,
    },
    playoff_settings: {
      playoff_team_count: L.num_playoff_teams,
      playoff_start_week: L.playoff_start_week,
      championship_week: L.playoff_start_week ? L.playoff_start_week + 2 : null,
    },
    waiver_settings: {
      type: L.uses_faab ? "faab" : L.waiver_type === "continual" ? "rolling" : "unknown",
      faab_budget: L.uses_faab ? 100 : null,
      waiver_day: null,
    },
    provenance: prov(L.league_key, syncedAt),
  };

  const players = new Map<string, CanonicalPlayer>();
  const unresolved: UnresolvedPlayer[] = [];
  const canonicalByYahooKey = new Map<string, string>();
  for (const yp of bundle.players) {
    const { player, unresolved: u } = crosswalk.resolve({
      provider: "yahoo",
      provider_player_id: yp.player_key,
      full_name: yp.full_name,
      first_name: yp.first_name ?? null,
      last_name: yp.last_name ?? null,
      position: yp.display_position,
      nfl_team: yp.editorial_team_abbr,
      status: yp.status ?? null,
      eligible_positions: yp.eligible_positions ?? null,
      known_identifiers: { yahoo_id: yp.player_id, yahoo_player_key: yp.player_key },
    });
    players.set(player.canonical_player_id, player);
    canonicalByYahooKey.set(yp.player_key, player.canonical_player_id);
    if (u) unresolved.push(u);
  }

  const managers = new Map<string, CanonicalManager>();
  const teams: CanonicalFantasyTeam[] = [];
  const rosters: CanonicalRoster[] = [];
  const standings: CanonicalStanding[] = [];

  for (const yt of bundle.teams) {
    const ct = teamId(leagueSlug, yt.team_id);
    const managerIds: string[] = [];
    for (const m of yt.managers) {
      const slugBase = m.nickname.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
      const cmid = managerId(leagueSlug, m.guid, slugBase);
      managerIds.push(cmid);
      if (!managers.has(cmid)) {
        managers.set(cmid, {
          canonical_manager_id: cmid,
          manager_slug: slugBase,
          provider_username: m.nickname,
          display_name: m.nickname,
          provider_user_id: m.guid,
          is_commissioner: m.is_commissioner === true,
          is_co_manager: false,
          provenance: prov(m.guid, syncedAt),
        });
      }
    }

    const gp = yt.wins + yt.losses + yt.ties;
    teams.push({
      canonical_team_id: ct,
      canonical_league_id: leagueId(leagueSlug),
      provider_team_id: yt.team_key,
      team_name: yt.name,
      canonical_manager_ids: managerIds,
      record: {
        wins: yt.wins,
        losses: yt.losses,
        ties: yt.ties,
        points_for: yt.points_for,
        points_against: yt.points_against,
      },
      faab_remaining: yt.faab_balance,
      waiver_priority: yt.waiver_priority,
      provenance: prov(yt.team_key, syncedAt),
    });

    const starters: string[] = [];
    const bench: string[] = [];
    const ir: string[] = [];
    const all: string[] = [];
    const slots = yt.roster.map((entry, i) => {
      const cid = canonicalByYahooKey.get(entry.player_key) ?? `player:yahoo:${entry.player_key}`;
      all.push(cid);
      if (entry.selected_position === "BN") bench.push(cid);
      else if (entry.selected_position === "IR" || entry.selected_position === "IL") ir.push(cid);
      else starters.push(cid);
      return {
        slot: entry.selected_position,
        slot_index: i,
        canonical_player_id: cid,
        is_empty: false,
      };
    });
    rosters.push({
      canonical_roster_id: ct.replace(/^team:/, "roster:"),
      canonical_team_id: ct,
      slots,
      starters,
      bench,
      ir,
      taxi: [],
      all_players: [...new Set(all)],
      provenance: prov(yt.team_key, syncedAt),
    });

    standings.push({
      canonical_team_id: ct,
      rank: yt.rank,
      wins: yt.wins,
      losses: yt.losses,
      ties: yt.ties,
      win_percentage: gp > 0 ? Math.round(((yt.wins + yt.ties * 0.5) / gp) * 1000) / 1000 : null,
      points_for: yt.points_for,
      points_against: yt.points_against,
      games_played: gp,
      playoff_seed: yt.rank,
    });
  }

  const transactions: CanonicalTransaction[] = bundle.transactions.map((tx) => {
    const type: CanonicalTransaction["type"] =
      tx.type === "trade"
        ? "trade"
        : tx.type === "commish"
          ? "commissioner"
          : tx.players.some((p) => p.type === "add")
            ? tx.faab_bid != null
              ? "waiver_add"
              : "free_agent_add"
            : "drop";
    return {
      canonical_transaction_id: transactionId("yahoo", leagueSlug, L.season, tx.transaction_id),
      canonical_league_id: leagueId(leagueSlug),
      league_slug: leagueSlug,
      season: L.season,
      type,
      status: tx.status,
      provider_timestamp: new Date(tx.timestamp * 1000).toISOString(),
      fantasy_week: tx.week ?? null,
      canonical_team_ids: [...new Set(
        tx.players
          .flatMap((p) => [p.source_team_key, p.destination_team_key])
          .filter((k): k is string => Boolean(k))
          .map((k) => teamKeyToCanonical(leagueSlug, bundle, k)),
      )],
      players_added: tx.players
        .filter((p) => p.type === "add")
        .map((p) => ({
          canonical_player_id: canonicalByYahooKey.get(p.player_key) ?? `player:yahoo:${p.player_key}`,
          canonical_team_id: p.destination_team_key
            ? teamKeyToCanonical(leagueSlug, bundle, p.destination_team_key)
            : null,
        })),
      players_dropped: tx.players
        .filter((p) => p.type === "drop")
        .map((p) => ({
          canonical_player_id: canonicalByYahooKey.get(p.player_key) ?? `player:yahoo:${p.player_key}`,
          canonical_team_id: p.source_team_key
            ? teamKeyToCanonical(leagueSlug, bundle, p.source_team_key)
            : null,
        })),
      trade_legs: [],
      faab_spent: tx.faab_bid ?? null,
      provenance: prov(tx.transaction_key, syncedAt),
      source_metadata: { yahoo_type: tx.type },
    };
  });

  return {
    league,
    managers: [...managers.values()],
    teams,
    rosters,
    standings: standings.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)),
    transactions,
    players: [...players.values()],
    unresolved_players: unresolved,
  };
}

function teamKeyToCanonical(leagueSlug: string, bundle: YahooFlatBundle, teamKey: string): string {
  const team = bundle.teams.find((t) => t.team_key === teamKey);
  return teamId(leagueSlug, team?.team_id ?? teamKey);
}
