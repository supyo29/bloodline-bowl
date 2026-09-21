/**
 * Phase 7 — identity aliasing WITHOUT mutating stored ids.
 *
 * `playerId()` prefers GSIS, then the provider id, then a name key that INCLUDES the team. So (a) the same person can legitimately carry different canonical ids
 * depending on whether the crosswalk resolved him (`player:sleeper:5872` vs `player:gsis:00-0035719` — real: the production crosswalk loads only 266 of 6,053
 * id-bearing rows), and (b) a name-fallback id changes when the person changes team. Old ids live in historical snapshots and must never be rewritten, so the answer
 * is a deterministic ALIAS SET: every id a person could have carried, from which any two records can be linked.
 */
import { playerId, playerNameKey } from "@/lib/canonical/ids";

export interface IdentityInputs { gsis_id?: string | null; sleeper_id?: string | null; yahoo_id?: string | null; full_name?: string | null; position?: string | null }
export interface IdentityAliases { strong: string[]; weak: string[] }

/** Strong = a provider-stable id (unique per person). Weak = team-less name|position key (can collide; never sufficient alone). Both sorted, deterministic. */
export function identityAliases(i: IdentityInputs): IdentityAliases {
  const strong = [i.gsis_id ? playerId({ gsisId: i.gsis_id }) : null, i.sleeper_id ? playerId({ sleeperId: i.sleeper_id }) : null, i.yahoo_id ? playerId({ yahooId: i.yahoo_id }) : null].filter((x): x is string => !!x).sort();
  const weak = i.full_name ? [`player:name:${playerNameKey(i.full_name, i.position ?? null, null)}`] : [];
  return { strong, weak };
}
export type IdentityMatch = "SAME_PERSON" | "POSSIBLE_SAME_PERSON_WEAK_ONLY" | "DIFFERENT_OR_UNKNOWN";
/** Two records are the same person iff they share a STRONG alias. A weak (name) match alone is reported as such, never as a link. */
export function relateIdentities(a: IdentityInputs, b: IdentityInputs): IdentityMatch {
  const A = identityAliases(a), B = identityAliases(b);
  if (A.strong.some((x) => B.strong.includes(x))) return "SAME_PERSON";
  if (A.weak.some((x) => B.weak.includes(x))) return "POSSIBLE_SAME_PERSON_WEAK_ONLY"; return "DIFFERENT_OR_UNKNOWN";
}
/** Given a person's inputs, the links between the ids he may carry (`from` -> `to`), for a future id-migration/lookup layer. Never mutates an id. */
export function identityLinks(i: IdentityInputs): Array<{ from: string; to: string; basis: string }> {
  const ids = identityAliases(i).strong; const out: Array<{ from: string; to: string; basis: string }> = [];
  for (const from of ids) for (const to of ids) if (from !== to) out.push({ from, to, basis: "same record carries both provider ids" }); return out;
}
