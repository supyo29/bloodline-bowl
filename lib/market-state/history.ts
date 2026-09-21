/**
 * Phase 4.5 — market-state HISTORY. Decision: store immutable, content-addressed, COMPACT snapshots going forward (never backfill).
 *
 * Why: a capture record preserves the candidate set Waiver 2.0 actually evaluated, but not who else was available, who was inside a waiver
 * window, who was unknown, or the league's rules at that moment. Those are exactly the facts a future evaluation needs and that a provider
 * cannot reconstruct afterwards. Only a snapshot taken AT the time is TRUE_AS_OF; anything rebuilt later from transactions is at best
 * RETROSPECTIVE_ONLY, and the classifier below says so.
 *
 * The artifact excludes every volatile field (request id, source snapshot id, read timestamps, lock progression, injury designations) so an
 * unchanged market re-observed later is DUPLICATE_IDENTICAL, not a new row. FAAB/priority are inside the artifact (decision-relevant), so a
 * winning claim that changes budgets writes a new artifact under the SAME market_content_id.
 */
import type { HistoryClass, LeagueAcquisitionRules, MarketSnapshot, RosterSlotKind } from "./contract";
import { hashOf } from "./hash";

export const COMPACT_MARKET_FORMAT = 1;
export interface CompactMarketSnapshot {
  format: typeof COMPACT_MARKET_FORMAT; market_state_version: string; artifact_id: string; market_content_id: string; acquisition_context_id: string;
  league_slug: string; season: number; week: number; history_class: HistoryClass;
  identities: { ownership_id: string; universe_id: string; transactions_id: string; rules_id: string; scoring_fingerprint: string | null };
  rules: LeagueAcquisitionRules; readiness: { status: string; blocks: string[]; limitations: string[] };
  sources: Record<string, { status: string; source_class: string }>;
  ownership: Array<[string, string, RosterSlotKind | null]>; available: Array<[string, string | null, string | null]>; waivers: Array<[string, string]>; unknown: Array<[string, string | null]>;
  ineligible_counts: Record<string, number>; acquisition_teams: Array<[string, number | null, number | null, number]>;
  /** Metadata only: when THIS store first observed the artifact. Not part of the artifact identity. */
  observed_at: string;
}

const body = (c: Omit<CompactMarketSnapshot, "artifact_id" | "observed_at">) => c;
export function compactMarketSnapshot(s: MarketSnapshot): CompactMarketSnapshot {
  const b: Omit<CompactMarketSnapshot, "artifact_id" | "observed_at"> = {
    format: COMPACT_MARKET_FORMAT, market_state_version: s.market_state_version, market_content_id: s.identities.market_content_id, acquisition_context_id: s.acquisition.context_id,
    league_slug: s.league_slug, season: s.season, week: s.week, history_class: s.history_class,
    identities: { ownership_id: s.identities.ownership_id, universe_id: s.identities.universe_id, transactions_id: s.identities.transactions_id, rules_id: s.identities.rules_id, scoring_fingerprint: s.identities.scoring_fingerprint },
    rules: s.acquisition.rules, readiness: { status: s.readiness.status, blocks: [...s.readiness.blocks], limitations: [...s.readiness.limitations] },
    sources: Object.fromEntries(Object.entries(s.sources).map(([k, v]) => [k, { status: v.status, source_class: v.source_class }])),
    ownership: s.players.filter((p) => p.status === "ROSTERED").map((p) => [p.player_key, p.owner_team_id!, null]),
    available: s.players.filter((p) => p.status === "AVAILABLE_FREE_AGENT").map((p) => [p.player_key, p.position, p.team]),
    waivers: s.players.filter((p) => p.status === "ON_WAIVERS").map((p) => [p.player_key, p.waiver_window!.dropped_at]),
    unknown: s.players.filter((p) => p.status === "UNKNOWN_AVAILABILITY" || p.status === "SOURCE_UNAVAILABLE").map((p) => [p.player_key, p.reason as string | null]),
    ineligible_counts: s.ineligible_counts, acquisition_teams: s.acquisition.teams.map((t) => [t.team_id, t.faab_remaining, t.waiver_priority, t.roster_size]),
  };
  return { ...b, artifact_id: `mktsnap:${hashOf(body(b), 20)}`, observed_at: s.as_of };
}

export function validateCompactSnapshot(c: CompactMarketSnapshot): string[] {
  const e: string[] = []; const { artifact_id, observed_at, ...rest } = c; void observed_at;
  if (c.format !== COMPACT_MARKET_FORMAT) e.push("unknown compact format");
  if (artifact_id !== `mktsnap:${hashOf(rest, 20)}`) e.push("artifact_id does not match the content (tampered or malformed)");
  if (c.history_class !== "TRUE_AS_OF") e.push(`only TRUE_AS_OF snapshots are stored (got ${c.history_class})`);
  if (c.readiness.status === "NOT_READY" || c.readiness.blocks.length) e.push("a blocked market is not stored as history");
  if (!c.market_content_id.startsWith("mkt:")) e.push("missing market content id");
  const keys = [...c.ownership.map((x) => x[0]), ...c.available.map((x) => x[0]), ...c.waivers.map((x) => x[0]), ...c.unknown.map((x) => x[0])];
  if (new Set(keys).size !== keys.length) e.push("a player appears in more than one state (AVAILABLE+OWNED conflict)");
  return e;
}

/** How trustworthy a past market state is, from what was actually preserved. Sleeper preserves none of the first two, so only our own snapshots are TRUE_AS_OF. */
export function classifyHistoricalMarket(f: { immutable_snapshot_at_the_time: boolean; roster_and_universe_archive_at_the_time: boolean; transaction_chronology: boolean }): HistoryClass {
  if (f.immutable_snapshot_at_the_time) return "TRUE_AS_OF";
  if (f.roster_and_universe_archive_at_the_time && f.transaction_chronology) return "RECONSTRUCTED";
  if (f.transaction_chronology) return "RETROSPECTIVE_ONLY";
  return "UNSAFE";
}

export type MarketWriteStatus = "INSERTED" | "DUPLICATE_IDENTICAL" | "REFUSED" | "ERROR";
export interface MarketWriteResult { status: MarketWriteStatus; reason?: string; store_kind: string; durable: boolean }
export interface MarketSnapshotStore { readonly kind: string; readonly durable: boolean; record(c: CompactMarketSnapshot): Promise<MarketWriteResult> }
export class MemoryMarketSnapshotStore implements MarketSnapshotStore {
  readonly kind = "memory"; readonly durable = false; readonly rows = new Map<string, CompactMarketSnapshot>();
  async record(c: CompactMarketSnapshot): Promise<MarketWriteResult> {
    const base = { store_kind: this.kind, durable: false }; const errs = validateCompactSnapshot(c); if (errs.length) return { ...base, status: "REFUSED", reason: errs.join("; ") };
    if (this.rows.has(c.artifact_id)) return { ...base, status: "DUPLICATE_IDENTICAL" };
    this.rows.set(c.artifact_id, JSON.parse(JSON.stringify(c))); return { ...base, status: "INSERTED" };
  }
}
