/**
 * Sleeper → canonical adapter. Pure functions only: no network, no HTTP.
 *
 * Every `Raw*` shape from `lib/sleeper/types.ts` is converted here into the
 * provider-independent entities in `lib/canonical/schema.ts`. Sleeper concepts
 * (`roster_id`, `owner_id`, the `"0"` starter sentinel) are translated, never
 * passed through.
 */

import {
  draftPickId,
  leagueId,
  managerId,
  matchupId,
  rosterId,
  teamId,
  transactionId,
} from "@/lib/canonical/ids";
import type { PlayerCrosswalk } from "@/lib/canonical/players";
import type {
  CanonicalDraftPick,
  CanonicalFantasyTeam,
  CanonicalLeague,
  CanonicalManager,
  CanonicalMatchup,
  CanonicalPlayer,
  CanonicalRoster,
  CanonicalRosterSlot,
  CanonicalScoringRule,
  CanonicalStanding,
  CanonicalTransaction,
  Provenance,
  UnresolvedPlayer,
} from "@/lib/canonical/schema";
import { CANONICAL_SCHEMA_VERSION } from "@/lib/canonical/schema";
import type {
  RawDraft,
  RawDraftPick,
  RawLeague,
  RawLeagueUser,
  RawMatchup,
  RawRoster,
  RawTransaction,
} from "@/lib/sleeper/types";
import type { PlayerIndex } from "@/lib/sleeper/client";

const STARTER_SENTINEL = "0";
const NON_STARTING = new Set(["BN", "TAXI", "IR"]);

function prov(providerId: string | null, syncedAt: string | null): Provenance {
  return { provider: "sleeper", provider_id: providerId, provider_synced_at: syncedAt };
}

/**
 * ONE Sleeper player-identity resolver, shared across every surface (rosters,
 * matchups, transactions, draft picks) so the same NFL player gets the same
 * `canonical_player_id` everywhere — via the crosswalk, not a raw
 * `player:sleeper:<id>` string. Memoized per raw id; accumulates the full
 * `CanonicalPlayer` set and any unresolved identities.
 */
export interface SleeperPlayerResolver {
  resolve(rawId: string): string;
  readonly players: Map<string, CanonicalPlayer>;
  readonly unresolved: UnresolvedPlayer[];
}

export function createSleeperResolver(
  playerIndex: PlayerIndex,
  crosswalk: PlayerCrosswalk,
): SleeperPlayerResolver {
  const players = new Map<string, CanonicalPlayer>();
  const unresolved: UnresolvedPlayer[] = [];
  const cache = new Map<string, string>();

  return {
    players,
    unresolved,
    resolve(rawId: string): string {
      const cached = cache.get(rawId);
      if (cached) return cached;
      const slim = playerIndex.get(rawId);
      const { player, unresolved: u } = crosswalk.resolve({
        provider: "sleeper",
        provider_player_id: rawId,
        full_name: slim?.full_name ?? null,
        first_name: slim?.first_name ?? null,
        last_name: slim?.last_name ?? null,
        position: slim?.position ?? null,
        nfl_team: slim?.team ?? null,
        status: slim?.status ?? null,
        injury_status: slim?.injury_status ?? null,
        eligible_positions: slim?.fantasy_positions ?? null,
      });
      players.set(player.canonical_player_id, player);
      if (u) unresolved.push(u);
      cache.set(rawId, player.canonical_player_id);
      return player.canonical_player_id;
    },
  };
}

function scoringCategory(key: string): CanonicalScoringRule["category"] {
  if (key.startsWith("pass_")) return "passing";
  if (key.startsWith("rush_")) return "rushing";
  if (key.startsWith("rec") || key === "bonus_rec_te") return "receiving";
  if (key.startsWith("fgm") || key.startsWith("xp") || key.startsWith("fg")) return "kicking";
  if (
    key.startsWith("def") ||
    key.startsWith("pts_allow") ||
    ["sack", "int", "safe", "ff", "fum_rec", "blk_kick", "tkl_loss", "qb_hit"].includes(key)
  ) {
    return "defense";
  }
  if (key.startsWith("st_") || key.startsWith("pr_") || key.startsWith("kr_")) return "special_teams";
  return "misc";
}

export function toCanonicalScoringRules(raw: Record<string, number>): CanonicalScoringRule[] {
  return Object.entries(raw)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    .map(([key, points]) => ({ key, points, category: scoringCategory(key) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function toCanonicalLeague(
  leagueSlug: string,
  league: RawLeague,
  currentWeek: number | null,
  syncedAt: string | null,
): CanonicalLeague {
  const positions = league.roster_positions ?? [];
  const startingSlots = positions.filter((p) => !NON_STARTING.has(p));
  const slotRequirements: Record<string, number> = {};
  for (const slot of startingSlots) slotRequirements[slot] = (slotRequirements[slot] ?? 0) + 1;
  const settings = league.settings ?? {};

  const waiverType =
    settings.waiver_type === 2
      ? "faab"
      : settings.waiver_type === 0
        ? "rolling"
        : settings.waiver_type === 1
          ? "reverse_standings"
          : "unknown";

  return {
    canonical_league_id: leagueId(leagueSlug),
    league_slug: leagueSlug,
    name: league.name,
    season: Number.parseInt(league.season, 10),
    status: league.status ?? "unknown",
    sport: "nfl",
    team_count: league.total_rosters,
    current_week: currentWeek,
    scoring_rules: toCanonicalScoringRules(league.scoring_settings ?? {}),
    raw_scoring: league.scoring_settings ?? {},
    roster_settings: {
      starting_slots: startingSlots,
      bench_slots: positions.filter((p) => p === "BN").length,
      ir_slots: settings.reserve_slots ?? positions.filter((p) => p === "IR").length,
      taxi_slots: settings.taxi_slots ?? positions.filter((p) => p === "TAXI").length,
      slot_requirements: slotRequirements,
    },
    playoff_settings: {
      playoff_team_count: settings.playoff_teams ?? null,
      playoff_start_week: settings.playoff_week_start ?? null,
      championship_week: settings.playoff_week_start
        ? settings.playoff_week_start + Math.max(0, (settings.playoff_round_type ?? 0) === 0 ? 2 : 3)
        : null,
    },
    waiver_settings: {
      type: waiverType,
      faab_budget: waiverType === "faab" ? (settings.waiver_budget ?? 100) : null,
      waiver_day: null,
    },
    provenance: prov(league.league_id, syncedAt),
  };
}

export function toCanonicalManagers(
  leagueSlug: string,
  users: RawLeagueUser[],
  rosters: RawRoster[],
  syncedAt: string | null,
): CanonicalManager[] {
  const coOwnerIds = new Set<string>();
  for (const r of rosters) for (const co of r.co_owners ?? []) coOwnerIds.add(co);

  return users.map((u) => {
    const slugBase = (u.display_name ?? u.user_id)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return {
      canonical_manager_id: managerId(leagueSlug, u.user_id, slugBase),
      manager_slug: slugBase,
      provider_username: u.display_name ?? null,
      display_name: u.display_name ?? null,
      provider_user_id: u.user_id,
      is_commissioner: u.is_owner === true,
      is_co_manager: coOwnerIds.has(u.user_id),
      provenance: prov(u.user_id, syncedAt),
    };
  });
}

export function toCanonicalTeams(
  leagueSlug: string,
  rosters: RawRoster[],
  faabBudget: number | null,
  syncedAt: string | null,
): CanonicalFantasyTeam[] {
  return rosters
    .map((r): CanonicalFantasyTeam => {
      const s = r.settings ?? {};
      const managerIds: string[] = [];
      if (r.owner_id) managerIds.push(managerId(leagueSlug, r.owner_id, r.owner_id));
      for (const co of r.co_owners ?? []) managerIds.push(managerId(leagueSlug, co, co));
      const pf = round2((s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100);
      const pa = round2((s.fpts_against ?? 0) + (s.fpts_against_decimal ?? 0) / 100);
      return {
        canonical_team_id: teamId(leagueSlug, String(r.roster_id)),
        canonical_league_id: leagueId(leagueSlug),
        provider_team_id: String(r.roster_id),
        team_name:
          (r.metadata?.team_name as string | undefined) ?? null,
        canonical_manager_ids: managerIds,
        record: {
          wins: s.wins ?? 0,
          losses: s.losses ?? 0,
          ties: s.ties ?? 0,
          points_for: pf,
          points_against: pa,
        },
        faab_remaining:
          faabBudget != null ? faabBudget - (s.waiver_budget_used ?? 0) : null,
        waiver_priority: s.waiver_position ?? null,
        provenance: prov(String(r.roster_id), syncedAt),
      };
    })
    .sort((a, b) => Number(a.provider_team_id) - Number(b.provider_team_id));
}

export interface RosterResolution {
  rosters: CanonicalRoster[];
  players: CanonicalPlayer[];
  unresolved: UnresolvedPlayer[];
}

export function toCanonicalRosters(
  leagueSlug: string,
  rosters: RawRoster[],
  startingSlots: string[],
  playerIndex: PlayerIndex,
  crosswalk: PlayerCrosswalk,
  syncedAt: string | null,
  sharedResolver?: SleeperPlayerResolver,
): RosterResolution {
  const resolver = sharedResolver ?? createSleeperResolver(playerIndex, crosswalk);
  const resolveId = (rawId: string): string => resolver.resolve(rawId);

  const clean = (ids: string[] | null | undefined): string[] =>
    (ids ?? []).filter(
      (id): id is string => typeof id === "string" && id.length > 0 && id !== STARTER_SENTINEL,
    );

  const canonicalRosters = rosters
    .map((r): CanonicalRoster => {
      const ct = teamId(leagueSlug, String(r.roster_id));
      const allIds = clean(r.players);
      const taxiIds = clean(r.taxi);
      const irIds = clean(r.reserve);
      const rawStarters = Array.isArray(r.starters) ? r.starters : [];

      const slots: CanonicalRosterSlot[] = [];
      const starterCanonical: string[] = [];
      for (let i = 0; i < Math.max(startingSlots.length, rawStarters.length); i += 1) {
        const rawId = rawStarters[i];
        const isEmpty =
          typeof rawId !== "string" || rawId.length === 0 || rawId === STARTER_SENTINEL;
        const cid = isEmpty ? null : resolveId(rawId as string);
        if (cid) starterCanonical.push(cid);
        slots.push({
          slot: startingSlots[i] ?? "FLEX",
          slot_index: i,
          canonical_player_id: cid,
          is_empty: isEmpty,
        });
      }

      const starterSet = new Set(clean(r.starters));
      const nonBench = new Set([...starterSet, ...taxiIds, ...irIds]);
      const benchIds = allIds.filter((id) => !nonBench.has(id));

      const bench = benchIds.map(resolveId);
      const taxi = taxiIds.map(resolveId);
      const ir = irIds.map(resolveId);
      const all = allIds.map(resolveId);

      let idx = slots.length;
      for (const cid of bench) slots.push({ slot: "BN", slot_index: idx++, canonical_player_id: cid, is_empty: false });
      for (const cid of ir) slots.push({ slot: "IR", slot_index: idx++, canonical_player_id: cid, is_empty: false });
      for (const cid of taxi) slots.push({ slot: "TAXI", slot_index: idx++, canonical_player_id: cid, is_empty: false });

      return {
        canonical_roster_id: rosterId(ct),
        canonical_team_id: ct,
        slots,
        starters: starterCanonical,
        bench,
        ir,
        taxi,
        all_players: [...new Set(all)],
        provenance: prov(String(r.roster_id), syncedAt),
      };
    })
    .sort((a, b) => a.canonical_team_id.localeCompare(b.canonical_team_id));

  return {
    rosters: canonicalRosters,
    players: [...resolver.players.values()],
    unresolved: resolver.unresolved,
  };
}

export function toCanonicalStandings(
  leagueSlug: string,
  rosters: RawRoster[],
): CanonicalStanding[] {
  const rows = rosters.map((r) => {
    const s = r.settings ?? {};
    const wins = s.wins ?? 0;
    const losses = s.losses ?? 0;
    const ties = s.ties ?? 0;
    const gp = wins + losses + ties;
    return {
      canonical_team_id: teamId(leagueSlug, String(r.roster_id)),
      rank: null as number | null,
      wins,
      losses,
      ties,
      win_percentage: gp > 0 ? round3((wins + ties * 0.5) / gp) : null,
      points_for: round2((s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100),
      points_against: round2((s.fpts_against ?? 0) + (s.fpts_against_decimal ?? 0) / 100),
      games_played: gp,
      playoff_seed: null as number | null,
    };
  });
  rows
    .slice()
    .sort((a, b) => b.wins - a.wins || b.points_for - a.points_for)
    .forEach((row, i) => {
      row.rank = i + 1;
    });
  return rows.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
}

export function toCanonicalMatchups(
  leagueSlug: string,
  week: number,
  rawMatchups: RawMatchup[],
  playerIndex: PlayerIndex,
  crosswalk: PlayerCrosswalk,
  syncedAt: string | null,
  sharedResolver?: SleeperPlayerResolver,
): CanonicalMatchup[] {
  const byMatchup = new Map<number, RawMatchup[]>();
  for (const row of rawMatchups) {
    const key = row.matchup_id ?? -row.roster_id;
    const bucket = byMatchup.get(key) ?? [];
    bucket.push(row);
    byMatchup.set(key, bucket);
  }

  const resolver = sharedResolver ?? createSleeperResolver(playerIndex, crosswalk);
  const resolveId = (rawId: string): string => resolver.resolve(rawId);

  return [...byMatchup.entries()]
    .map(([key, rows]) => {
      const anyScored = rows.some((r) => typeof r.points === "number" && r.points > 0);
      return {
        canonical_matchup_id: matchupId(leagueSlug, week, String(key)),
        canonical_league_id: leagueId(leagueSlug),
        week,
        status: anyScored ? ("in_progress" as const) : ("pre" as const),
        sides: rows.map((r) => {
          const starters = (r.starters ?? []).filter((id) => id && id !== STARTER_SENTINEL);
          const players = (r.players ?? []).filter((id) => id && id !== STARTER_SENTINEL);
          const playerPoints: Record<string, number> = {};
          for (const [pid, pts] of Object.entries(r.players_points ?? {})) {
            playerPoints[resolveId(pid)] = pts;
          }
          return {
            canonical_team_id: teamId(leagueSlug, String(r.roster_id)),
            canonical_manager_ids: [],
            starters: starters.map(resolveId),
            bench: players.filter((id) => !starters.includes(id)).map(resolveId),
            actual_points: typeof r.points === "number" ? r.points : null,
            player_points: playerPoints,
            projected_points: null,
          };
        }),
        provenance: prov(null, syncedAt),
      };
    })
    .sort((a, b) => a.canonical_matchup_id.localeCompare(b.canonical_matchup_id));
}

export function toCanonicalTransactions(
  leagueSlug: string,
  season: number,
  raw: RawTransaction[],
  syncedAt: string | null,
  resolver: SleeperPlayerResolver,
): CanonicalTransaction[] {
  return raw
    .map((t): CanonicalTransaction => {
      const type = mapTransactionType(t);
      const added = Object.entries(t.adds ?? {}).map(([pid, rid]) => ({
        canonical_player_id: resolver.resolve(pid),
        canonical_team_id: teamId(leagueSlug, String(rid)),
      }));
      const dropped = Object.entries(t.drops ?? {}).map(([pid, rid]) => ({
        canonical_player_id: resolver.resolve(pid),
        canonical_team_id: teamId(leagueSlug, String(rid)),
      }));

      const legs =
        t.type === "trade"
          ? t.roster_ids.map((rid) => ({
              canonical_team_id: teamId(leagueSlug, String(rid)),
              received_player_ids: Object.entries(t.adds ?? {})
                .filter(([, r]) => r === rid)
                .map(([pid]) => resolver.resolve(pid)),
              received_pick_labels: (t.draft_picks ?? [])
                .filter((p) => p.owner_id === rid)
                .map((p) => `${p.season} R${p.round}`),
              received_faab: (t.waiver_budget ?? [])
                .filter((b) => b.receiver === rid)
                .reduce((sum, b) => sum + b.amount, 0),
            }))
          : [];

      const waiverBid =
        typeof t.settings?.waiver_bid === "number" ? t.settings.waiver_bid : null;

      return {
        canonical_transaction_id: transactionId("sleeper", leagueSlug, season, t.transaction_id),
        canonical_league_id: leagueId(leagueSlug),
        league_slug: leagueSlug,
        season,
        type,
        status: t.status ?? null,
        provider_timestamp: t.created ? new Date(t.created).toISOString() : null,
        fantasy_week: t.leg ?? null,
        canonical_team_ids: t.roster_ids.map((rid) => teamId(leagueSlug, String(rid))),
        players_added: added,
        players_dropped: dropped,
        trade_legs: legs,
        faab_spent: waiverBid,
        provenance: prov(t.transaction_id, syncedAt),
        source_metadata: { sleeper_type: t.type, consenter_ids: t.consenter_ids ?? null },
      };
    })
    .sort((a, b) => (b.provider_timestamp ?? "").localeCompare(a.provider_timestamp ?? ""));
}

function mapTransactionType(t: RawTransaction): CanonicalTransaction["type"] {
  if (t.type === "trade") return "trade";
  if (t.type === "commissioner") return "commissioner";
  const hasAdd = t.adds && Object.keys(t.adds).length > 0;
  const hasDrop = t.drops && Object.keys(t.drops).length > 0;
  if (t.type === "waiver") return "waiver_add";
  if (t.type === "free_agent") return hasAdd ? "free_agent_add" : hasDrop ? "drop" : "other";
  return "other";
}

export function toCanonicalDraftPicks(
  leagueSlug: string,
  season: number,
  drafts: RawDraft[],
  picksByDraft: Map<string, RawDraftPick[]>,
  playerIndex: PlayerIndex,
  crosswalk: PlayerCrosswalk,
  users: RawLeagueUser[],
  syncedAt: string | null,
  sharedResolver?: SleeperPlayerResolver,
): CanonicalDraftPick[] {
  const resolver = sharedResolver ?? createSleeperResolver(playerIndex, crosswalk);
  const out: CanonicalDraftPick[] = [];
  const userSlug = (uid: string | null): string => {
    if (!uid) return uid ?? "";
    const u = users.find((x) => x.user_id === uid);
    return (u?.display_name ?? uid).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  };
  for (const draft of drafts) {
    const picks = picksByDraft.get(draft.draft_id) ?? [];
    for (const p of picks) {
      const rid =
        typeof p.roster_id === "number"
          ? p.roster_id
          : typeof p.roster_id === "string" && p.roster_id
            ? Number.parseInt(p.roster_id, 10)
            : null;
      const cpid: string | null = p.player_id ? resolver.resolve(p.player_id) : null;
      out.push({
        canonical_draft_pick_id: draftPickId(leagueSlug, season, p.pick_no),
        canonical_league_id: leagueId(leagueSlug),
        season,
        round: p.round,
        pick_number: p.pick_no,
        draft_slot: p.draft_slot ?? null,
        canonical_team_id: rid != null && Number.isFinite(rid) ? teamId(leagueSlug, String(rid)) : null,
        canonical_manager_id: p.picked_by ? managerId(leagueSlug, p.picked_by, userSlug(p.picked_by)) : null,
        canonical_player_id: cpid,
        auction_amount: p.metadata?.amount ? Number.parseInt(p.metadata.amount, 10) : null,
        is_keeper: p.is_keeper === true,
        provenance: prov(draft.draft_id, syncedAt),
      });
    }
  }
  return out.sort((a, b) => a.pick_number - b.pick_number);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export const SLEEPER_ADAPTER_SCHEMA_VERSION = CANONICAL_SCHEMA_VERSION;
