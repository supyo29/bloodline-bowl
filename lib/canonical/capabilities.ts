/**
 * Capability + materiality model for a candidate / published snapshot.
 *
 * Two orthogonal ideas the rest of the phase depends on:
 *
 *   SNAPSHOT INTEGRITY   — is the published league state internally consistent
 *                          and safe to treat as the current reality?
 *   CAPABILITY COMPLETENESS
 *                        — for each analytical surface, are ALL of its required
 *                          inputs present, so it may advertise itself as
 *                          HEALTHY / CURRENT?
 *
 * A snapshot can be `CERTIFIED` for integrity while an optional capability is
 * `DEGRADED` (history persistence down) or `UNAVAILABLE` (free-agent pool not
 * materialized). That is far more useful than "perfect or unusable".
 *
 * The hard rule, encoded here once so routes never re-invent it:
 *   No capability may report HEALTHY if one of its REQUIRED inputs is missing.
 *   A warning is tolerated for *publication* only when it is proven NON-MATERIAL
 *   to snapshot integrity AND to every capability still reported HEALTHY.
 *
 * Pure. No I/O.
 */

import type {
  CanonicalLeagueSnapshot,
  CanonicalPlayer,
  CanonicalWarning,
} from "./schema";

export type CapabilityName =
  | "roster_state"
  | "ownership"
  | "standings"
  | "matchups"
  | "transactions"
  | "history_persistence"
  | "free_agent_pool"
  | "draft_availability"
  | "player_identity";

export type CapabilityStatus = "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
export type SnapshotIntegrity = "CERTIFIED" | "REJECTED";

export interface CapabilityAssessment {
  status: CapabilityStatus;
  reasons: string[];
  /** Named required inputs that are absent/incomplete. */
  missing_inputs: string[];
}

export interface MaterialUnresolvedRef {
  canonical_player_id: string;
  provider_player_id: string | null;
  observed_name: string | null;
  observed_position: string | null;
  /** Which current-state surfaces reference this unresolved identity. */
  surfaces: string[];
}

export interface CapabilityReport {
  snapshot_integrity: SnapshotIntegrity;
  /** Why integrity is REJECTED (structural, discrepancy, eligibility, material id). */
  integrity_failures: string[];
  capabilities: Record<CapabilityName, CapabilityAssessment>;
  /** Unresolved identities that DO touch current actionable state — always blocking. */
  material_unresolved: MaterialUnresolvedRef[];
  /** Unresolved identities that touch nothing actionable — tolerated, still reported. */
  benign_unresolved_count: number;
  /** Rough bucketing of the benign ones for diagnostics. */
  unresolved_categories: Record<string, number>;
}

export interface ExternalFindings {
  /** From `reconcile`: cross-surface `certify()` disagreements. */
  discrepancies?: unknown[];
  /** From `reconcile`: referential-integrity problems. */
  structural?: string[];
}

/** Provider states that are never eligible to be published as "current". */
const NON_PUBLISHABLE_STATUSES = new Set([
  "PROVIDER_ERROR",
  "AUTH_REQUIRED",
  "NOT_CONFIGURED",
  "DEGRADED",
]);

/**
 * The ONLY warning codes whose presence does not, by itself, block publication —
 * and then only when proven non-material (see materiality analysis below). Each
 * still DEGRADES or marks UNAVAILABLE its specific capability. Every other
 * warning code — known or unknown — makes integrity REJECTED (fail closed).
 *
 *   unresolved_player_identities   → tolerated iff no unresolved id touches
 *                                    current actionable state
 *   HISTORY_PERSISTENCE_UNAVAILABLE→ history capability DEGRADED; current state fine
 *   free_agent_pool_not_materialized→ free_agent_pool UNAVAILABLE; snapshot fine
 *   week_transactions_unavailable  → transactions DEGRADED; roster truth still certified
 *
 * `player_database_unavailable` is deliberately NOT here: without the player DB,
 * rosters are id-only stubs and roster/lineup/ownership truth is compromised —
 * that is a core-input outage, not an optional-capability gap.
 */
const PUBLISH_TOLERATED_WARNINGS = new Set([
  "unresolved_player_identities",
  "HISTORY_PERSISTENCE_UNAVAILABLE",
  "free_agent_pool_not_materialized",
  "week_transactions_unavailable",
]);

function idsOnSurface(snap: CanonicalLeagueSnapshot): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const mark = (id: string | null | undefined, surface: string) => {
    if (!id) return;
    const list = out.get(id) ?? [];
    if (!list.includes(surface)) list.push(surface);
    out.set(id, list);
  };
  for (const r of snap.rosters) {
    for (const p of r.starters) mark(p, "starting_lineup");
    for (const p of r.bench) mark(p, "bench");
    for (const p of r.ir) mark(p, "ir");
    for (const p of r.taxi) mark(p, "taxi");
    for (const p of r.all_players) mark(p, "roster");
  }
  for (const m of snap.matchups) {
    for (const s of m.sides) {
      for (const p of s.starters) mark(p, "matchup_starters");
      for (const p of s.bench) mark(p, "matchup_bench");
    }
  }
  for (const t of snap.recent_transactions) {
    for (const mv of t.players_added) mark(mv.canonical_player_id, "transaction_add");
    for (const mv of t.players_dropped) mark(mv.canonical_player_id, "transaction_drop");
    for (const leg of t.trade_legs) for (const p of leg.received_player_ids) mark(p, "trade");
  }
  for (const pick of snap.draft_picks) mark(pick.canonical_player_id, "draft_pick");
  for (const ap of snap.waiver_state?.players ?? []) mark(ap.canonical_player_id, "availability_pool");
  return out;
}

function categorize(p: CanonicalPlayer): string {
  if (p.is_team_defense) return "team_defense";
  const pos = (p.position ?? "").toUpperCase();
  if (!pos || pos === "UNKNOWN") return "no_position";
  if (["QB", "RB", "WR", "TE", "K", "DEF"].includes(pos)) return `offense_${pos}`;
  return "other";
}

function warningCodes(warnings: CanonicalWarning[]): Set<string> {
  return new Set(warnings.map((w) => w.code));
}

export function assessCapabilities(
  snap: CanonicalLeagueSnapshot,
  findings: ExternalFindings = {},
): CapabilityReport {
  const codes = warningCodes(snap.warnings);
  const surfaceIndex = idsOnSurface(snap);

  // --- unresolved-identity materiality ------------------------------------
  const material: MaterialUnresolvedRef[] = [];
  let benign = 0;
  const categories: Record<string, number> = {};
  for (const p of snap.players) {
    if (p.resolution.method !== "unresolved") continue;
    const surfaces = surfaceIndex.get(p.canonical_player_id) ?? [];
    // "roster" alone (dedup bucket) plus any of these ⇒ material.
    const actionable = surfaces.filter((s) => s !== "roster");
    const touchesCurrentRoster = surfaces.includes("roster");
    if (actionable.length > 0 || touchesCurrentRoster) {
      material.push({
        canonical_player_id: p.canonical_player_id,
        provider_player_id: p.identifiers.sleeper_id ?? null,
        observed_name: p.full_name || null,
        observed_position: p.position ?? null,
        surfaces,
      });
    } else {
      benign += 1;
      const c = categorize(p);
      categories[c] = (categories[c] ?? 0) + 1;
    }
  }

  // --- integrity ---------------------------------------------------------
  const integrityFailures: string[] = [];
  if ((findings.structural?.length ?? 0) > 0) {
    integrityFailures.push(...(findings.structural ?? []).map((s) => `structural: ${s}`));
  }
  if ((findings.discrepancies?.length ?? 0) > 0) {
    integrityFailures.push(`${findings.discrepancies!.length} cross-surface discrepancy(ies)`);
  }
  if (NON_PUBLISHABLE_STATUSES.has(snap.live_provider_status)) {
    integrityFailures.push(`live_provider_status=${snap.live_provider_status}`);
  }
  if (snap.teams.length === 0) integrityFailures.push("candidate has no teams");
  for (const w of snap.warnings) {
    if (!PUBLISH_TOLERATED_WARNINGS.has(w.code)) {
      integrityFailures.push(`publication-blocking warning: ${w.code}`);
    }
  }
  for (const m of material) {
    integrityFailures.push(
      `material unresolved identity ${m.provider_player_id ?? m.canonical_player_id} on ${m.surfaces.join("/")}`,
    );
  }

  const integrity: SnapshotIntegrity =
    integrityFailures.length === 0 ? "CERTIFIED" : "REJECTED";

  // --- per-capability --------------------------------------------------
  const cap = (
    status: CapabilityStatus,
    reasons: string[] = [],
    missing: string[] = [],
  ): CapabilityAssessment => ({ status, reasons, missing_inputs: missing });

  const providerBroken = NON_PUBLISHABLE_STATUSES.has(snap.live_provider_status);
  const hasRosters = snap.rosters.length > 0;
  const materialOn = (surface: string) =>
    material.some((m) => m.surfaces.includes(surface));

  const capabilities: Record<CapabilityName, CapabilityAssessment> = {
    roster_state: providerBroken
      ? cap("UNAVAILABLE", ["provider read failed"], ["provider"])
      : !hasRosters && snap.teams.length > 0
        ? cap("DEGRADED", ["teams present but no roster detail"], ["rosters"])
        : materialOn("roster") || materialOn("starting_lineup") || materialOn("bench")
          ? cap("DEGRADED", ["a rostered player has an unresolved identity"])
          : cap("HEALTHY"),

    ownership: providerBroken
      ? cap("UNAVAILABLE", ["provider read failed"], ["provider"])
      : (findings.structural ?? []).some((s) => s.includes("rostered by both"))
        ? cap("DEGRADED", ["ambiguous player ownership"])
        : materialOn("roster")
          ? cap("DEGRADED", ["ownership depends on an unresolved identity"])
          : cap("HEALTHY"),

    standings:
      snap.standings.length === 0
        ? cap("DEGRADED", ["no standings rows"], ["standings"])
        : snap.standings.length !== snap.teams.length
          ? cap("DEGRADED", ["standings/team count mismatch"])
          : cap("HEALTHY"),

    matchups:
      snap.week > 0 && snap.matchups.length === 0
        ? cap("DEGRADED", ["current week has no matchups"], ["matchups"])
        : materialOn("matchup_starters")
          ? cap("DEGRADED", ["a matchup starter has an unresolved identity"])
          : cap("HEALTHY"),

    transactions: codes.has("week_transactions_unavailable")
      ? cap(
          "DEGRADED",
          [
            "current-week transaction feed incomplete — transaction history / chronology is NOT authoritative; an empty list does NOT imply no transactions occurred",
          ],
          ["week_transactions"],
        )
      : materialOn("transaction_add") || materialOn("transaction_drop") || materialOn("trade")
        ? cap("DEGRADED", ["a transaction references an unresolved identity"])
        : cap("HEALTHY"),

    history_persistence: codes.has("HISTORY_PERSISTENCE_UNAVAILABLE")
      ? cap(
          "DEGRADED",
          ["historical persistence is down — historical lineage/history is NOT authoritative; live current state is unaffected"],
          ["supabase_history"],
        )
      : cap("HEALTHY"),

    free_agent_pool:
      snap.waiver_state == null || codes.has("free_agent_pool_not_materialized")
        ? cap(
            "UNAVAILABLE",
            ["free-agent / waiver pool is not materialized — any waiver/free-agent/pickup surface MUST report unavailable and MUST NOT claim CURRENT/FRESH"],
            ["free_agent_pool"],
          )
        : cap("HEALTHY"),

    draft_availability:
      snap.draft_picks.length === 0
        ? cap("DEGRADED", ["no draft picks in snapshot"], ["draft_picks"])
        : materialOn("draft_pick")
          ? cap("DEGRADED", ["a draft pick references an unresolved identity"])
          : cap("HEALTHY"),

    player_identity: codes.has("player_database_unavailable")
      ? cap("UNAVAILABLE", ["Sleeper player database unavailable"], ["player_db"])
      : material.length > 0
        ? cap("UNAVAILABLE", [`${material.length} unresolved identity(ies) touch current state`])
        : benign > 0
          ? cap("DEGRADED", [`${benign} non-material unresolved identity(ies)`])
          : cap("HEALTHY"),
  };

  return {
    snapshot_integrity: integrity,
    integrity_failures: integrityFailures,
    capabilities,
    material_unresolved: material,
    benign_unresolved_count: benign,
    unresolved_categories: categories,
  };
}

/** Compact one-line summary for logs / reports. */
export function summarizeCapabilities(r: CapabilityReport): string {
  const caps = Object.entries(r.capabilities)
    .filter(([, a]) => a.status !== "HEALTHY")
    .map(([n, a]) => `${n}=${a.status}`)
    .join(",");
  return `integrity=${r.snapshot_integrity}${caps ? ` degraded[${caps}]` : " all-healthy"}${
    r.material_unresolved.length ? ` MATERIAL_UNRESOLVED=${r.material_unresolved.length}` : ""
  }`;
}
