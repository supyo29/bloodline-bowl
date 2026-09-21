/**
 * Phase 7 — player NFL-team MEMBERSHIP evidence, Book-Ready by construction. Identity is not membership: this states which club the player belonged to at a
 * time, at what granularity, on what evidence, and what the sources disagree about. An unresolved membership (ambiguous transition, conflict, no evidence,
 * current-only evidence for a past time) is an UNAVAILABLE block with the reasons — never a team.
 */
import { TEMPORAL_IDENTITY_VERSION, isResolved, type TeamResolution, type OpponentResolution } from "@/lib/temporal-identity/membership";
import { schemeVintageFlag } from "@/lib/temporal-identity/sources";
import { unitFor } from "../units";
import { phaseRef } from "../phase-namespaces";
import type { Component, EvidenceBlock, TemporalIdentity } from "../schema";
import { PHASE7, mk as mkRaw } from "../common";
import { createHash } from "node:crypto";

export const MEMBERSHIP_SURFACE = "temporal-team-membership"; const BUILT_IN = phaseRef("INTELLIGENCE_MODERNIZATION_PHASE", "7");
const cat = (key: string, value: string | number, note?: string): Component => ({ key, value, unit: typeof value === "number" ? unitFor("temporal.count") : unitFor("category"), ...(note ? { note } : {}) });

export interface SourceState { source: string; state: "OK" | "NOT_CONFIGURED" | "ERROR"; detail?: string }
export function teamMembershipEvidence(r: TeamResolution, o: { opponent?: OpponentResolution | null; scheme_as_of_team?: string | null; sources?: SourceState[] } = {}): EvidenceBlock[] {
  const down = (o.sources ?? []).filter((x) => x.state !== "OK"); const srcNote = down.length ? [`TEMPORAL_SOURCE_UNAVAILABLE: ${down.map((d) => `${d.source} ${d.state}${d.detail ? ` (${d.detail})` : ""}`).join("; ")} — evidence from these sources is absent, which is different from evidence of absence`] : []; const code = r.failure_code === "MEMBERSHIP_UNKNOWN" && down.length ? "TEMPORAL_SOURCE_UNAVAILABLE" : r.failure_code;
  const identity = createHash("sha256").update(JSON.stringify([r.gsis_id, r.query, r.status, r.team, r.evidence_ids])).digest("hex").slice(0, 16);
  const temporal: TemporalIdentity = { season: r.query.season, week: r.query.week, through_week: null, as_of: null, generated_at: null, source_cutoff: null, point_kind: r.query.kind === "CURRENT" ? "CURRENT" : "NATIVE_OBSERVATION", as_of_kind: r.query.kind === "CURRENT" ? "CURRENT_SNAPSHOT" : "OBSERVED_FACT", week_state: null, snapshot_id: null, player_team_temporal_identity: PHASE7 };
  const base = { surface: MEMBERSHIP_SURFACE, topic: "player.team_membership", subject: { kind: "PLAYER" as const, id: r.gsis_id }, deployment: { state: "SHARED_DESCRIPTIVE" as const, may_influence_production: false }, temporal,
    freshness: { as_of: null, through_week: null, generated_at: null }, lineage: { surface_version: TEMPORAL_IDENTITY_VERSION, content_identity: `tm:${identity}`, canonical: { policy: r.policy, evidence_ids: r.evidence_ids, temporal_data_version: r.evidence_version, basis: r.basis }, depends_on: [] as EvidenceBlock["lineage"]["depends_on"] },
    source: { built_in: BUILT_IN, source_data: "game-level team observations (player_lab_game_logs 2019-2025; Role participation 2026 wk1) + provider-now + identity-table snapshot, resolved by lib/temporal-identity" },
    predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" as const }, origin: { source_class: "DERIVED_FROM_STATE", analysis_class: "DESCRIPTIVE" as const },
    limitations: ["Membership is not depth chart, roster status, or fantasy ownership; none of those are modeled here.", "Identity is stable across team changes (GSIS / provider id); only membership varies with time."] };
  const out: EvidenceBlock[] = []; const resolved = isResolved(r.status) && r.team != null;
  const cands: Component[] = r.candidates.map((c) => cat(`candidate.${c.team ?? "no_team"}`, c.sources.join("+"), `granularity ${c.granularity}${c.weeks.length ? `; weeks ${c.weeks.join(",")}` : ""}`));
  const comps: Component[] = [cat("status", r.status), cat("temporal_data_version", r.evidence_version), cat("basis", r.basis), ...(code ? [cat("failure_code", code)] : []), cat("granularity", r.granularity ?? "NONE"), cat("evidence_class", r.evidence_class ?? "NONE"), ...(r.gap_weeks != null ? [cat("gap_weeks", r.gap_weeks, "missing weeks between the bracketing observations")] : []), ...cands];
  out.push(mkRaw(resolved
    ? { ...base, metric: "membership.team", availability: { state: "AVAILABLE" }, value: r.team!, unit: unitFor("category"), category: { raw: r.team!, normalized: r.team!, mapping_status: "VERIFIED" }, components: comps, limitations: [...base.limitations, ...r.reasons, ...srcNote, ...(r.evidence_class === "SNAPSHOT_STALE_RISK" ? ["identity-table snapshot: may be stale"] : [])] }
    : { ...base, metric: "membership.team", availability: { state: "UNAVAILABLE", reason: `${code ? `${code} / ` : ""}${r.status}: ${r.reasons.join(" ")}` }, origin: { source_class: "UNAVAILABLE", analysis_class: "UNAVAILABLE" }, limitations: [...base.limitations, ...r.reasons, ...srcNote, ...(r.candidates.length ? [`candidates: ${r.candidates.map((c) => `${c.team ?? "no team"} [${c.sources.join("+")}${c.weeks.length ? ` weeks ${c.weeks.join(",")}` : ""}]`).join(" | ")}${r.selected_by_policy ? `; policy names ${r.selected_by_policy} for lineage only` : ""}`] : [])] } as never, ["team"]));
  if (r.candidates.length > 1 || r.status === "CONFLICT" || r.status === "AMBIGUOUS_TRANSITION") out.push(mkRaw({ ...base, metric: "membership.candidates", availability: { state: "AVAILABLE" }, value: r.candidates.length, unit: unitFor("temporal.count"), components: cands, limitations: [...base.limitations, "Disagreement / an unlocated transition is exposed, not resolved away."] }, ["cands"]));
  if (o.opponent && o.opponent.status !== "UNAVAILABLE") out.push(mkRaw({ ...base, metric: "membership.opponent", availability: o.opponent.status === "RESOLVED" ? { state: "AVAILABLE" } : { state: "NOT_APPLICABLE", reason: o.opponent.reasons.join(" ") }, ...(o.opponent.status === "RESOLVED" ? { value: o.opponent.opponent!, unit: unitFor("category"), category: { raw: o.opponent.opponent!, normalized: o.opponent.opponent!, mapping_status: "VERIFIED" as const } } : {}), limitations: [...base.limitations, "Opponent derived from the player's EFFECTIVE team at game time + schedule (never current team + historical week)."] } as never, ["opp"]));
  if (o.scheme_as_of_team !== undefined) { const f = schemeVintageFlag(o.scheme_as_of_team, resolved ? r.team : null); out.push(mkRaw({ ...base, metric: "membership.scheme_window_vintage", availability: { state: "AVAILABLE" }, value: f, unit: unitFor("category"), category: { raw: f, normalized: f, mapping_status: "VERIFIED" }, limitations: [...base.limitations, "Player-Scheme's `current_team` window is career rows on the AS-OF team (last PBP game at the 2025 week-18 cutoff), not necessarily the current club."] }, ["scheme"])); }
  return out;
}
