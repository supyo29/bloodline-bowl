/**
 * Trade Engine — Phase 3.5 completion: real Sleeper historical-trade loader.
 *
 * Reads `lib/trades/data/historical_trades_sleeper.json` (produced by
 * `scripts/ingest-sleeper-historical-trades.ts`, a READ-ONLY scan of the
 * public Sleeper API) and maps each real, completed trade transaction into
 * `HistoricalTradeRecord` (`lib/trades/historical.ts`) so it can run through
 * the existing `assertNoLookahead` guard and `summarizeHistoricalDataset`.
 *
 * This module does NOT compute outcomes (§10 of the completion spec: "keep
 * future outcomes separate from input data") — every loaded record has
 * `outcome: null`. Populating real outcomes (realized post-trade points,
 * weeks started, etc.) is future work, explicitly out of scope for this pass
 * — see the Phase 3.5 completion report's Future Work section.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { HistoricalTradeRecord } from "./historical";

const FILE_PATH = join(process.cwd(), "lib", "trades", "data", "historical_trades_sleeper.json");

export interface RawIngestedTransfer {
  from_roster_id: number | null;
  to_roster_id: number;
  asset_type: "PLAYER" | "DRAFT_PICK";
  player_id: string | null;
  draft_pick_season: string | null;
  draft_pick_round: number | null;
  supported: boolean;
}
export interface RawIngestedRecord {
  trade_id: string;
  league_id: string;
  league_slug: string;
  season: number;
  week: number | null;
  timestamp: string | null;
  participants: Array<{ roster_id: number; owner_user_id: string | null; display_name: string | null }>;
  transfers: RawIngestedTransfer[];
  pre_trade_snapshot: {
    ownership_status: "OWNERSHIP_KNOWN" | "OWNERSHIP_UNCERTAIN";
    lineup_status: "LINEUP_UNKNOWN";
    rosters: Record<string, string[]>;
    reconstruction_method: string;
  };
  model_input_cutoff: string | null;
  diagnostics: string[];
}
export interface IngestedHistoricalDataset {
  data_version: string;
  generated_at: string;
  source: "sleeper";
  scan_summary: Array<{ league_slug: string; league_id: string; season: number; trades_found: number }>;
  total_leagues_scanned: number;
  total_trades_found: number;
  records: RawIngestedRecord[];
}

export function loadIngestedHistoricalDataset(): IngestedHistoricalDataset | null {
  if (!existsSync(FILE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(FILE_PATH, "utf8")) as IngestedHistoricalDataset;
  } catch {
    return null; // malformed file is treated as absent, never partially trusted
  }
}

/**
 * Maps one raw ingested Sleeper trade into the Phase 3 `HistoricalTradeRecord`
 * shape. `outcome` is always `null` (see module doc). Unsupported assets
 * (draft picks) are preserved verbatim inside `model_inputs_summary`, never
 * silently dropped — a caller filtering to PLAYER-only trades should check
 * `unsupported_asset_count`, not assume every transfer is a player.
 */
export function toHistoricalTradeRecord(raw: RawIngestedRecord): HistoricalTradeRecord {
  const unsupportedCount = raw.transfers.filter((t) => !t.supported).length;
  return {
    trade_id: raw.trade_id,
    league_slug: raw.league_slug,
    trade_date: raw.timestamp ?? raw.model_input_cutoff ?? new Date(0).toISOString(),
    input_snapshot_captured_at: raw.model_input_cutoff ?? raw.timestamp ?? new Date(0).toISOString(),
    proposal: { participants: raw.participants, transfers: raw.transfers },
    model_inputs_summary: {
      season: raw.season,
      week: raw.week,
      pre_trade_snapshot: raw.pre_trade_snapshot,
      unsupported_asset_count: unsupportedCount,
      diagnostics: raw.diagnostics,
      source: "sleeper (real, read-only API scan)",
    },
    outcome: null,
    human_label: null,
    human_label_reason: null,
  };
}

export interface RealHistoricalDatasetSummary {
  dataset_present: boolean;
  data_version: string | null;
  total_records: number;
  leagues_scanned: number;
  trades_with_unsupported_assets: number;
  trades_with_missing_timestamp: number;
  two_team_trades: number;
  three_team_trades: number;
  records: HistoricalTradeRecord[];
}

/** Loads and maps the real ingested dataset, with the honest zero-record fallback (dataset_present: false) if the file was never generated. */
export function loadRealHistoricalTradeRecords(): RealHistoricalDatasetSummary {
  const dataset = loadIngestedHistoricalDataset();
  if (!dataset) {
    return { dataset_present: false, data_version: null, total_records: 0, leagues_scanned: 0, trades_with_unsupported_assets: 0, trades_with_missing_timestamp: 0, two_team_trades: 0, three_team_trades: 0, records: [] };
  }
  const records = dataset.records.map(toHistoricalTradeRecord);
  const participantCounts = dataset.records.map((r) => new Set(r.participants.map((p) => p.roster_id)).size);
  return {
    dataset_present: true,
    data_version: dataset.data_version,
    total_records: records.length,
    leagues_scanned: dataset.total_leagues_scanned,
    trades_with_unsupported_assets: dataset.records.filter((r) => r.transfers.some((t) => !t.supported)).length,
    trades_with_missing_timestamp: dataset.records.filter((r) => r.timestamp == null).length,
    two_team_trades: participantCounts.filter((c) => c === 2).length,
    three_team_trades: participantCounts.filter((c) => c === 3).length,
    records,
  };
}
