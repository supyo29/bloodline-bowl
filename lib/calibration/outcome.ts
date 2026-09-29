/**
 * Football reality -> league translation. The football outcome (raw provider stats) is league-independent; the
 * fantasy translation reuses the repo's ONE scoring path (`lib/weekly-audit/scoring-actuals.ts` -> Phase 6
 * `materializeScoringEvents` + `scoreWeeklyLine`). No scoring math is re-implemented here.
 */
import { createHash } from "node:crypto";
import { actualPointsFor, type ActualPoints } from "@/lib/weekly-audit/scoring-actuals";
import type { ParticipationState, ScoringExactness } from "./types";

export const K_DST_WARNING_MARKER = "k_dst_uses_sleeper_standard_points";
/** Injury designations that, if known at projection time, make a no-stat-row player INACTIVE rather than DNP. */
export const OUT_INJURY = /^(out|ir|pup|nfi|sus|suspended|inactive|doubtful)$/i;
/** Below this offensive-snap share the player is flagged PLAYED_LOW_SNAP_SHARE. Descriptive evidence flag only — NOT a causal label and NOT a model threshold. */
export const LOW_SNAP_SHARE_THRESHOLD = 0.5;
/** A team's game counts as covered by the stats provider if at least this many of its mapped players have a stat row. */
export const TEAM_STAT_COVERAGE_MIN_ROWS = 8;

export const hasUnmappedStats = (rawScoring: Record<string, number> | null): boolean => !!rawScoring && Object.keys(rawScoring).some((k) => k.startsWith("yahoo_stat_"));

export function scoringExactness(position: string | null, rawScoring: Record<string, number> | null, warnings: readonly string[] = []): ScoringExactness {
  if (position === "K" || position === "DEF" || warnings.some((w) => w.includes(K_DST_WARNING_MARKER))) return "PROVIDER_STANDARD_APPROXIMATION";
  return hasUnmappedStats(rawScoring) ? "LEAGUE_EXACT_WITH_UNMAPPED_STATS" : "LEAGUE_EXACT";
}

export function statsDigest(present: boolean, raw: Record<string, number> | undefined): string {
  const sorted = raw ? Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "number" && Number.isFinite(v)).sort(([a], [b]) => (a < b ? -1 : 1))) : {};
  return createHash("sha256").update(JSON.stringify({ present, sorted })).digest("hex").slice(0, 16);
}

export function classifyParticipation(args: {
  position: string | null; game_status: string; raw: Record<string, number> | undefined; injury_status_at_projection: string | null;
}): { state: ParticipationState; note: string | null } {
  if (/^(postponed|cancel+ed)$/.test(args.game_status)) return { state: "GAME_POSTPONED_OR_CANCELLED", note: "game not played" };
  const { raw, position } = args;
  if (!raw || !Object.keys(raw).length) {
    return OUT_INJURY.test(args.injury_status_at_projection ?? "")
      ? { state: "INACTIVE", note: `no stat row; injury status known at projection time: ${args.injury_status_at_projection}` }
      : { state: "DID_NOT_PLAY", note: "no stat row for a completed game (inactive/DNP/provider gap not distinguishable from stats alone)" };
  }
  if (position === "K" || position === "DEF") return { state: "PLAYED_NORMAL", note: null };
  if (raw.gp === 0) return { state: "DID_NOT_PLAY", note: "provider gp=0" };
  const snaps = raw.off_snp, team = raw.tm_off_snp;
  if (typeof snaps === "number" && typeof team === "number" && team > 0) {
    return snaps / team < LOW_SNAP_SHARE_THRESHOLD
      ? { state: "PLAYED_LOW_SNAP_SHARE", note: `off_snp ${snaps}/${team} < ${LOW_SNAP_SHARE_THRESHOLD}; in-game exit not distinguishable from role` }
      : { state: "PLAYED_NORMAL", note: null };
  }
  return { state: "PLAYED_NORMAL", note: "no snap counts on the stat row; snap share not evaluated" };
}

export interface TranslatedActual extends ActualPoints { exactness: ScoringExactness }
/**
 * `clean` = component-only stats (offense scoring input); `raw` = unstripped provider row (K/DST `pts_std`).
 * `teamCovered`: the provider published stat rows for this player's team, so a missing OFFENSIVE row is a real
 * DNP zero rather than a provider gap. A missing DEF row is never assumed zero.
 */
export function translateActual(args: { position: string | null; clean: Record<string, number> | undefined; raw: Record<string, number> | undefined; rawScoring: Record<string, number>; teamCovered: boolean }): TranslatedActual {
  const pos = args.position ?? "";
  const exactness = scoringExactness(args.position, args.rawScoring);
  if (!args.raw && !args.clean && args.teamCovered && pos !== "DEF") {
    return { basis: "REAL_ZERO_NO_STATS", points: 0, warnings: ["no stat row although the provider covers this team's game: treated as a real DNP zero"], exactness };
  }
  const a = actualPointsFor(pos, args.clean, args.raw, args.rawScoring);
  return { ...a, exactness };
}
