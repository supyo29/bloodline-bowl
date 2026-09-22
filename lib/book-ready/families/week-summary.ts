/**
 * Phase 10 — "week at a glance" evidence, Book-Ready by construction. Reads the SAME canonical per-week NFL
 * completion source Phase 3.5A/Phase 9 use (`lib/canonical/nfl-reality-frontier.ts::buildNflSeasonCompletion`) and
 * exposes, per game, only what that source actually knows: the two teams, whether the game is complete, and its
 * date. It NEVER fabricates a score, a box score, or a "major development" narrative — those require sources this
 * repository does not have (no NFL score/box-score provider is wired anywhere); the Weekly Book must organize what
 * happened, not invent it, so this evidence is deliberately structural (Step 10 of the Phase 10 brief).
 */
import type { NflSeasonCompletion } from "@/lib/canonical/nfl-reality-frontier";
import { unitFor } from "../units";
import { phaseRef } from "../phase-namespaces";
import type { Component, EvidenceBlock, TemporalIdentity } from "../schema";
import { PHASE7, mk as mkRaw } from "../common";

export const WEEK_SUMMARY_SURFACE = "league-week-summary"; export const WEEK_SUMMARY_TOPIC = "league.week_summary";
const BUILT_IN = phaseRef("INTELLIGENCE_MODERNIZATION_PHASE", "10");
const cat = (key: string, value: string | number, note?: string): Component => ({ key, value, unit: typeof value === "number" ? unitFor("audit.count") : unitFor("category"), ...(note ? { note } : {}) });

export function weekSummaryEvidence(completion: NflSeasonCompletion | null, week: number): EvidenceBlock[] {
  const w = completion?.weeks.find((x) => x.week === week) ?? null;
  const temporal: TemporalIdentity = { season: completion?.season ?? null, week, through_week: null, as_of: completion?.as_of ?? null, generated_at: completion?.as_of ?? null, source_cutoff: null, point_kind: "CURRENT", as_of_kind: "CURRENT_SNAPSHOT", week_state: w?.state === "COMPLETE" || w?.state === "PARTIAL" ? w.state : null, snapshot_id: null, player_team_temporal_identity: PHASE7 };
  const base = { surface: WEEK_SUMMARY_SURFACE, topic: WEEK_SUMMARY_TOPIC, subject: { kind: "LEAGUE" as const, id: "nfl-week-summary", league_slug: "nfl-week-summary" }, deployment: { state: "SHARED_DESCRIPTIVE" as const, may_influence_production: false }, temporal,
    freshness: { as_of: completion?.as_of ?? null, through_week: null, generated_at: completion?.as_of ?? null }, lineage: { surface_version: "week-summary-2026.1", content_identity: `w${week}:${w?.completed ?? 0}/${w?.scheduled ?? 0}`, canonical: { source: completion?.source ?? null }, depends_on: [] as EvidenceBlock["lineage"]["depends_on"] },
    source: { built_in: BUILT_IN, source_data: "the same per-week NFL completion source Phase 3.5A/Phase 9 use (Sleeper regular-season schedule; status === 'complete' only counts as finished)" },
    predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" as const }, origin: { source_class: "DERIVED_FROM_STATE", analysis_class: "DESCRIPTIVE" as const },
    limitations: ["No score, box-score or narrative-development source is wired anywhere in this repository — only game participants, week completion state and dates are known. This is deliberate: the Weekly Book organizes evidence, it never manufactures it."] };
  if (!completion || !w) return [mkRaw({ ...base, metric: "week.state", availability: { state: "UNAVAILABLE", reason: !completion ? "NFL schedule/completion source unavailable" : `week ${week} not present in the schedule source` }, origin: { source_class: "UNAVAILABLE", analysis_class: "UNAVAILABLE" } } as never, ["state"])];
  const out: EvidenceBlock[] = [];
  out.push(mkRaw({ ...base, metric: "week.state", availability: { state: "AVAILABLE" }, value: w.state, unit: unitFor("category"), category: { raw: w.state, normalized: w.state, mapping_status: "VERIFIED" },
    components: [cat("scheduled", w.scheduled), cat("completed", w.completed), ...Object.entries(w.by_status).map(([k, v]) => cat(`status.${k}`, v)), cat("earliest_game_date", w.earliest_game_date ?? "unknown"), cat("latest_game_date", w.latest_game_date ?? "unknown")],
    limitations: base.limitations } as never, ["state"]));
  out.push(mkRaw({ ...base, metric: "week.teams", availability: { state: "AVAILABLE" }, value: w.teams.length, unit: unitFor("audit.count"), components: w.teams.map((t) => cat(`team.${t}`, "participating")), limitations: base.limitations } as never, ["teams"]));
  return out;
}
