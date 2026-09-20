import { createHash } from "node:crypto";
/** canonical, key-sorted JSON so identical inputs hash identically */
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
export const hashOf = (v: unknown, n = 12): string => createHash("sha256").update(canonical(v)).digest("hex").slice(0, n);
