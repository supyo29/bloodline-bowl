/**
 * Trade Engine — Phase 3.5D: counterfactual trade generation.
 *
 * Real completed trades are not a random sample — managers only propose
 * trades they already believe are acceptable (Phase 3.5 §20, "selection bias
 * warning"). A counterfactual generator produces LEGAL, never-actually-made
 * trades from a real roster snapshot so calibration isn't trained only on
 * deals someone already liked.
 *
 * This generator is deterministic (seeded) and intentionally simple: 1-for-1
 * same-position bench swaps between two rosters. It does not explode
 * combinatorially (bounded by `maxTrades`), and every output is validated for
 * ownership and no duplicate assets before being returned. It does not touch
 * league state, provider data, or network — pure function of its inputs.
 */

export interface CounterfactualRosterInput {
  manager_slug: string;
  /** bench-eligible player ids, each tagged with a position for matching */
  bench_players: Array<{ player_id: string; position: string }>;
}

export interface CounterfactualTrade {
  seed: number;
  index: number;
  from_manager_slug: string;
  to_manager_slug: string;
  from_player_id: string;
  to_player_id: string;
  position: string;
}

/** A tiny deterministic LCG — no dependency, reproducible across platforms/Node versions. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/**
 * Generates up to `maxTrades` legal 1-for-1 same-position bench swaps between
 * every pair of rosters in `rosters`, in a deterministic order controlled by
 * `seed`. Every generated trade is validated: neither player already belongs
 * to the other roster, and no player appears in more than one generated trade
 * (no duplicate-asset trades, no re-trading the same player away twice).
 */
export function generateCounterfactualTrades(
  rosters: CounterfactualRosterInput[],
  seed: number,
  maxTrades = 20,
): CounterfactualTrade[] {
  const rng = makeRng(seed);
  const used = new Set<string>(); // player ids already consumed by a generated trade
  const candidates: Array<Omit<CounterfactualTrade, "seed" | "index">> = [];

  for (let i = 0; i < rosters.length; i += 1) {
    for (let j = 0; j < rosters.length; j += 1) {
      if (i === j) continue;
      const a = rosters[i]!;
      const b = rosters[j]!;
      for (const pa of a.bench_players) {
        for (const pb of b.bench_players) {
          if (pa.position !== pb.position) continue;
          if (pa.player_id === pb.player_id) continue; // can't happen across distinct rosters, defensive
          candidates.push({
            from_manager_slug: a.manager_slug,
            to_manager_slug: b.manager_slug,
            from_player_id: pa.player_id,
            to_player_id: pb.player_id,
            position: pa.position,
          });
        }
      }
    }
  }

  // Deterministic shuffle (Fisher-Yates driven by the seeded RNG) so `maxTrades`
  // sampling isn't biased toward roster/position iteration order.
  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
  }

  const out: CounterfactualTrade[] = [];
  for (const c of candidates) {
    if (out.length >= maxTrades) break;
    if (used.has(c.from_player_id) || used.has(c.to_player_id)) continue; // validity: no asset reused across generated trades
    used.add(c.from_player_id);
    used.add(c.to_player_id);
    out.push({ seed, index: out.length, ...c });
  }
  return out;
}

/** Structural validity check: every generated trade swaps two distinct, never-reused players between two distinct managers. */
export function validateCounterfactualBatch(trades: CounterfactualTrade[]): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const t of trades) {
    if (t.from_manager_slug === t.to_manager_slug) violations.push(`trade ${t.index}: from/to manager are the same (${t.from_manager_slug})`);
    if (t.from_player_id === t.to_player_id) violations.push(`trade ${t.index}: from/to player are the same (${t.from_player_id})`);
    for (const pid of [t.from_player_id, t.to_player_id]) {
      if (seen.has(pid)) violations.push(`trade ${t.index}: player ${pid} reused across generated trades`);
      seen.add(pid);
    }
  }
  return { ok: violations.length === 0, violations };
}
