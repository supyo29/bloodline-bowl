import { computeDynamicVor } from "../../../lib/w2r1/generated/vor-fast";
import { synth } from "./synth";
const { rules, roster, market } = synth(1);
const t0 = performance.now(); let n = 0; for (const a of roster) { computeDynamicVor({ rules, roster, playerId: a.player_id, week: 6, market }); n++; }
const dt = performance.now() - t0; console.log(JSON.stringify({ players: n, total_ms: Math.round(dt), per_player_ms: Math.round(dt / n) }));
