/**
 * Before / after roster reconstruction.
 *
 * Given the canonical pre-trade rosters and a NORMALIZED proposal, produce the
 * immutable post-trade `CanonicalRoster` for every participant. Outgoing players
 * are removed from every slot list; incoming players are appended to the bench
 * (the optimizer re-derives the real starting lineup from scratch afterwards, so
 * where an incoming player "lands" here is irrelevant to value — it only has to
 * be on the roster and off IR/taxi).
 *
 * Pure and deterministic. No projection or value logic here.
 */

import type { CanonicalRoster, CanonicalRosterSlot } from "@/lib/canonical/schema";
import type { NormalizedProposal } from "./schema";

export interface ReconstructedRosters {
  /** canonical_manager_id -> { before, after } — `before` is a defensive copy. */
  by_manager: Map<string, { before: CanonicalRoster; after: CanonicalRoster }>;
  incoming_by_manager: Map<string, string[]>;
  outgoing_by_manager: Map<string, string[]>;
}

function cloneRoster(r: CanonicalRoster): CanonicalRoster {
  return {
    ...r,
    slots: r.slots.map((s) => ({ ...s })),
    starters: [...r.starters],
    bench: [...r.bench],
    ir: [...r.ir],
    taxi: [...r.taxi],
    all_players: [...r.all_players],
    provenance: { ...r.provenance },
  };
}

export function reconstructRosters(
  normalized: NormalizedProposal,
  /** canonical_manager_id -> canonical_team_id -> pre-trade roster */
  rosterByManager: Map<string, CanonicalRoster>,
): ReconstructedRosters {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const mid of normalized.participant_manager_ids) {
    incoming.set(mid, []);
    outgoing.set(mid, []);
  }
  for (const t of normalized.transfers) {
    outgoing.get(t.from_manager_id)!.push(t.canonical_player_id);
    incoming.get(t.to_manager_id)!.push(t.canonical_player_id);
  }
  // Sort so the reconstructed roster (bench append order, id lists) is invariant
  // to the order transfers were listed in the proposal.
  for (const list of [...incoming.values(), ...outgoing.values()]) list.sort();

  const by_manager = new Map<string, { before: CanonicalRoster; after: CanonicalRoster }>();
  for (const mid of normalized.participant_manager_ids) {
    const before = cloneRoster(rosterByManager.get(mid)!);
    const out = new Set(outgoing.get(mid)!);
    const inc = incoming.get(mid)!;

    const keepId = (id: string | null): boolean => id == null || !out.has(id);
    const afterSlots: CanonicalRosterSlot[] = before.slots.map((s) =>
      s.canonical_player_id != null && out.has(s.canonical_player_id)
        ? { ...s, canonical_player_id: null, is_empty: true }
        : { ...s },
    );
    // Append incoming players as bench entries.
    let idx = afterSlots.length;
    for (const id of inc) {
      afterSlots.push({ slot: "BN", slot_index: idx++, canonical_player_id: id, is_empty: false });
    }

    const after: CanonicalRoster = {
      ...before,
      slots: afterSlots,
      starters: before.starters.filter(keepId),
      bench: [...before.bench.filter((id) => !out.has(id)), ...inc],
      ir: before.ir.filter((id) => !out.has(id)),
      taxi: before.taxi.filter((id) => !out.has(id)),
      all_players: [...before.all_players.filter((id) => !out.has(id)), ...inc],
      provenance: { ...before.provenance },
    };

    by_manager.set(mid, { before, after });
  }

  return { by_manager, incoming_by_manager: incoming, outgoing_by_manager: outgoing };
}
