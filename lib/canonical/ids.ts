/**
 * Deterministic canonical id construction.
 *
 * Canonical ids are stable, human-inspectable, and reproducible: the same real
 * entity produces the same id on every run and (where a stable provider key
 * exists) across providers. They are NOT random — a snapshot re-captured an hour
 * later must line up with the previous one row-for-row.
 *
 * Shape: `<kind>:<provider-or-scope>:<slug>` — lowercase, `/` and whitespace
 * collapsed to `-`. Ids are opaque to consumers; only equality matters.
 */

import { createHash } from "node:crypto";

function slug(value: string): string {
  return value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Short stable hash for cases with no naturally short key (e.g. trades). */
export function shortHash(...parts: Array<string | number | null | undefined>): string {
  return createHash("sha256")
    .update(parts.map((p) => String(p ?? "")).join("|"))
    .digest("hex")
    .slice(0, 16);
}

export function leagueId(leagueSlug: string): string {
  return `league:${slug(leagueSlug)}`;
}

export function managerId(leagueSlug: string, providerUserId: string | null, fallbackSlug: string): string {
  return `manager:${slug(leagueSlug)}:${slug(providerUserId ?? fallbackSlug)}`;
}

export function teamId(leagueSlug: string, providerTeamId: string): string {
  return `team:${slug(leagueSlug)}:${slug(providerTeamId)}`;
}

export function rosterId(canonicalTeamId: string): string {
  return canonicalTeamId.replace(/^team:/, "roster:");
}

export function matchupId(leagueSlug: string, week: number, key: string): string {
  return `matchup:${slug(leagueSlug)}:w${week}:${slug(key)}`;
}

export function draftPickId(leagueSlug: string, season: number, pickNumber: number): string {
  return `draftpick:${slug(leagueSlug)}:${season}:${pickNumber}`;
}

export function transactionId(
  provider: string,
  leagueSlug: string,
  season: number,
  providerTransactionId: string,
): string {
  return `txn:${slug(provider)}:${slug(leagueSlug)}:${season}:${slug(providerTransactionId)}`;
}

/**
 * Canonical player id. Prefers a stable cross-provider key (gsis id), then the
 * provider's own player id, then a name/position/team fallback. The `resolution`
 * on the player record records which path was taken.
 */
export function playerId(input: {
  gsisId?: string | null;
  sleeperId?: string | null;
  yahooId?: string | null;
  nameKey?: string | null;
}): string {
  if (input.gsisId) return `player:gsis:${slug(input.gsisId)}`;
  if (input.sleeperId) return `player:sleeper:${slug(input.sleeperId)}`;
  if (input.yahooId) return `player:yahoo:${slug(input.yahooId)}`;
  if (input.nameKey) return `player:name:${slug(input.nameKey)}`;
  return `player:unresolved:${shortHash(Date.now(), Math.random())}`;
}

/** `name|position|team` join key used for name-based crosswalk fallback. */
export function playerNameKey(
  name: string,
  position: string | null,
  team: string | null,
): string {
  return slug([normalizeName(name), position ?? "", team ?? ""].join("|"));
}

const COMBINING_MARKS = /[̀-ͯ]/g;
const NAME_SUFFIX = /\b(jr|sr|ii|iii|iv|v)\.?\b/g;
const NAME_PUNCT = /[.'`’]/g;

/**
 * Normalize a player name for matching: strip suffixes, punctuation, and
 * accents; collapse whitespace; lowercase. `A.J. Brown` -> `aj brown`,
 * `Michael Pittman Jr.` -> `michael pittman`.
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(NAME_SUFFIX, "")
    .replace(NAME_PUNCT, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s{2,}/g, " ");
}
