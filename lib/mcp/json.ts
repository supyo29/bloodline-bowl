/**
 * Narrow, total accessors for untyped route JSON. Compactors read bridge
 * responses through these so a missing or reshaped field becomes `null`/`[]`
 * (reported as such) instead of a thrown error or an invented value.
 */

export type J = Record<string, unknown>;

export function obj(v: unknown): J {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as J) : {};
}

export function isObj(v: unknown): v is J {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function objs(v: unknown): J[] {
  return arr(v).filter(isObj);
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function strs(v: unknown): string[] {
  return arr(v).filter((x): x is string => typeof x === "string");
}

/** Copy only the listed keys that are present (undefined keys are omitted, null is kept). */
export function pick(source: unknown, keys: readonly string[]): J {
  const o = obj(source);
  const out: J = {};
  for (const k of keys) if (k in o) out[k] = o[k];
  return out;
}

/** Deep path read: path("a.b.0.c"). */
export function path(source: unknown, dotted: string): unknown {
  let cur: unknown = source;
  for (const seg of dotted.split(".")) {
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (isObj(cur)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value) ?? "", "utf8");
}
