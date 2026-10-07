/**
 * W1.P3 waiver/drop scenarios. Uses only long-standing public APIs so the SAME scenarios run on a clean W1.P2 checkout (68fc482) to
 * capture the baseline behavior, and on W1.P3. Every roster is full unless stated (so a real drop is required).
 *
 * Slots: QB RB RB WR WR TE FLEX K DEF. "A" is the subject player; "B" is the fringe bench player the engine SHOULD drop when A has real
 * hold value.
 */

import { buildWaiverRecommendations } from "../../lib/weekly/waivers";
import type { CanonicalPosition } from "../../lib/canonical/schema";
import type { WeeklyProjection, WeeklyTeamContext } from "../../lib/weekly/schema";
import { player, proj, roster, weeklyContext } from "./weekly";

export interface Sub {
  id: string;
  pos: CanonicalPosition;
  pts: number | null;
  ros: number | null;
  bye?: boolean;
  injury?: string | null;
  avail?: number;
  status?: WeeklyProjection["projection_status"];
  name?: string;
}

const BASE_STARTERS: Sub[] = [
  { id: "qb1", pos: "QB", pts: 20, ros: 240 },
  { id: "rb1", pos: "RB", pts: 16, ros: 190 },
  { id: "rb2", pos: "RB", pts: 12, ros: 140 },
  { id: "wr1", pos: "WR", pts: 15, ros: 180 },
  { id: "te1", pos: "TE", pts: 10, ros: 120 },
  { id: "f1", pos: "WR", pts: 10, ros: 110 },
  { id: "k1", pos: "K", pts: 8, ros: 90 },
  { id: "def1", pos: "DEF", pts: 7, ros: 85 },
];
const FILL: Sub[] = ["f2", "f3", "f4", "f5", "f6"].map((id) => ({ id, pos: "WR" as const, pts: 8.5, ros: 100 }));

const toProj = (s: Sub): WeeklyProjection =>
  proj(s.id, s.pos, s.bye ? 0 : s.pts, {
    ...(s.bye ? { projection_status: "bye" as const, is_bye: true, expected_availability: 0 } : {}),
    ...(s.status ? { projection_status: s.status } : {}),
    ...(s.injury !== undefined ? { injury_status: s.injury } : {}),
    ...(s.avail !== undefined && !s.bye ? { expected_availability: s.avail } : {}),
    rest_of_season_points: s.ros,
  });

export interface ScenarioOpts {
  /** subject slotted at WR2 (a starter) */
  subject: Sub | null;
  /** extra/replacement bench players; default: fringe B + 5 fillers (full roster) */
  bench?: Sub[];
  /** extra starters overriding BASE (by id) */
  overrides?: Sub[];
  freeAgent?: { pos: CanonicalPosition; pts: number; ros: number } | null;
  /** drop one bench filler so there is an open active spot */
  openSpot?: boolean;
}

export function scenarioCtx(o: ScenarioOpts): WeeklyTeamContext {
  const over = new Map((o.overrides ?? []).map((s) => [s.id, s]));
  const starters = BASE_STARTERS.map((s) => over.get(s.id) ?? s);
  const bench = o.bench ?? [{ id: "B", pos: "WR", pts: 6.5, ros: 45, name: "Fringe Bench WR" }, ...FILL];
  const trimmed = o.openSpot ? bench.slice(0, bench.length - 2) : bench;
  const subj = o.subject ? [o.subject] : [];
  const all = [...starters.slice(0, 4), ...subj, ...starters.slice(4), ...trimmed];
  const starterIds = ["qb1", "rb1", "rb2", "wr1", ...(o.subject ? [o.subject.id] : ["f2"]), "te1", "f1", "k1", "def1"];
  const benchIds = trimmed.map((b) => b.id).filter((id) => !starterIds.includes(id));
  const players = all.map((s) => player(s.id, s.pos, { name: s.name ?? s.id, injury: s.injury ?? null }));
  const fa = o.freeAgent === undefined ? { pos: "WR" as const, pts: 11, ros: 130 } : o.freeAgent;
  return weeklyContext({
    myRoster: roster("team:test-league:1", starterIds, benchIds),
    players,
    freeAgents: fa ? [player("faWR", fa.pos, { name: "Free Agent" })] : [],
    projections: all.map(toProj),
    faProjections: fa ? [proj("faWR", fa.pos, fa.pts, { rest_of_season_points: fa.ros })] : [],
  });
}

export interface Outcome {
  add: string | null;
  drop: string | null;
  drop_cost: number | null;
  net: number | null;
  starter_impact: number | null;
  n: number;
}

export function outcome(ctx: WeeklyTeamContext): Outcome {
  const r = buildWaiverRecommendations(ctx) as unknown as {
    recommendations: Array<{ add_player_id: string; drop_player_id: string | null; drop_cost: number; net_roster_gain: number; starter_impact: number | null }>;
  };
  const x = r.recommendations[0];
  return { add: x?.add_player_id ?? null, drop: x?.drop_player_id ?? null, drop_cost: x?.drop_cost ?? null, net: x?.net_roster_gain ?? null, starter_impact: x?.starter_impact ?? null, n: r.recommendations.length };
}

const A = (over: Partial<Sub>): Sub => ({ id: "A", pos: "WR", pts: 15, ros: 230, name: "Subject A", ...over });

/** name -> context. The golden before/after table is exactly this list. */
export const SCENARIOS: Record<string, () => WeeklyTeamContext> = {
  "A valuable player on bye": () => scenarioCtx({ subject: A({ bye: true }) }),
  "A-cf same player, bye removed, underlying value kept": () => scenarioCtx({ subject: A({ pts: 13.53 }) }),
  "B marginal bye player (poor forward value)": () => scenarioCtx({ subject: A({ bye: true, ros: 30, pts: 4 }) }),
  "C two bye players (elite + fringe)": () =>
    scenarioCtx({
      subject: A({ bye: true }),
      bench: [{ id: "B", pos: "WR", pts: 0, ros: 35, bye: true, name: "Fringe Bye WR" }, ...FILL.slice(0, 5)],
    }),
  "D entire bench plays, all weak": () =>
    scenarioCtx({ subject: A({ bye: true }), bench: [{ id: "B", pos: "WR", pts: 6, ros: 40, name: "Weak Bench WR" }, ...FILL.map((f) => ({ ...f, pts: 6, ros: 42 }))] }),
  "E open roster spot": () => scenarioCtx({ subject: A({ bye: true }), openSpot: true }),
  "F no useful waiver add": () => scenarioCtx({ subject: A({ bye: true }), freeAgent: { pos: "WR", pts: 2, ros: 10 } }),
  "G injured valuable player (Out, source 24)": () => scenarioCtx({ subject: A({ pts: 24, ros: 230, injury: "Out", avail: 0.03 }) }),
  "H bye + injury designation": () => scenarioCtx({ subject: A({ bye: true, injury: "Questionable" }) }),
  "I known zero projection, not a bye": () => scenarioCtx({ subject: A({ pts: 0, ros: 60 }) }),
  "J missing projection (unknown, not bye)": () => scenarioCtx({ subject: A({ pts: null, ros: 230 }) }),
  "K streaming kicker on bye": () =>
    scenarioCtx({
      subject: null,
      overrides: [{ id: "k1", pos: "K", pts: 8, ros: 90, bye: true, name: "Streamer K" }],
      freeAgent: { pos: "K", pts: 9, ros: 100 },
      bench: [{ id: "B", pos: "WR", pts: 9, ros: 110, name: "Solid Bench WR" }, ...FILL.map((f) => ({ ...f, pts: 9, ros: 110 }))],
    }),
  "L valuable DST on bye": () =>
    scenarioCtx({
      subject: null,
      overrides: [{ id: "def1", pos: "DEF", pts: 7, ros: 230, bye: true, name: "Elite DST" }],
      freeAgent: { pos: "WR", pts: 11, ros: 130 },
    }),
};
