import { createHash } from "node:crypto";
/** Canonical, key-sorted JSON so identical inputs hash identically. Matchup 2.0 keeps its own copy so no substrate imports another. */
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
export const hashOf = (v: unknown, n = 16): string => createHash("sha256").update(canonical(v)).digest("hex").slice(0, n);
