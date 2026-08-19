/**
 * Shared query-parameter validation for the analytics routes. Every accepted
 * parameter is explicitly allowlisted and bounded — nothing here ever reaches
 * an upstream URL unvalidated.
 */

export type QueryResult<T> = { value: T } | { error: string };

export function parseSeason(raw: string | null, fallback: string): QueryResult<string> {
  if (raw === null) return { value: fallback };
  if (!/^\d{4}$/.test(raw)) return { error: "season must be a 4-digit year, e.g. 2026." };
  return { value: raw };
}

export function parseWeek(raw: string | null): QueryResult<number | null> {
  if (raw === null) return { value: null };
  if (!/^\d{1,2}$/.test(raw)) return { error: "week must be a positive integer." };
  const week = Number.parseInt(raw, 10);
  if (week < 1 || week > 18) return { error: "week must be between 1 and 18." };
  return { value: week };
}

export function parseRosterId(raw: string | null): QueryResult<number | null> {
  if (raw === null) return { value: null };
  if (!/^\d{1,3}$/.test(raw)) return { error: "roster_id must be a positive integer." };
  return { value: Number.parseInt(raw, 10) };
}

export function parseUserId(raw: string | null): QueryResult<string | null> {
  if (raw === null) return { value: null };
  if (!/^\d{1,25}$/.test(raw)) return { error: "user_id must be a numeric Sleeper id." };
  return { value: raw };
}

export function parsePlayerId(raw: string | null): QueryResult<string | null> {
  if (raw === null) return { value: null };
  // Most player ids are numeric; team defenses use a 2-3 letter team code.
  if (!/^[A-Za-z0-9_-]{1,10}$/.test(raw)) return { error: "player_id is not a valid id." };
  return { value: raw };
}

export function parsePosition(
  raw: string | null,
  allowed: ReadonlySet<string>,
): QueryResult<string | null> {
  if (raw === null || raw === "") return { value: null };
  const upper = raw.toUpperCase();
  if (!allowed.has(upper)) {
    return { error: `position must be one of: ${[...allowed].sort().join(", ")}` };
  }
  return { value: upper };
}

export function parseTransactionType(raw: string | null): QueryResult<string | null> {
  const allowed = new Set(["trade", "waiver", "free_agent", "commissioner"]);
  if (raw === null || raw === "") return { value: null };
  if (!allowed.has(raw)) {
    return { error: `type must be one of: ${[...allowed].sort().join(", ")}` };
  }
  return { value: raw };
}

export function parseBoolean(raw: string | null): boolean {
  return raw === "true" || raw === "1";
}

export function parseLimit(
  raw: string | null,
  { defaultValue, max }: { defaultValue: number; max: number },
): QueryResult<number> {
  if (raw === null) return { value: defaultValue };
  if (!/^\d{1,6}$/.test(raw)) return { error: "limit must be a non-negative integer." };
  const limit = Number.parseInt(raw, 10);
  if (limit < 1 || limit > max) return { error: `limit must be between 1 and ${max}.` };
  return { value: limit };
}

export function parseOffset(raw: string | null): QueryResult<number> {
  if (raw === null) return { value: 0 };
  if (!/^\d{1,7}$/.test(raw)) return { error: "offset must be a non-negative integer." };
  return { value: Number.parseInt(raw, 10) };
}
