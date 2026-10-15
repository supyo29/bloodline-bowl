/**
 * W2.R1 -> main weekly context integration (pure planner; the batch mutation itself stays in lib/weekly/context.ts, which owns the projection batch).
 * Applies the QUALIFIED D/ST component model (exact league scoring) to the current week only. Rules: only QUALIFIED_SHADOW leagues; only the capture week; never a bye
 * (bye current-week stays 0, hold value untouched); a team without a capture row keeps its inherited value (unknown stays unknown); the provider value replaced is recorded by the
 * caller; availability is not re-applied (D/ST has no injury discount); read-only. W2R1_DST_DISABLED=1 is an operational emergency stop. A missing/failed capture NEVER fails the context.
 */
import { KDST_LOADERS } from "./data/prospective";
import { DST_MODEL_VERSION, dstForTeam, type KdstCapture } from "./dst-live";
import { dstQualification, type QualState } from "./qualification";

export interface DstPlan {
  state: QualState; capture_week: number | null; reason: string | null; model_version: string;
  /** the W2.R1 value for a team, or null when the team keeps its inherited value */
  forTeam: (nflTeam: string) => { points: number; floor: number; ceiling: number; sd: number } | null;
}

export async function planQualifiedDst(a: { leagueSlug: string; week: number; capture?: KdstCapture | null; env?: NodeJS.ProcessEnv }): Promise<DstPlan> {
  const q = dstQualification(a.leagueSlug);
  const off = (reason: string): DstPlan => ({ state: q.state, capture_week: null, reason, model_version: DST_MODEL_VERSION, forTeam: () => null });
  if ((a.env ?? process.env).W2R1_DST_DISABLED === "1") return off("W2R1_DST_DISABLED emergency stop");
  if (q.state !== "QUALIFIED_SHADOW") return off(`D/ST state ${q.state}: inherited generic D/ST values are used and labelled (${q.reason})`);
  let cap: KdstCapture | null = a.capture ?? null;
  try { if (!cap) cap = (await KDST_LOADERS[a.week]?.()) ?? null; } catch { cap = null; }
  if (!cap || cap.meta.target_week !== a.week) return off(`no frozen pregame D/ST capture for week ${a.week}: inherited generic D/ST values are used (not W2.R1-qualified)`);
  const c = cap;
  return { state: q.state, capture_week: c.meta.target_week, reason: null, model_version: DST_MODEL_VERSION, forTeam: (team) => {
    const live = dstForTeam(c, a.leagueSlug, team); if ("unavailable" in live) return null;
    const half = 1.2816 * live.uncertainty.sd; const r = (v: number) => Math.round(v * 100) / 100;
    return { points: live.expected_points, floor: r(live.expected_points - half), ceiling: r(live.expected_points + half), sd: live.uncertainty.sd };
  } };
}
