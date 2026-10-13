/**
 * W2.P2 — read-only loader of realized outcomes for G3, from the Projection Calibration Phase 1 ledger view `bridge_calibration_cases_current`
 * (the latest revision of each case: actual fantasy points in the LEAGUE's own scoring, produced by certified calibration code). Nothing here
 * re-scores a stat line; it only reads rows and keeps the ledger's own certification (`evidence_status`) so the evaluator can refuse approximations.
 */
import type { OutcomeRow } from "@/lib/role-shadow/g3";
import type { RoleShadowRecord } from "@/lib/role-shadow/record";
import { SupabaseRest } from "./rest";

const VIEW = "bridge_calibration_cases_current";
const PAGE = 1000;

interface CaseRow {
  league_slug: string; season: number; week: number; canonical_player_id: string; case_id: string; evidence_digest: string;
  actual_fantasy_points: number | string | null; participation_state: string; evidence_status: string; actual_scoring_exactness: string | null;
}

/** Distinct (league, season, week) scopes the stored records cover — the only ledger rows worth reading. */
export const scopesOf = (records: readonly RoleShadowRecord[]): Array<{ league_slug: string; season: number; week: number }> => {
  const m = new Map<string, { league_slug: string; season: number; week: number }>();
  for (const r of records) m.set(`${r.league_slug}|${r.season}|${r.week}`, { league_slug: r.league_slug, season: r.season, week: r.week });
  return [...m.values()].sort((a, b) => (a.league_slug + a.season + a.week < b.league_slug + b.season + b.week ? -1 : 1));
};

export async function loadCalibrationOutcomes(rest: SupabaseRest, records: readonly RoleShadowRecord[]): Promise<OutcomeRow[]> {
  const out: OutcomeRow[] = [];
  for (const s of scopesOf(records)) {
    for (let offset = 0; offset < 100_000; offset += PAGE) {
      const page = await rest.select<CaseRow>(VIEW, {
        select: "league_slug,season,week,canonical_player_id,case_id,evidence_digest,actual_fantasy_points,participation_state,evidence_status,actual_scoring_exactness",
        filter: { league_slug: `eq.${s.league_slug}`, season: `eq.${s.season}`, week: `eq.${s.week}` },
        order: "canonical_player_id.asc,case_id.asc", limit: PAGE, offset,
      });
      for (const r of page) {
        out.push({
          league_slug: r.league_slug, season: Number(r.season), week: Number(r.week), canonical_player_id: r.canonical_player_id,
          actual_fantasy_points: r.actual_fantasy_points == null ? null : Number(r.actual_fantasy_points),
          participation_state: r.participation_state, evidence_status: r.evidence_status, scoring_exactness: r.actual_scoring_exactness, case_ref: `${r.case_id}:${r.evidence_digest}`,
        });
      }
      if (page.length < PAGE) break;
    }
  }
  return out;
}
