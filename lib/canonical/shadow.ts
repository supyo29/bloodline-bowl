/**
 * Stage C — shadow comparison primitives.
 *
 * Compares the OLD production read path (`buildCanonicalLeagueState`, consumed
 * directly by routes today) against the NEW authoritative path
 * (`getPublishedLeagueSnapshot`, dry-run) — WITHOUT making the new path
 * authoritative and WITHOUT touching the durable pointer.
 *
 * Nothing here fetches. Callers supply already-built snapshots + the source
 * stability markers they observed around the run.
 *
 * Every difference is CLASSIFIED. The Stage C gate is `UNEXPLAINED = 0` for any
 * run where the provider source did not move mid-comparison.
 */

import { certify, factsFromCanonical, type Discrepancy } from "./certification/harness";
import { diffCanonicalSnapshots } from "@/lib/team-state/diff";
import { snapshotLineage } from "./snapshot-lineage";
import { assessCapabilities, type CapabilityReport } from "./capabilities";
import type { CanonicalLeagueSnapshot } from "./schema";

export type ShadowDiffCategory =
  | "EXPECTED_METADATA"
  | "EXPECTED_ORDERING"
  | "SOURCE_MOVED_DURING_RUN"
  | "CORRECTED_IDENTITY"
  | "CORRECTED_STALE_STATE"
  | "KNOWN_OLD_PATH_BUG"
  | "OPTIONAL_CAPABILITY_DIFFERENCE"
  | "UNEXPLAINED";

export const SHADOW_CATEGORIES: ShadowDiffCategory[] = [
  "EXPECTED_METADATA",
  "EXPECTED_ORDERING",
  "SOURCE_MOVED_DURING_RUN",
  "CORRECTED_IDENTITY",
  "CORRECTED_STALE_STATE",
  "KNOWN_OLD_PATH_BUG",
  "OPTIONAL_CAPABILITY_DIFFERENCE",
  "UNEXPLAINED",
];

export interface ShadowDiff {
  domain: string;
  scope: string;
  field: string;
  old_value: unknown;
  new_value: unknown;
  category: ShadowDiffCategory;
  note: string;
}

export type ShadowMode = "DETERMINISTIC_SAME_SOURCE" | "LIVE_SHADOW";

export type ShadowVerdict =
  | "EQUIVALENT"
  | "EQUIVALENT_WITH_DOCUMENTED_DIFFS"
  | "INCONCLUSIVE_SOURCE_MOVED"
  | "UNEXPLAINED_DIFFERENCE";

export interface ShadowComparison {
  league_slug: string;
  mode: ShadowMode;
  old_snapshot_id: string;
  new_snapshot_id: string;
  source_stable: boolean;
  source_start_hash: string;
  source_end_hash: string;
  domains_compared: string[];
  diffs: ShadowDiff[];
  totals: Record<ShadowDiffCategory, number>;
  capability_report: CapabilityReport | null;
  reconcile_ok: boolean;
  verdict: ShadowVerdict;
}

/** Known pre-existing old-path bugs, keyed by a stable signature. Empty for now. */
const KNOWN_OLD_PATH_BUGS: { match: (d: ShadowDiff) => boolean; note: string }[] = [];

function emptyTotals(): Record<ShadowDiffCategory, number> {
  return Object.fromEntries(SHADOW_CATEGORIES.map((c) => [c, 0])) as Record<
    ShadowDiffCategory,
    number
  >;
}

function playerResolutionImproved(
  oldSnap: CanonicalLeagueSnapshot,
  newSnap: CanonicalLeagueSnapshot,
  canonicalPlayerId: string,
): boolean {
  const o = oldSnap.players.find((p) => p.canonical_player_id === canonicalPlayerId);
  const n = newSnap.players.find((p) => p.canonical_player_id === canonicalPlayerId);
  if (!n) return false;
  if (!o) return n.resolution.method !== "unresolved";
  const RANK: Record<string, number> = {
    unresolved: 0,
    name_position: 1,
    name_position_team: 2,
    stable_id: 3,
  };
  return (RANK[n.resolution.method] ?? 0) > (RANK[o.resolution.method] ?? 0);
}

function classify(
  diff: Omit<ShadowDiff, "category" | "note">,
  ctx: { sourceStable: boolean; oldSnap: CanonicalLeagueSnapshot; newSnap: CanonicalLeagueSnapshot },
): ShadowDiff {
  for (const known of KNOWN_OLD_PATH_BUGS) {
    const candidate: ShadowDiff = { ...diff, category: "KNOWN_OLD_PATH_BUG", note: known.note };
    if (known.match(candidate)) return candidate;
  }

  if (!ctx.sourceStable) {
    return {
      ...diff,
      category: "SOURCE_MOVED_DURING_RUN",
      note: "provider content hash changed between the start and end of the comparison window",
    };
  }

  // Identity-domain diffs where the new path resolved a player the old path did not.
  if (
    (diff.domain === "players" || diff.domain === "rosters") &&
    typeof diff.scope === "string" &&
    diff.scope.startsWith("player:") &&
    playerResolutionImproved(ctx.oldSnap, ctx.newSnap, diff.scope.slice("player:".length))
  ) {
    return { ...diff, category: "CORRECTED_IDENTITY", note: "new path resolved a stronger identity" };
  }

  return {
    ...diff,
    category: "UNEXPLAINED",
    note: "same provider source, no known cause — must be diagnosed before Stage D",
  };
}

/**
 * Compare two canonical snapshots produced from (nominally) the same provider
 * source. `mode: DETERMINISTIC_SAME_SOURCE` feeds a frozen bundle through both
 * paths and expects byte-identical semantics. `mode: LIVE_SHADOW` reads the real
 * provider and uses the source-hash markers to decide whether a difference is a
 * regression or just the league moving.
 */
export function compareCanonicalPaths(
  oldSnap: CanonicalLeagueSnapshot,
  newSnap: CanonicalLeagueSnapshot,
  opts: {
    mode: ShadowMode;
    sourceStartHash: string;
    sourceEndHash: string;
    reconcileOk: boolean;
  },
): ShadowComparison {
  const sourceStable = opts.sourceStartHash === opts.sourceEndHash;
  const diffs: ShadowDiff[] = [];
  const ctx = { sourceStable, oldSnap, newSnap };

  // 1. fact-level (records, scoring fingerprint, slots, team identity, player meta)
  const factDiscrepancies: Discrepancy[] = certify(
    factsFromCanonical(oldSnap),
    { ...factsFromCanonical(newSnap), source: "new-path" },
  );
  for (const d of factDiscrepancies) {
    diffs.push(
      classify(
        {
          domain: d.scope.startsWith("team:") ? "standings" : d.scope.startsWith("player:") ? "players" : "league",
          scope: d.scope,
          field: d.field,
          old_value: d.a_value,
          new_value: d.b_value,
        },
        ctx,
      ),
    );
  }

  // 2. ownership / roster-slot / matchup / player-metadata changes
  const structural = diffCanonicalSnapshots(oldSnap, newSnap);
  for (const c of structural.changes) {
    diffs.push(
      classify(
        {
          domain:
            c.type.startsWith("PLAYER_") && c.type.includes("OWNERSHIP")
              ? "ownership"
              : c.type.startsWith("PLAYER_")
                ? "rosters"
                : c.type.startsWith("MATCHUP")
                  ? "matchups"
                  : c.type.startsWith("MANAGER")
                    ? "managers"
                    : "league",
          scope: c.player_id ? `player:${c.player_id}` : (c.canonical_team_id ?? c.type),
          field: c.type,
          old_value: c.before,
          new_value: c.after,
        },
        ctx,
      ),
    );
  }

  // 3. player-set membership (added / removed canonical ids)
  const oldIds = new Set(oldSnap.players.map((p) => p.canonical_player_id));
  const newIds = new Set(newSnap.players.map((p) => p.canonical_player_id));
  for (const id of newIds) {
    if (!oldIds.has(id)) {
      diffs.push(classify({ domain: "players", scope: `player:${id}`, field: "present", old_value: "absent", new_value: "present" }, ctx));
    }
  }
  for (const id of oldIds) {
    if (!newIds.has(id)) {
      diffs.push(classify({ domain: "players", scope: `player:${id}`, field: "present", old_value: "present", new_value: "absent" }, ctx));
    }
  }

  // 4. transaction id set
  const oldTx = new Set(oldSnap.recent_transactions.map((t) => t.canonical_transaction_id));
  const newTx = new Set(newSnap.recent_transactions.map((t) => t.canonical_transaction_id));
  for (const id of newTx) if (!oldTx.has(id)) diffs.push(classify({ domain: "transactions", scope: id, field: "present", old_value: "absent", new_value: "present" }, ctx));
  for (const id of oldTx) if (!newTx.has(id)) diffs.push(classify({ domain: "transactions", scope: id, field: "present", old_value: "present", new_value: "absent" }, ctx));

  const totals = emptyTotals();
  for (const d of diffs) totals[d.category] += 1;

  const unexplained = totals.UNEXPLAINED;
  let verdict: ShadowVerdict;
  if (unexplained > 0) verdict = "UNEXPLAINED_DIFFERENCE";
  else if (!sourceStable && diffs.length > 0) verdict = "INCONCLUSIVE_SOURCE_MOVED";
  else if (diffs.length === 0) verdict = "EQUIVALENT";
  else verdict = "EQUIVALENT_WITH_DOCUMENTED_DIFFS";

  return {
    league_slug: newSnap.league.league_slug,
    mode: opts.mode,
    old_snapshot_id: snapshotLineage(oldSnap).league_snapshot_id,
    new_snapshot_id: snapshotLineage(newSnap).league_snapshot_id,
    source_stable: sourceStable,
    source_start_hash: opts.sourceStartHash,
    source_end_hash: opts.sourceEndHash,
    domains_compared: ["league", "standings", "rosters", "ownership", "managers", "matchups", "players", "transactions"],
    diffs,
    totals,
    capability_report: assessCapabilities(newSnap),
    reconcile_ok: opts.reconcileOk,
    verdict,
  };
}

/**
 * Compare a direct-route surface's `LeagueFacts` (as produced by a Phase 1C
 * extractor) against the canonical published snapshot. Used for the P0
 * contradiction-risk routes. Returns `certify()` discrepancies already split
 * into timing-plausible vs. semantic.
 */
export function compareDirectSurface(
  canonicalSnap: CanonicalLeagueSnapshot,
  directFacts: import("./certification/harness").LeagueFacts,
  opts: { sourceStable: boolean },
): { timing: Discrepancy[]; semantic: Discrepancy[] } {
  const discrepancies = certify(factsFromCanonical(canonicalSnap), directFacts);
  // Points/records drift with live scoring; roster/identity/opponent are structural.
  const TIMING_FIELDS = new Set([
    "points_for",
    "points_against",
    "wins",
    "losses",
    "ties",
    "starter_ids",
    "bench_ids",
  ]);
  const timing: Discrepancy[] = [];
  const semantic: Discrepancy[] = [];
  for (const d of discrepancies) {
    if (!opts.sourceStable && TIMING_FIELDS.has(d.field)) timing.push(d);
    else semantic.push(d);
  }
  return { timing, semantic };
}
