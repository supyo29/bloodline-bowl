/**
 * Competitive Trade Intelligence — normalized trade-market snapshot (Checkpoint B).
 *
 * Adapts the market infrastructure that ALREADY EXISTS in the repo — it never
 * opens a network connection and never creates a second market pipeline:
 *
 *   provider_benchmark   ← `RosSignal` on each `WeeklyProjection`
 *                          (Sleeper / RotoWire ROS projection, already in league
 *                          scoring; `lib/weekly/schema.ts`, `lib/projections/sleeper.ts`)
 *   draft_market         ← `buildMarketConsensus()` (preseason ADP consensus;
 *                          `lib/draft/market.ts`) — pure, vendored, no I/O
 *   league_draft_value   ← `snapshot.draft_picks` (what the player actually cost
 *                          in THIS league's draft)
 *   owner_draft_anchor   ← `snapshot.draft_picks` (which manager drafted them,
 *                          and where) — lineage only; consumed by Checkpoint C
 *
 * The PRIMARY normalized market value comes from the provider benchmark
 * (in-season, league scoring). ADP consensus and league draft cost are
 * preseason point-in-time signals: in-season they are STALE, so they contribute
 * only to cross-source dispersion (which lowers market confidence), never to
 * the primary value. Missing ⇒ absent, never 0.
 */

import { buildMarketConsensus } from "@/lib/draft/market";
import type { CanonicalPlayer, CanonicalDraftPick } from "@/lib/canonical/schema";
import type { WeeklyProjectionBatch, WeeklyReplacement } from "@/lib/weekly/schema";
import { weeklyVOR } from "@/lib/weekly/replacement";
import { medianAbsoluteDeviation } from "../normalize";
import type { CompetitiveTradeConfig } from "../config";
import type {
  MarketLineage,
  MarketReadiness,
  MarketSourceRecord,
  ValueConfidence,
} from "../schema";

const NFL_REGULAR_WEEKS = 18;

export type PprMode = "PPR" | "HALF_PPR" | "STANDARD" | "UNKNOWN";

export interface PlayerMarketSnapshot {
  canonical_player_id: string;
  position: string;
  /** primary normalized-market raw value: Sleeper ROS points → weekly VOR, league frontier. */
  primary_raw: number | null;
  primary_basis: "ros_weekly_vor" | "unavailable";
  readiness: MarketReadiness;
  /** ceiling this snapshot places on market-value confidence (readiness + dispersion + scoring). */
  confidence_ceiling: ValueConfidence;
  scoring_compatible: boolean;
  /** RI↔Sleeper disagreement already computed upstream — corroboration signal for the edge. */
  corroborating_disagreement: { pct: number; direction: string } | null;
  lineage: MarketLineage;
}

export interface BuildMarketSnapshotInput {
  projections: WeeklyProjectionBatch;
  replacement: WeeklyReplacement;
  players_by_id: Map<string, CanonicalPlayer>;
  draft_picks: CanonicalDraftPick[];
  manager_slug_by_id: Map<string, string>;
  /** Deterministic freshness reference — use `snapshot.captured_at`. */
  as_of_iso: string;
  remaining_weeks: number;
  ppr_mode: PprMode;
  config: CompetitiveTradeConfig;
  /** canonical player ids to build a snapshot for (the league universe). */
  universe: string[];
}

const READINESS_RANK: Record<MarketReadiness, number> = {
  CURRENT: 3,
  PARTIAL: 2,
  STALE: 1,
  UNAVAILABLE: 0,
};

function worseReadiness(a: MarketReadiness, b: MarketReadiness): MarketReadiness {
  return READINESS_RANK[a] <= READINESS_RANK[b] ? a : b;
}

/** overall draft pick → positional rank, from a set of (id → overall pick) at one position. */
function positionalRankFromPicks(
  target: string,
  position: string,
  picksByPlayer: Map<string, { pick: number; position: string }>,
): number | null {
  const same = [...picksByPlayer.entries()]
    .filter(([, v]) => v.position === position && Number.isFinite(v.pick))
    .sort((a, b) => a[1].pick - b[1].pick);
  const idx = same.findIndex(([id]) => id === target);
  return idx >= 0 ? idx + 1 : null;
}

export function buildTradeMarketSnapshot(input: BuildMarketSnapshotInput): Map<string, PlayerMarketSnapshot> {
  const {
    projections,
    replacement,
    players_by_id,
    draft_picks,
    manager_slug_by_id,
    as_of_iso,
    remaining_weeks,
    ppr_mode,
    config,
    universe,
  } = input;

  const consensus = buildMarketConsensus({ referenceDate: as_of_iso });

  // draft-market implied positional ranks (from consensus expected_pick)
  const consensusPickByPlayer = new Map<string, { pick: number; position: string }>();
  for (const [sleeperId, row] of consensus.by_player) {
    if (row.position) consensusPickByPlayer.set(sleeperId, { pick: row.expected_pick, position: row.position });
  }

  // league draft picks: overall pick + drafting manager, keyed by canonical player id
  const leaguePickByPlayer = new Map<string, { pick: number; position: string; manager_id: string | null; round: number }>();
  for (const dp of draft_picks) {
    if (!dp.canonical_player_id) continue;
    const p = players_by_id.get(dp.canonical_player_id);
    const pos = p?.position ?? "UNKNOWN";
    leaguePickByPlayer.set(dp.canonical_player_id, {
      pick: dp.pick_number,
      position: pos,
      manager_id: dp.canonical_manager_id,
      round: dp.round,
    });
  }

  // ADP consensus is Half-PPR/12-team; a receiving-points mismatch means its
  // absolute value is not this league's — but its RANK is scoring-robust enough
  // to use for dispersion. Flag the mismatch honestly.
  const adpScoringCompatible = ppr_mode === "HALF_PPR" || ppr_mode === "UNKNOWN";

  const out = new Map<string, PlayerMarketSnapshot>();

  for (const cid of universe) {
    const player = players_by_id.get(cid);
    const wp = projections.by_player.get(cid);
    const position = player?.position ?? wp?.position ?? "UNKNOWN";
    const sleeperId = player?.identifiers.sleeper_id ?? null;

    const sources: MarketSourceRecord[] = [];

    // ---- provider benchmark (primary) --------------------------------------
    const ros = wp?.ros ?? null;
    let primaryRaw: number | null = null;
    let primaryBasis: PlayerMarketSnapshot["primary_basis"] = "unavailable";
    let benchmarkReadiness: MarketReadiness = "UNAVAILABLE";

    const rosPoints = ros?.points ?? wp?.rest_of_season_points ?? null;
    const seasonPoints = ros?.external_season_points ?? null;
    let weeklyMarketPoints: number | null = null;
    let weeklyBasisNote = "";
    if (rosPoints != null && remaining_weeks > 0) {
      weeklyMarketPoints = rosPoints / remaining_weeks;
      weeklyBasisNote = `Sleeper ROS ${round2(rosPoints)} pts ÷ ${remaining_weeks} remaining wks`;
    } else if (seasonPoints != null) {
      weeklyMarketPoints = seasonPoints / NFL_REGULAR_WEEKS;
      weeklyBasisNote = `Sleeper season ${round2(seasonPoints)} pts ÷ ${NFL_REGULAR_WEEKS} (ROS unavailable — season proxy)`;
    }

    if (weeklyMarketPoints != null) {
      const v = weeklyVOR(cid, position, round2(weeklyMarketPoints), replacement);
      if (v.vor != null) {
        primaryRaw = v.vor;
        primaryBasis = "ros_weekly_vor";
      }
      benchmarkReadiness =
        projections.status === "READY" && rosPoints != null
          ? "CURRENT"
          : projections.status === "PROJECTIONS_PARTIAL" || (rosPoints == null && seasonPoints != null)
            ? "PARTIAL"
            : "STALE";
      sources.push({
        source: ros?.source ?? projections.source ?? "sleeper_projection",
        source_type: "provider_benchmark",
        as_of: as_of_iso,
        scoring_format: "league_scoring",
        readiness: benchmarkReadiness,
        raw_value: round2(weeklyMarketPoints),
        raw_unit: "weekly_points",
        implied_position_rank: ros?.ri_position_rank ?? null, // NOTE: this is RI's rank; market rank comes from normalization
        notes: [weeklyBasisNote],
      });
    } else {
      sources.push({
        source: "sleeper_projection",
        source_type: "provider_benchmark",
        as_of: as_of_iso,
        scoring_format: "league_scoring",
        readiness: "UNAVAILABLE",
        raw_value: null,
        raw_unit: null,
        implied_position_rank: null,
        notes: ["no Sleeper ROS or season projection for this player"],
      });
    }

    // ---- draft_market (ADP consensus) ------------------------------------
    const cRow = sleeperId ? consensus.by_player.get(sleeperId) ?? null : null;
    if (cRow) {
      const consensusStale = isStale(cRow.as_of, as_of_iso, config.stale_after_days);
      const impliedRank = sleeperId ? positionalRankFromPicks(sleeperId, position, consensusPickByPlayer) : null;
      sources.push({
        source: `adp_consensus (${consensus.version})`,
        source_type: "draft_market",
        as_of: cRow.as_of ?? consensus.as_of_reference,
        scoring_format: "half_ppr_12team",
        readiness: consensusStale ? "STALE" : cRow.confidence === "NONE" ? "UNAVAILABLE" : "PARTIAL",
        raw_value: cRow.expected_pick,
        raw_unit: "overall_pick",
        implied_position_rank: impliedRank,
        notes: [
          `expected overall pick ${round1(cRow.expected_pick)} (dispersion ${round1(cRow.dispersion)}, ${cRow.source_count} sources)`,
          ...(adpScoringCompatible ? [] : [`league scoring is ${ppr_mode} — ADP is half-PPR; used for rank only`]),
          ...(consensusStale ? ["preseason ADP — STALE in-season, contributes to dispersion only"] : []),
        ],
      });
    }

    // ---- league_draft_value + owner_draft_anchor -----------------------
    const lp = leaguePickByPlayer.get(cid);
    if (lp) {
      const impliedRank = positionalRankFromPicks(cid, position, new Map([...leaguePickByPlayer].map(([k, v]) => [k, { pick: v.pick, position: v.position }])));
      const draftStale = isStale(as_of_iso.slice(0, 4) + "-09-01", as_of_iso, config.stale_after_days);
      sources.push({
        source: "this_league_draft",
        source_type: "league_draft_value",
        as_of: `${as_of_iso.slice(0, 4)}-preseason`,
        scoring_format: "league_scoring",
        readiness: draftStale ? "STALE" : "PARTIAL",
        raw_value: lp.pick,
        raw_unit: "overall_pick",
        implied_position_rank: impliedRank,
        notes: [`drafted at overall pick ${lp.pick} (round ${lp.round})`],
      });
      sources.push({
        source: "this_league_draft",
        source_type: "owner_draft_anchor",
        as_of: `${as_of_iso.slice(0, 4)}-preseason`,
        scoring_format: null,
        readiness: "PARTIAL",
        raw_value: lp.round,
        raw_unit: null,
        implied_position_rank: null,
        notes: [
          lp.manager_id
            ? `drafted by ${manager_slug_by_id.get(lp.manager_id) ?? lp.manager_id} (round ${lp.round}, overall ${lp.pick}) — feeds owner perception (Checkpoint C)`
            : `drafted (round ${lp.round}, overall ${lp.pick}); drafting manager unresolved`,
        ],
      });
    }

    // ---- dispersion across sources that produced a usable positional rank --
    const rankBearingTypes = new Set(["draft_market", "league_draft_value"]);
    const impliedRanks = sources
      .filter((s) => rankBearingTypes.has(s.source_type) && s.implied_position_rank != null)
      .map((s) => s.implied_position_rank as number);
    const dispersion = medianAbsoluteDeviation(impliedRanks);

    const usableSourceCount = sources.filter(
      (s) => s.readiness !== "UNAVAILABLE" && (s.raw_value != null || s.source_type === "owner_draft_anchor"),
    ).length;

    const worst = sources.reduce<MarketReadiness>(
      (acc, s) => (s.source_type === "owner_draft_anchor" ? acc : worseReadiness(acc, s.readiness)),
      "CURRENT",
    );
    // overall market readiness is driven by the PRIMARY (benchmark) source
    const readiness = primaryBasis === "unavailable" ? "UNAVAILABLE" : benchmarkReadiness;

    // confidence ceiling: start from readiness, knock down on dispersion / scoring
    let ceiling = config.readiness_confidence_ceiling[readiness];
    const reasonsForCeiling: string[] = [];
    if (dispersion >= config.market_dispersion_downgrade_at) {
      ceiling = downgrade(ceiling);
      reasonsForCeiling.push(`cross-source rank dispersion ${round1(dispersion)} ≥ ${config.market_dispersion_downgrade_at}`);
    }
    if (!adpScoringCompatible) reasonsForCeiling.push(`ADP source scoring (${ppr_mode}) differs — rank-only use`);
    if (reasonsForCeiling.length) {
      sources.push({
        source: "market_confidence_ceiling",
        source_type: "provider_benchmark",
        as_of: as_of_iso,
        scoring_format: null,
        readiness,
        raw_value: null,
        raw_unit: null,
        implied_position_rank: null,
        notes: reasonsForCeiling,
      });
    }

    const lineage: MarketLineage = {
      sources,
      primary_source_type: primaryBasis === "unavailable" ? null : "provider_benchmark",
      usable_source_count: usableSourceCount,
      dispersion,
      worst_readiness: worst,
      scoring_normalization:
        "provider benchmark taken directly in league scoring; ADP consensus (half-PPR) used for implied rank / dispersion only, never blended into the primary value",
    };

    out.set(cid, {
      canonical_player_id: cid,
      position,
      primary_raw: primaryRaw,
      primary_basis: primaryBasis,
      readiness,
      confidence_ceiling: ceiling,
      scoring_compatible: true, // provider benchmark IS in league scoring
      corroborating_disagreement:
        ros?.disagreement_pct != null
          ? { pct: ros.disagreement_pct, direction: ros.disagreement_direction }
          : null,
      lineage,
    });
  }

  return out;
}

function isStale(dataIso: string | null, refIso: string, staleDays: number): boolean {
  if (!dataIso) return true;
  const a = new Date(dataIso).getTime();
  const b = new Date(refIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return Math.abs(b - a) / 86_400_000 > staleDays;
}

const CONF_ORDER: ValueConfidence[] = ["HIGH", "MEDIUM", "LOW", "VERY_LOW"];
function downgrade(c: ValueConfidence): ValueConfidence {
  const i = CONF_ORDER.indexOf(c);
  return CONF_ORDER[Math.min(CONF_ORDER.length - 1, i + 1)]!;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
