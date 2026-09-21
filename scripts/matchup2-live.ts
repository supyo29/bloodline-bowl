/** Phase 5 — read-only live probe: evaluates real players against real defenses using the certified file-backed evidence. No writes. */
import { fileMatchupSource } from "@/lib/matchup2/source-files";
import { buildMatchupContext } from "@/lib/matchup2/context";
import { evaluatePlayer, evaluateTeam } from "@/lib/matchup2/engine";
import { buildDefenseProfile } from "@/lib/matchup2/defense";
const [, , defense = "DAL", ...names] = process.argv; const list = names.length ? names : ["Puka Nacua", "Josh Allen", "Saquon Barkley", "Travis Kelce"];
const src = fileMatchupSource(); const t0 = performance.now();
for (const name of list) {
  const p = src.resolvePlayer(name); if (!p) { console.log(name, "UNRESOLVED"); continue; }
  const ctx = buildMatchupContext(src, { offense_team: p.team ?? "UNK", defense_team: defense, week: 3 }); const r = evaluatePlayer(src, ctx, p.gsis_id);
  if ("error" in r) { console.log(name, r); continue; }
  console.log(`\n${p.name} (${p.position}, ${p.team}) vs ${defense}: ${r.structural_verdict} | evidence ${r.overall_evidence} | generic pct ${r.generic_defense_context.overall_percentile} → ${r.player_specific_vs_generic}`);
  for (const c of r.components) console.log(`  ${c.direction.padEnd(12)} ${c.id.padEnd(30)} value=${c.value} z=${c.z} rank=${c.rank_among_defenses} ev=${c.evidence} win=${c.window}`);
  console.log("  uncertainty:", r.uncertainty.map((u) => `${u.kind}/${u.level}`).join(", "));
}
const ctx = buildMatchupContext(src, { offense_team: "KC", defense_team: defense, week: 3 }); const prof = buildDefenseProfile(ctx); console.log("\nprofile", defense, JSON.stringify({ shape: prof?.shape, man: prof?.coverage.man_zone[0], pressure: prof?.pressure[0], box: prof?.box[1] }));
const team = evaluateTeam(src, ctx); if (!("error" in team)) console.log("team components:", team.evaluation.components.map((c) => `${c.id}:${c.direction}`).join(", "));
console.log("ms", Math.round(performance.now() - t0));
