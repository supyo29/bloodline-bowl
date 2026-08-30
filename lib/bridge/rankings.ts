/**
 * Draft Bridge — ranking sources.
 *
 * The Bridge ranks the available-player pool from ONE of two sources, chosen
 * per league:
 *
 *   1. `sleeper_search_rank` — Sleeper's own relevance ordering. The honest
 *      default: it is not a projection model, and the snapshot says so.
 *   2. `custom_upload` — a rankings/tiers file the user pastes or uploads for
 *      that league. Fully league-specific; never shared with the other league.
 *
 * Pure and framework-free.
 */

import type { NormalizedPlayer } from "@/lib/sleeper/types";
import type { CustomRanking } from "./state";

export type RankingSourceKind = "sleeper_search_rank" | "custom_upload";

/** Combining diacritical marks, stripped after NFD-normalizing. */
const COMBINING_MARKS = /[̀-ͯ]/g;
const NAME_SUFFIXES = /\b(jr|sr|ii|iii|iv|v)\b/g;

/** Strip case, punctuation, and common suffixes so names match across sources. */
export function nameMatchKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/[.'`’]/g, "")
    .replace(NAME_SUFFIXES, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface ParsedRow {
  name: string;
  position: string | null;
  rank: number;
  tier: number | null;
}

/**
 * Parse a rankings file. Accepts:
 *   - JSON array of objects with `name`/`player` and `rank`, optional `position`/`pos`, `tier`
 *   - CSV/TSV with a header row naming at least a name column and a rank column
 *   - CSV/TSV with no header: `rank,name,position,tier` or `name,position` (rank = line number)
 */
export function parseCustomRankings(text: string): {
  rankings: CustomRanking[];
  errors: string[];
} {
  const errors: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) return { rankings: [], errors: ["File was empty."] };

  let rows: ParsedRow[] = [];

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { players?: unknown }).players)
          ? (parsed as { players: unknown[] }).players
          : Array.isArray((parsed as { rankings?: unknown }).rankings)
            ? (parsed as { rankings: unknown[] }).rankings
            : null;
      if (!arr) {
        errors.push("JSON must be an array (or { players: [...] }).");
      } else {
        rows = arr
          .map((entry, index): ParsedRow | null => {
            const obj = entry as Record<string, unknown>;
            const name = String(
              obj.name ?? obj.player ?? obj.full_name ?? "",
            ).trim();
            if (!name) return null;
            const rankRaw = obj.rank ?? obj.overall ?? obj.ovr ?? index + 1;
            const rank = Number(rankRaw);
            const posRaw = obj.position ?? obj.pos ?? null;
            const tierRaw = obj.tier ?? null;
            return {
              name,
              position: posRaw ? String(posRaw).toUpperCase().trim() : null,
              rank: Number.isFinite(rank) ? rank : index + 1,
              tier:
                tierRaw != null && Number.isFinite(Number(tierRaw))
                  ? Number(tierRaw)
                  : null,
            };
          })
          .filter((row): row is ParsedRow => row !== null);
      }
    } catch (error) {
      errors.push(
        `Could not parse JSON: ${error instanceof Error ? error.message : "unknown error"}.`,
      );
    }
  } else {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const delimiter = (lines[0]?.includes("\t") ? "\t" : ",") as string;
    const cells = (line: string): string[] =>
      line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ""));

    const header = lines[0] ? cells(lines[0]).map((c) => c.toLowerCase()) : [];
    const hasHeader = header.some((c) =>
      ["name", "player", "player_name", "full_name"].includes(c),
    );

    const nameIdx = hasHeader
      ? header.findIndex((c) =>
          ["name", "player", "player_name", "full_name"].includes(c),
        )
      : 1;
    const rankIdx = hasHeader
      ? header.findIndex((c) => ["rank", "overall", "ovr", "#"].includes(c))
      : 0;
    const posIdx = hasHeader
      ? header.findIndex((c) => ["position", "pos"].includes(c))
      : 2;
    const tierIdx = hasHeader
      ? header.findIndex((c) => c === "tier")
      : 3;

    const body = hasHeader ? lines.slice(1) : lines;
    rows = body
      .map((line, index): ParsedRow | null => {
        const parts = cells(line);
        // No-header single-column file: the whole line is the name.
        const name =
          parts.length === 1
            ? (parts[0] as string)
            : ((parts[nameIdx] ?? parts[1] ?? parts[0]) as string | undefined) ??
              "";
        if (!name || !name.trim()) return null;
        const rankCell = rankIdx >= 0 ? parts[rankIdx] : undefined;
        const rank = Number(rankCell);
        const posCell = posIdx >= 0 ? parts[posIdx] : undefined;
        const tierCell = tierIdx >= 0 ? parts[tierIdx] : undefined;
        return {
          name: name.trim(),
          position: posCell ? posCell.toUpperCase().trim() : null,
          rank: Number.isFinite(rank) && rank > 0 ? rank : index + 1,
          tier:
            tierCell && Number.isFinite(Number(tierCell))
              ? Number(tierCell)
              : null,
        };
      })
      .filter((row): row is ParsedRow => row !== null);
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push("No rows recognized in the file.");
  }

  // De-dupe by name+position, keep the best (lowest) rank, then re-number 1..N.
  const byKey = new Map<string, ParsedRow>();
  for (const row of rows) {
    const key = `${nameMatchKey(row.name)}|${row.position ?? ""}`;
    const existing = byKey.get(key);
    if (!existing || row.rank < existing.rank) byKey.set(key, row);
  }
  const ordered = [...byKey.values()].sort((a, b) => a.rank - b.rank);

  const rankings: CustomRanking[] = ordered.map((row, index) => ({
    player_id: null,
    name: row.name,
    position: row.position,
    rank: index + 1,
    tier: row.tier,
  }));

  return { rankings, errors };
}

/**
 * Attach Sleeper `player_id`s to parsed rankings by name (+ position when the
 * file gives one). Returns the matched list plus the names that found no player.
 */
export function matchCustomRankings(
  rankings: CustomRanking[],
  players: Iterable<NormalizedPlayer>,
): { matched: CustomRanking[]; unmatched: string[] } {
  const byName = new Map<string, NormalizedPlayer[]>();
  for (const player of players) {
    const key = nameMatchKey(player.full_name);
    const bucket = byName.get(key) ?? [];
    bucket.push(player);
    byName.set(key, bucket);
  }

  const matched: CustomRanking[] = [];
  const unmatched: string[] = [];

  for (const ranking of rankings) {
    const candidates = byName.get(nameMatchKey(ranking.name)) ?? [];
    let chosen: NormalizedPlayer | undefined;
    if (ranking.position) {
      chosen = candidates.find(
        (p) =>
          p.position === ranking.position ||
          p.fantasy_positions.includes(ranking.position as string),
      );
    }
    chosen = chosen ?? candidates[0];
    if (chosen) {
      matched.push({ ...ranking, player_id: chosen.player_id });
    } else {
      unmatched.push(
        ranking.position ? `${ranking.name} (${ranking.position})` : ranking.name,
      );
    }
  }

  return { matched, unmatched };
}

export interface RankedPlayer {
  player: NormalizedPlayer;
  /** 1-indexed rank within this league's chosen source. */
  rank: number | null;
  tier: number | null;
  ranking_source: RankingSourceKind;
}

/**
 * Order a player pool by the league's chosen ranking source.
 *
 * With `custom_upload`, players present in the file come first in file order;
 * players not in the file follow, ordered by Sleeper `search_rank`, with
 * `rank: null` so the UI can show them as "unranked by your file".
 */
export function rankPlayers(
  players: NormalizedPlayer[],
  options: {
    source: RankingSourceKind;
    customRankings?: CustomRanking[] | null;
  },
): RankedPlayer[] {
  if (options.source === "custom_upload" && options.customRankings?.length) {
    const rankById = new Map<string, CustomRanking>();
    for (const ranking of options.customRankings) {
      if (ranking.player_id) rankById.set(ranking.player_id, ranking);
    }
    const inFile: RankedPlayer[] = [];
    const rest: NormalizedPlayer[] = [];
    for (const player of players) {
      const ranking = rankById.get(player.player_id);
      if (ranking) {
        inFile.push({
          player,
          rank: ranking.rank,
          tier: ranking.tier,
          ranking_source: "custom_upload",
        });
      } else {
        rest.push(player);
      }
    }
    inFile.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    rest.sort(sleeperOrder);
    return [
      ...inFile,
      ...rest.map((player) => ({
        player,
        rank: null,
        tier: null,
        ranking_source: "custom_upload" as const,
      })),
    ];
  }

  return [...players].sort(sleeperOrder).map((player, index) => ({
    player,
    rank: player.search_rank != null ? index + 1 : null,
    tier: null,
    ranking_source: "sleeper_search_rank" as const,
  }));
}

function sleeperOrder(a: NormalizedPlayer, b: NormalizedPlayer): number {
  const ra = a.search_rank ?? Number.MAX_SAFE_INTEGER;
  const rb = b.search_rank ?? Number.MAX_SAFE_INTEGER;
  if (ra !== rb) return ra - rb;
  return a.full_name.localeCompare(b.full_name);
}

/* -------------------------------------------------------------------------- */
/* Client-side pool re-ranking (custom file already matched to player ids)     */
/* -------------------------------------------------------------------------- */

export interface RerankablePlayer {
  player_id: string;
  name: string;
  position: string | null;
  fantasy_positions: string[];
  sleeper_search_rank: number | null;
  rank: number | null;
  tier: number | string | null;
}

/**
 * Reorder an already-fetched board pool by a matched custom rankings list.
 * Players in the file come first in file order (with the file's rank/tier);
 * the rest keep Sleeper order with `rank: null`.
 */
export function applyCustomRankingsToPool<T extends RerankablePlayer>(
  pool: T[],
  rankings: CustomRanking[],
): T[] {
  const byId = new Map<string, CustomRanking>();
  for (const r of rankings) {
    if (r.player_id) byId.set(r.player_id, r);
  }
  const inFile: T[] = [];
  const rest: T[] = [];
  for (const player of pool) {
    const r = byId.get(player.player_id);
    if (r) {
      inFile.push({ ...player, rank: r.rank, tier: r.tier });
    } else {
      rest.push({ ...player, rank: null, tier: null });
    }
  }
  inFile.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  rest.sort(
    (a, b) =>
      (a.sleeper_search_rank ?? Number.MAX_SAFE_INTEGER) -
      (b.sleeper_search_rank ?? Number.MAX_SAFE_INTEGER),
  );
  return [...inFile, ...rest];
}
