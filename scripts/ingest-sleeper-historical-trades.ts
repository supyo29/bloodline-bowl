/**
 * PHASE 3.5 COMPLETION — Part A: real Sleeper historical-trade ingestion.
 *
 *   npx tsx scripts/ingest-sleeper-historical-trades.ts
 *
 * Scans every registered Sleeper league (walking each league's
 * `previous_league_id` chain back through every prior season Sleeper knows
 * about) for real, completed "trade" transactions, reconstructs pre-trade
 * roster ownership by CHRONOLOGICALLY REPLAYING every roster-changing
 * transaction from the season's draft results forward (never using current
 * rosters), and writes a versioned dataset to
 * lib/trades/data/historical_trades_sleeper.json.
 *
 * Real leagues scanned (from lib/leagues/registry.ts, Sleeper-provider only —
 * the two Yahoo-provider registry entries are out of scope for this script):
 *   - bloodline-bowl        (2026 only — previous_league_id is null; a
 *                             brand-new league with no prior Sleeper season)
 *   - devoted-to-the-game   (2026 -> 2025; 2025's previous_league_id is null)
 *
 * This is READ-ONLY against the public Sleeper API. Nothing is mutated.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join("lib", "trades", "data");
const OUT_FILE = join(OUT_DIR, "historical_trades_sleeper.json");
const DATA_VERSION = "sleeper-historical-trades-2026.1";

const ROOT_LEAGUES: Array<{ key: string; league_id: string }> = [
  { key: "bloodline-bowl", league_id: "1395549281678532608" },
  { key: "devoted-to-the-game", league_id: "1389735763649761280" },
];

async function jget<T>(url: string): Promise<T | null> {
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return (await r.json()) as T;
}

interface RawLeague {
  league_id: string;
  season: string;
  previous_league_id: string | null;
  name: string;
}
interface RawRoster {
  roster_id: number;
  owner_id: string | null;
}
interface RawUser {
  user_id: string;
  display_name: string | null;
  username: string | null;
}
interface RawDraft {
  draft_id: string;
}
interface RawDraftPick {
  player_id: string | null;
  roster_id: string | number | null;
  pick_no: number;
}
interface RawTransaction {
  transaction_id: string;
  type: string;
  status: string;
  created: number | null;
  leg: number | null;
  roster_ids: number[];
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  draft_picks: Array<{ season: string; round: number; roster_id: number; previous_owner_id: number; owner_id: number }> | null;
  consenter_ids: number[] | null;
}

interface HistoricalTransfer {
  from_roster_id: number | null;
  to_roster_id: number;
  asset_type: "PLAYER" | "DRAFT_PICK";
  player_id: string | null;
  draft_pick_season: string | null;
  draft_pick_round: number | null;
  supported: boolean;
}
interface HistoricalTradeParticipant {
  roster_id: number;
  owner_user_id: string | null;
  display_name: string | null;
}
interface HistoricalTradeRecordOut {
  trade_id: string;
  league_id: string;
  league_slug: string;
  season: number;
  week: number | null;
  timestamp: string | null;
  participants: HistoricalTradeParticipant[];
  transfers: HistoricalTransfer[];
  pre_trade_snapshot: {
    ownership_status: "OWNERSHIP_KNOWN" | "OWNERSHIP_UNCERTAIN";
    lineup_status: "LINEUP_UNKNOWN"; // Sleeper's roster.starters only reflects the CURRENT state, never a historical point-in-time — never fabricated as known
    rosters: Record<string, string[]>; // roster_id -> player_id[]
    reconstruction_method: string;
  };
  model_input_cutoff: string | null;
  diagnostics: string[];
}

/** Chronological ordering key: `created` when present, else a large sentinel so undated events sort last within their week (documented, not silently ignored). */
function orderKey(t: RawTransaction): number {
  if (t.created != null) return t.created;
  return (t.leg ?? 999) * 1e13; // no timestamp — order by week only, documented via diagnostics on affected trades
}

async function walkLeagueChain(rootLeagueId: string): Promise<RawLeague[]> {
  const chain: RawLeague[] = [];
  let id: string | null = rootLeagueId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const league: RawLeague | null = await jget<RawLeague>(`https://api.sleeper.app/v1/league/${id}`);
    if (!league) break;
    chain.push(league);
    id = league.previous_league_id;
  }
  return chain;
}

async function processLeagueSeason(leagueSlug: string, league: RawLeague): Promise<HistoricalTradeRecordOut[]> {
  const leagueId = league.league_id;
  const season = Number(league.season);

  const [users, drafts] = await Promise.all([
    jget<RawUser[]>(`https://api.sleeper.app/v1/league/${leagueId}/users`),
    jget<Array<{ draft_id: string }>>(`https://api.sleeper.app/v1/league/${leagueId}/drafts`),
  ]);
  const usersByOwner = new Map((users ?? []).map((u) => [u.user_id, u]));

  const rosters = (await jget<RawRoster[]>(`https://api.sleeper.app/v1/league/${leagueId}/rosters`)) ?? [];
  const ownerByRoster = new Map(rosters.map((r) => [r.roster_id, r.owner_id]));

  // ---- initial roster state: post-draft picks (most-recent draft for the season) ----
  const draftId = drafts?.[0]?.draft_id;
  const initialRosters = new Map<number, Set<string>>();
  for (const r of rosters) initialRosters.set(r.roster_id, new Set());
  if (draftId) {
    const picks = (await jget<RawDraftPick[]>(`https://api.sleeper.app/v1/draft/${draftId}/picks`)) ?? [];
    for (const p of picks) {
      const rid = typeof p.roster_id === "string" ? Number(p.roster_id) : p.roster_id;
      if (rid != null && p.player_id) {
        if (!initialRosters.has(rid)) initialRosters.set(rid, new Set());
        initialRosters.get(rid)!.add(p.player_id);
      }
    }
  }

  // ---- pull every week's transactions (Sleeper: week 0 = preseason waivers, 1-18 regular+playoff) ----
  const allTx: RawTransaction[] = [];
  for (let week = 0; week <= 18; week += 1) {
    const tx = await jget<RawTransaction[]>(`https://api.sleeper.app/v1/league/${leagueId}/transactions/${week}`);
    if (tx) for (const t of tx) allTx.push({ ...t, leg: t.leg ?? week });
  }
  const complete = allTx.filter((t) => t.status === "complete" && (t.type === "trade" || t.type === "waiver" || t.type === "free_agent"));
  complete.sort((a, b) => orderKey(a) - orderKey(b) || a.transaction_id.localeCompare(b.transaction_id));

  const trades = complete.filter((t) => t.type === "trade");
  const out: HistoricalTradeRecordOut[] = [];

  // ---- replay: walk the sorted transaction list once, snapshotting roster state at each trade ----
  const rosterState = new Map<number, Set<string>>();
  for (const [rid, players] of initialRosters) rosterState.set(rid, new Set(players));

  for (const t of complete) {
    if (t.type === "trade") {
      const diagnostics: string[] = [];
      const snapshot: Record<string, string[]> = {};
      for (const [rid, players] of rosterState) snapshot[String(rid)] = [...players].sort();

      const transfers: HistoricalTransfer[] = [];
      const addedPlayers = new Set(Object.keys(t.adds ?? {}));
      for (const [playerId, toRoster] of Object.entries(t.adds ?? {})) {
        // who owned it just before this trade, per the replay (authoritative — not `drops`, which Sleeper sometimes omits for edge cases)
        let fromRoster: number | null = null;
        for (const [rid, players] of rosterState) {
          if (rid !== toRoster && players.has(playerId)) fromRoster = rid;
        }
        if (fromRoster == null) diagnostics.push(`player ${playerId}: no prior owner found in the replayed state (possible mid-season free agent folded into this trade, or an untracked pickup before the transaction log begins) — from_roster_id left null`);
        transfers.push({ from_roster_id: fromRoster, to_roster_id: toRoster, asset_type: "PLAYER", player_id: playerId, draft_pick_season: null, draft_pick_round: null, supported: true });
      }
      for (const dp of t.draft_picks ?? []) {
        diagnostics.push(`draft pick (season ${dp.season}, round ${dp.round}) moved roster ${dp.previous_owner_id} -> ${dp.owner_id} — UNSUPPORTED asset type for the current trade engine (Phase 1 supports PLAYER only); preserved as raw metadata, not discarded`);
        transfers.push({ from_roster_id: dp.previous_owner_id, to_roster_id: dp.owner_id, asset_type: "DRAFT_PICK", player_id: null, draft_pick_season: dp.season, draft_pick_round: dp.round, supported: false });
      }
      if (t.created == null) diagnostics.push("transaction has no `created` timestamp — chronological order for this trade relative to same-week siblings falls back to week+transaction_id, not exact wall-clock time");

      const participantRosterIds = [...new Set([...(t.roster_ids ?? []), ...transfers.map((x) => x.to_roster_id), ...transfers.map((x) => x.from_roster_id).filter((x): x is number => x != null)])];
      out.push({
        trade_id: t.transaction_id,
        league_id: leagueId,
        league_slug: leagueSlug,
        season,
        week: t.leg,
        timestamp: t.created != null ? new Date(t.created).toISOString() : null,
        participants: participantRosterIds.map((rid) => {
          const ownerId = ownerByRoster.get(rid) ?? null;
          const u = ownerId ? usersByOwner.get(ownerId) : undefined;
          return { roster_id: rid, owner_user_id: ownerId, display_name: u?.display_name ?? u?.username ?? null };
        }),
        transfers,
        pre_trade_snapshot: {
          ownership_status: "OWNERSHIP_KNOWN",
          lineup_status: "LINEUP_UNKNOWN",
          rosters: snapshot,
          reconstruction_method: draftId
            ? `replay: initial roster = draft ${draftId} picks, then every complete trade/waiver/free_agent transaction with an earlier sort key applied in order`
            : "replay: no draft found for this league/season — initial roster assumed EMPTY (pre-existing keeper/dynasty holdovers before the transaction log begins are NOT reflected)",
        },
        model_input_cutoff: t.created != null ? new Date(t.created).toISOString() : null,
        diagnostics,
      });
    }

    // apply this transaction's effect to the replay state (trade or not — waivers/free-agent moves matter for reconstructing LATER trades)
    for (const [playerId, toRoster] of Object.entries(t.adds ?? {})) {
      for (const [, players] of rosterState) players.delete(playerId); // remove from wherever it was (defensive — should be at most one roster)
      if (!rosterState.has(toRoster)) rosterState.set(toRoster, new Set());
      rosterState.get(toRoster)!.add(playerId);
    }
    for (const [playerId, fromRoster] of Object.entries(t.drops ?? {})) {
      rosterState.get(fromRoster)?.delete(playerId);
    }
  }

  return out;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const allRecords: HistoricalTradeRecordOut[] = [];
  const scanSummary: Array<{ league_slug: string; league_id: string; season: number; trades_found: number }> = [];

  for (const root of ROOT_LEAGUES) {
    let chain: RawLeague[] = [];
    try {
      chain = await walkLeagueChain(root.league_id);
    } catch (e) {
      console.error(`Failed to walk league chain for ${root.key}: ${(e as Error).message}`);
      continue;
    }
    for (const league of chain) {
      try {
        const records = await processLeagueSeason(root.key, league);
        allRecords.push(...records);
        scanSummary.push({ league_slug: root.key, league_id: league.league_id, season: Number(league.season), trades_found: records.length });
        console.error(`${root.key} season ${league.season} (${league.league_id}): ${records.length} completed trade(s)`);
      } catch (e) {
        console.error(`Failed processing ${root.key} season ${league.season}: ${(e as Error).message}`);
      }
    }
  }

  const output = {
    data_version: DATA_VERSION,
    generated_at: new Date().toISOString(),
    source: "sleeper",
    scan_summary: scanSummary,
    total_leagues_scanned: scanSummary.length,
    total_trades_found: allRecords.length,
    records: allRecords,
  };
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.error(`\nWrote ${allRecords.length} real completed trade record(s) to ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
