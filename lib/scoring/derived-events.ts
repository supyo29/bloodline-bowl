/**
 * Phase 6 — the ONE owner of derived scoring events.
 *
 * `calculateFantasyPoints` multiplies only the keys PRESENT in a stat line, so a rule whose event is never materialized has no effect no matter
 * how it is cataloged. This module sits between a statistical source and the calculator:
 *
 *   raw statistical line + player position (+ completed-game flag) --> scoring-ready stat line --> calculateFantasyPoints (unchanged)
 *
 * It re-implements NO point arithmetic. It only decides which statistical events exist, under three rules:
 *   1. PROVIDER-FIRST: an event the provider already supplied is never re-derived (one event -> one scoring treatment).
 *   2. NAMESPACE-CORRECT: an individual player's line never carries team-defense keys (`def_kr_yd`, `def_pr_yd`) into league scoring.
 *   3. EXACT-OR-ABSENT: only events whose semantics were verified against real provider data are derived; nothing is guessed.
 *
 * Verified semantics (Sleeper actuals 2025 wk 6/10/14, 1,911 player rows; Sleeper weekly projections 2026 wk 2, 3,305 rows):
 *   - `bonus_rec_te|rb|wr` == `rec` exactly, only on that position (a per-reception premium).
 *   - threshold bonuses are inclusive (`>=`), binary, and tiers stack (a 200-yard game earns both the 100 and 200 flags).
 *   - `bonus_rush_rec_yd_100` = 1 iff rush_yd + rec_yd >= 100 and stacks with the single-stat flags.
 *   - individual returners: `kr_yd` / `pr_yd` in actuals; the weekly PROJECTION feed publishes individual kick-return yards as `def_kr_yd`.
 */

export type StatLine = Record<string, number>;
const OFFENSE = new Set(["QB", "RB", "WR", "TE"]);
const RECEPTION_BONUS: Record<string, string> = { TE: "bonus_rec_te", RB: "bonus_rec_rb", WR: "bonus_rec_wr" };

export interface DerivedEventNote { key: string; action: "DERIVED" | "PROVIDER_KEPT" | "RENAMED" | "DROPPED_TEAM_NAMESPACE"; from?: string; reason: string }
export interface MaterializedLine { stats: StatLine; notes: DerivedEventNote[] }

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Materialize position-dependent and namespace-dependent scoring events for one player line.
 * Pure. Returns the input object untouched (same reference) when nothing applies, so callers can cheaply detect a no-op.
 */
export function materializeScoringEvents(stats: StatLine, opts: { position: string | null | undefined }): MaterializedLine {
  const pos = (opts.position ?? "").toUpperCase(); const notes: DerivedEventNote[] = []; let out: StatLine | null = null;
  const edit = (): StatLine => (out ??= { ...stats });

  // 1) position reception premium: provider-first, derived only when the provider omitted it for that position.
  const bonusKey = RECEPTION_BONUS[pos];
  if (bonusKey && isNum(stats.rec)) {
    if (bonusKey in stats) notes.push({ key: bonusKey, action: "PROVIDER_KEPT", reason: "provider supplied the position reception bonus" });
    else if (stats.rec !== 0) { edit()[bonusKey] = stats.rec; notes.push({ key: bonusKey, action: "DERIVED", from: "rec", reason: `${bonusKey} equals receptions for a ${pos} (verified against provider actuals)` }); }
  }

  // 2) an individual offensive player never carries team-defense return keys into league scoring.
  if (OFFENSE.has(pos)) {
    for (const [teamKey, indKey] of [["def_kr_yd", "kr_yd"], ["def_pr_yd", "pr_yd"]] as const) {
      if (!(teamKey in stats)) continue; const o = edit();
      if (!(indKey in stats) && isNum(stats[teamKey])) { o[indKey] = stats[teamKey]!; notes.push({ key: indKey, action: "RENAMED", from: teamKey, reason: `provider publishes an individual returner's yards under the team-defense key ${teamKey}; scored as ${indKey}` }); }
      delete o[teamKey]; notes.push({ key: teamKey, action: "DROPPED_TEAM_NAMESPACE", reason: `${teamKey} is a team-defense rule and must never price an individual player (avoids double counting with ${indKey})` });
    }
    if ("def_kr_td" in stats) { delete edit().def_kr_td; notes.push({ key: "def_kr_td", action: "DROPPED_TEAM_NAMESPACE", reason: "team-defense key on an individual line; no individual return-TD scoring key is verified, so it is not translated" }); }
  }
  return { stats: out ?? stats, notes };
}

/**
 * EXACT threshold bonuses for a COMPLETED game, for sources that do not already publish the flags. Inclusive `>=`, stacking tiers.
 * NOT wired into the Sleeper historical path: Sleeper's own flags are authoritative there (one live provider anomaly — a 244-yd rusher without
 * `bonus_rush_yd_100` — shows the provider's award, not the yardage, is what its league scoring applied). Provider flags are never overwritten.
 * NEVER call this on a projection: a projected mean is not an observed game (see PROJECTION handling in support-contract.ts).
 */
export function deriveCompletedGameThresholdEvents(stats: StatLine): StatLine {
  const out: StatLine = { ...stats }; const flag = (k: string, cond: boolean) => { if (cond && !(k in out)) out[k] = 1; };
  const py = stats.pass_yd, ry = stats.rush_yd, cy = stats.rec_yd;
  if (isNum(py)) { flag("bonus_pass_yd_300", py >= 300); flag("bonus_pass_yd_400", py >= 400); }
  if (isNum(ry)) { flag("bonus_rush_yd_100", ry >= 100); flag("bonus_rush_yd_200", ry >= 200); }
  if (isNum(cy)) { flag("bonus_rec_yd_100", cy >= 100); flag("bonus_rec_yd_200", cy >= 200); }
  if (isNum(ry) || isNum(cy)) { const comb = (ry ?? 0) + (cy ?? 0); flag("bonus_rush_rec_yd_100", comb >= 100); flag("bonus_rush_rec_yd_200", comb >= 200); }
  return out;
}
