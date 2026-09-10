/**
 * Yahoo `fantasy_content` traversal helpers.
 *
 * Yahoo's JSON is a hybrid: "collections" are objects keyed by stringified
 * indices (`"0"`, `"1"`, …) plus a `count`, and each entry is often a
 * single-key wrapper (`{ game: [...] }`) whose value is an ARRAY that mixes a
 * metadata object with nested sub-collections. These helpers keep that ugliness
 * in one place. They are intentionally defensive — Yahoo shapes drift — and
 * return `null`/`[]` rather than throwing so callers stay fail-closed.
 */

export type Json = unknown;

function isRecord(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The top-level `fantasy_content` object, or null. */
export function fantasyContent(body: Json): Record<string, Json> | null {
  if (!isRecord(body)) return null;
  const fc = body.fantasy_content;
  return isRecord(fc) ? fc : null;
}

/**
 * Flatten a Yahoo index-keyed collection into an array of its entries.
 * Accepts either `{ "0": {...}, "1": {...}, count: 2 }` or a plain array.
 */
export function collectionEntries(node: Json): Json[] {
  if (Array.isArray(node)) return node;
  if (!isRecord(node)) return [];
  const out: Json[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (/^\d+$/.test(k)) out.push(v);
  }
  return out;
}

/**
 * A collection entry is usually `{ <name>: <value> }`. Pull `<value>` for the
 * given name (e.g. "game", "league", "team").
 */
export function unwrap(entry: Json, name: string): Json {
  if (isRecord(entry) && name in entry) return entry[name];
  return entry;
}

/**
 * Yahoo frequently represents a single resource as an ARRAY that begins with
 * one or more flat metadata objects. Merge those leading objects into one.
 * Non-object elements (nested sub-collections) are ignored here.
 */
export function mergeLeadingObjects(node: Json): Record<string, Json> {
  const merged: Record<string, Json> = {};
  const list = Array.isArray(node) ? node : [node];
  for (const el of list) {
    if (isRecord(el)) {
      for (const [k, v] of Object.entries(el)) {
        if (!isRecord(v) || Object.keys(merged).length === 0 || !(k in merged)) merged[k] = v;
      }
    }
  }
  return merged;
}

export function asString(v: Json): string | null {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

export function asNumber(v: Json): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
