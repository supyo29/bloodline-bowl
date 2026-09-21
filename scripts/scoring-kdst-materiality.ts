/**
 * Phase 6 — measures how much the weekly K/D-ST fallback (Sleeper STANDARD points) diverges from this league's own scoring applied to the
 * components the provider DOES supply. Not a claim of exactness: components are partial, so this is a bound on the limitation's size, keyed by the
 * canonical scoring fingerprint. `npx tsx scripts/scoring-kdst-materiality.ts [season] [week]`
 */
import { writeFileSync } from "node:fs";
import { calculateFantasyPoints } from "../lib/scoring/calculate";
import { scoringFingerprint } from "../lib/canonical/scoring-fingerprint";
import observed from "../lib/scoring/data/observed-provider-keys.json";

const [season = "2026", week = "2"] = process.argv.slice(2);
const q = new URLSearchParams({ season_type: "regular", order_by: "pts_ppr" }); for (const p of ["QB", "RB", "WR", "TE", "K", "DEF"]) q.append("position[]", p);
const rank = (x: number[]) => { const o = x.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]); const r = new Array<number>(x.length); o.forEach(([, i], n) => (r[i] = n)); return r; };
const spearman = (a: number[], b: number[]) => { const ra = rank(a), rb = rank(b), m = (a.length - 1) / 2; let c = 0, v = 0; for (let i = 0; i < a.length; i++) { c += (ra[i]! - m) * (rb[i]! - m); v += (ra[i]! - m) ** 2; } return v ? c / v : 0; };
(async () => {
  const res = await fetch(`https://api.sleeper.app/projections/nfl/${season}/${week}?${q}`); const rows = (await res.json()) as Array<{ player?: { position?: string }; stats?: Record<string, number> }>;
  const out: Record<string, unknown> = {}; const leagues = observed.live_league_scoring as Record<string, Record<string, number>>;
  for (const [slug, scoring] of Object.entries(leagues)) {
    const rec: Record<string, unknown> = { league_slug: slug, season: Number(season), week: Number(week), measured_on: "projection feed rows with a standard-points total" };
    for (const pos of ["DEF", "K"]) {
      const rs = rows.filter((r) => r.player?.position === pos && typeof r.stats?.pts_std === "number");
      const std = rs.map((r) => r.stats!.pts_std!); const partial = rs.map((r) => { const s: Record<string, number> = {}; for (const [k, v] of Object.entries(r.stats!)) if (!/^(pts_std$|pts_ppr$|pts_half_ppr$|adp_|pos_adp)/.test(k) && typeof v === "number") s[k] = v; return calculateFantasyPoints(s, scoring).fantasy_points; });
      const d = partial.map((p, i) => p - std[i]!); const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length; const r2 = (x: number) => Math.round(x * 100) / 100;
      rec[pos] = { n: rs.length, mean_partial_minus_standard: r2(mean(d)), mean_abs_error: r2(mean(d.map(Math.abs))), rank_correlation: Math.round(spearman(partial, std) * 1000) / 1000, materiality: mean(d.map(Math.abs)) < 0.25 && spearman(partial, std) > 0.99 ? "IMMATERIAL_FOR_SUPPLIED_COMPONENTS" : "MATERIAL_DIVERGENCE" };
    }
    out[scoringFingerprint(scoring)] = rec;
  }
  writeFileSync("lib/scoring/data/kdst-fallback-materiality.json", JSON.stringify({ _note: "Bound on the weekly K/D-ST standard-points fallback error, keyed by canonical scoring fingerprint. 'Partial' = the league's scoring applied ONLY to components the provider supplies (unsupplied league rules are not represented), so this bounds — never replaces — the limitation.", by_fingerprint: out }, null, 1) + "\n");
  console.log(JSON.stringify(out, null, 1));
})();
