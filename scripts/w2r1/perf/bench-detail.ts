import { cacheStats } from "../../../lib/w2r1/scenario-cache";
import { computeDynamicVor } from "../../../lib/w2r1/generated/vor-fast";
import { scenarioLineup } from "../../../lib/w2r1/roster";
import { synth } from "./synth";
const { rules, roster, market } = synth(1);
// time of ONE uncached scenario (the unit cost) and the number of distinct scenarios the full roster pass needs
const t0 = performance.now(); for (let i = 0; i < 200; i++) scenarioLineup({ rules, week: 6, kind: "lineup", roster, removeId: roster[i % roster.length]!.player_id, adds: [market.candidates[i % 50]!] }); const unit = (performance.now() - t0) / 200;
const t1 = performance.now(); for (const a of roster) computeDynamicVor({ rules, roster, playerId: a.player_id, week: 6, market }); const dt = performance.now() - t1;
console.log(JSON.stringify({ unit_scenario_ms: Math.round(unit * 1000) / 1000, total_ms: Math.round(dt), ...cacheStats, estimated_scenario_ms: Math.round(cacheStats.scenarioMisses * unit) }));
