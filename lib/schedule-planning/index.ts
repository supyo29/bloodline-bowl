/**
 * Phase 7 — Schedule & Forward Planning Intelligence (Scope 3, SHARED_CONTEXT).
 *
 * A shared FORWARD-LOOKING evaluative context: bye exposure, future legal-lineup
 * coverage, weekly projected-lineup vector, future roster-health pressure,
 * regular-season schedule-context vectors, and playoff planning context — derived
 * from the frozen Phase 2 Team-State facts, the production projections, the frozen
 * Phase 6 roster-health primitives, and the full-season NFL schedule.
 *
 * It is NOT a recommendation and is wired into NO trade / waiver / lineup /
 * start-sit / matchup score. Every week-level output separates STRUCTURE
 * confidence (schedule-grounded, HIGH for the full season) from VALUE confidence
 * (projection-driven, degrades with horizon). See docs/TEAM_MANAGEMENT_PHASE_7.md.
 */
export * from "./schema";
export { buildSchedulePlanningContext, type SchedulePlanningOptions } from "./build";
export { planningDelta } from "./delta";
export { loadFullSchedule, type FullSchedule } from "./schedule";
export { buildWeekTimeline, type TimelineInput } from "./evaluate";
