/**
 * Draft Bridge — per-league draft state.
 *
 * Every league owns an independent `BridgeDraftState`. The Bridge UI persists
 * one per league under a league-keyed storage slot and NEVER merges them. This
 * module is the pure core: state shape, the mutation helpers the UI calls, and
 * the fail-closed guards that stop one league's picks, roster, or draft feed
 * from leaking into another.
 *
 * Framework-free on purpose — it runs unchanged in the browser bundle and in
 * `node --test`.
 */

import type { BridgeLeagueProfile } from "./profiles";

export const BRIDGE_STATE_SCHEMA = "bridge.state.v1";

/** How a player is marked on the board. */
export type DraftEntryStatus = "drafted" | "mine";

/** Denormalized player metadata, captured at mark time so "My Team" survives
 * even if the player later drops out of the ranked board pool. */
export interface DraftEntryPlayer {
  name: string;
  position: string | null;
  team: string | null;
  fantasy_positions: string[];
}

export interface DraftEntry {
  status: DraftEntryStatus;
  /** 1-indexed overall pick number, when known. */
  pick_no: number | null;
  round: number | null;
  /** Draft slot that made the pick, when known. */
  by_slot: number | null;
  source: "manual" | "sleeper_sync";
  at: string;
  player: DraftEntryPlayer | null;
}

export interface CustomRanking {
  /** Sleeper player id, once matched. */
  player_id: string | null;
  name: string;
  position: string | null;
  rank: number;
  tier: number | null;
}

export interface CustomRankingsMeta {
  filename: string;
  loaded_at: string;
  matched: number;
  unmatched: string[];
}

export interface BridgeDraftState {
  schema: typeof BRIDGE_STATE_SCHEMA;
  /** MUST equal the `league_key` of the profile this state belongs to. */
  league_key: string;
  updated_at: string;
  /**
   * Scoring identity (see `lib/bridge/hash.ts`) the state was last reconciled
   * against. A change means the league's live rules moved under the state.
   */
  scoring_sha: string | null;
  /** User-confirmed draft slot, overriding the profile's best-known value. */
  slot_override: number | null;
  /** player_id -> entry. Absence means "available". */
  entries: Record<string, DraftEntry>;
  custom_rankings: CustomRanking[] | null;
  custom_rankings_meta: CustomRankingsMeta | null;
}

export function emptyDraftState(
  profile: BridgeLeagueProfile,
  now: string = new Date().toISOString(),
): BridgeDraftState {
  return {
    schema: BRIDGE_STATE_SCHEMA,
    league_key: profile.league_key,
    updated_at: now,
    scoring_sha: null,
    slot_override: null,
    entries: {},
    custom_rankings: null,
    custom_rankings_meta: null,
  };
}

/** localStorage key for a league's state. League-keyed — never global. */
export function stateStorageKey(leagueKey: string): string {
  return `bbb.bridge.state.v1.${leagueKey}`;
}

/** localStorage key holding only the active-league selection. */
export const ACTIVE_LEAGUE_STORAGE_KEY = "bbb.bridge.active_league.v1";

/* -------------------------------------------------------------------------- */
/* Fail-closed guards                                                          */
/* -------------------------------------------------------------------------- */

export class BridgeIsolationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeIsolationError";
    this.code = code;
  }
}

/**
 * Refuse to operate on a state that does not belong to `profile`. This is what
 * makes "load the other league's state" safe: a mismatched blob is rejected,
 * not adopted.
 */
export function assertStateBelongsToLeague(
  profile: BridgeLeagueProfile,
  state: BridgeDraftState,
): void {
  if (state.schema !== BRIDGE_STATE_SCHEMA) {
    throw new BridgeIsolationError(
      "BRIDGE_STATE_SCHEMA_MISMATCH",
      `Draft state schema "${state.schema}" is not "${BRIDGE_STATE_SCHEMA}".`,
    );
  }
  if (state.league_key !== profile.league_key) {
    throw new BridgeIsolationError(
      "LEAGUE_STATE_KEY_MISMATCH",
      `Draft state is for league "${state.league_key}" but was loaded for "${profile.league_key}". ` +
        `Refusing to mix league draft state.`,
    );
  }
}

/** Minimal shape of a Sleeper draft object, for source validation. */
export interface SleeperDraftSource {
  draft_id?: string | null;
  league_id?: string | null;
}

export type ReconcileResult =
  | { ok: true }
  | { ok: false; code: "DRAFT_SOURCE_LEAGUE_MISMATCH"; detail: string };

/**
 * Verify a Sleeper draft feed belongs to `profile` BEFORE any of its picks are
 * merged. A draft response for league A fed into league B is rejected here.
 */
export function reconcileDraftSource(
  profile: BridgeLeagueProfile,
  source: SleeperDraftSource,
): ReconcileResult {
  const leagueId = source.league_id ?? null;
  const draftId = source.draft_id ?? null;

  if (leagueId !== null && leagueId !== profile.platform_league_id) {
    return {
      ok: false,
      code: "DRAFT_SOURCE_LEAGUE_MISMATCH",
      detail:
        `Draft feed is for Sleeper league ${leagueId}, but the active Bridge league ` +
        `"${profile.league_key}" is Sleeper league ${profile.platform_league_id}.`,
    };
  }
  if (draftId !== null && draftId !== profile.platform_draft_id) {
    return {
      ok: false,
      code: "DRAFT_SOURCE_LEAGUE_MISMATCH",
      detail:
        `Draft feed is draft ${draftId}, but "${profile.league_key}" uses draft ` +
        `${profile.platform_draft_id}.`,
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Mutations (pure — return a new state)                                       */
/* -------------------------------------------------------------------------- */

export interface MarkOptions {
  pick_no?: number | null;
  round?: number | null;
  by_slot?: number | null;
  source?: "manual" | "sleeper_sync";
  player?: DraftEntryPlayer | null;
  now?: string;
}

export function markPlayer(
  state: BridgeDraftState,
  playerId: string,
  status: DraftEntryStatus,
  options: MarkOptions = {},
): BridgeDraftState {
  const now = options.now ?? new Date().toISOString();
  const existing = state.entries[playerId];
  return {
    ...state,
    updated_at: now,
    entries: {
      ...state.entries,
      [playerId]: {
        status,
        pick_no: options.pick_no ?? existing?.pick_no ?? null,
        round: options.round ?? existing?.round ?? null,
        by_slot: options.by_slot ?? existing?.by_slot ?? null,
        source: options.source ?? "manual",
        at: now,
        player: options.player ?? existing?.player ?? null,
      },
    },
  };
}

export function clearPlayer(
  state: BridgeDraftState,
  playerId: string,
  now: string = new Date().toISOString(),
): BridgeDraftState {
  if (!(playerId in state.entries)) return state;
  const entries = { ...state.entries };
  delete entries[playerId];
  return { ...state, entries, updated_at: now };
}

/**
 * Merge picks from a validated Sleeper draft feed. Throws if the feed was not
 * reconciled against this league first — callers must pass the reconcile
 * result through, which forces the check to have happened.
 */
export function mergeSleeperPicks(
  state: BridgeDraftState,
  profile: BridgeLeagueProfile,
  picks: Array<{
    player_id: string | null;
    pick_no?: number | null;
    round?: number | null;
    draft_slot?: number | null;
    player?: DraftEntryPlayer | null;
  }>,
  reconcile: ReconcileResult,
  now: string = new Date().toISOString(),
): BridgeDraftState {
  if (!reconcile.ok) {
    throw new BridgeIsolationError(reconcile.code, reconcile.detail);
  }
  assertStateBelongsToLeague(profile, state);

  const mySlot = state.slot_override ?? profile.manager.draft_slot;
  const entries = { ...state.entries };

  for (const pick of picks) {
    if (!pick.player_id) continue;
    const existing = entries[pick.player_id];
    // A manual "mine" mark is authoritative over a sync that only knows "drafted".
    if (existing?.status === "mine" && existing.source === "manual") continue;

    const isMine =
      mySlot != null &&
      pick.draft_slot != null &&
      pick.draft_slot === mySlot;

    entries[pick.player_id] = {
      status: isMine ? "mine" : "drafted",
      pick_no: pick.pick_no ?? null,
      round: pick.round ?? null,
      by_slot: pick.draft_slot ?? null,
      source: "sleeper_sync",
      at: now,
      player: pick.player ?? existing?.player ?? null,
    };
  }

  return { ...state, entries, updated_at: now };
}

/* -------------------------------------------------------------------------- */
/* Derived views                                                               */
/* -------------------------------------------------------------------------- */

export function draftedPlayerIds(state: BridgeDraftState): Set<string> {
  const ids = new Set<string>();
  for (const [playerId, entry] of Object.entries(state.entries)) {
    if (entry.status === "drafted" || entry.status === "mine") ids.add(playerId);
  }
  return ids;
}

export function minePlayerIds(state: BridgeDraftState): string[] {
  return Object.entries(state.entries)
    .filter(([, entry]) => entry.status === "mine")
    .sort((a, b) => {
      const pa = a[1].pick_no ?? Number.MAX_SAFE_INTEGER;
      const pb = b[1].pick_no ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return a[1].at.localeCompare(b[1].at);
    })
    .map(([playerId]) => playerId);
}

export function overallPicksMade(state: BridgeDraftState): number {
  let count = 0;
  for (const entry of Object.values(state.entries)) {
    if (entry.status === "drafted" || entry.status === "mine") count += 1;
  }
  return count;
}

/**
 * Load a stored blob as this league's state, or start a fresh one. A blob that
 * fails the isolation guard is discarded (not adopted) and a warning is
 * returned alongside a clean state.
 */
export function hydrateDraftState(
  profile: BridgeLeagueProfile,
  raw: unknown,
): { state: BridgeDraftState; warnings: string[] } {
  const warnings: string[] = [];
  if (raw == null) {
    return { state: emptyDraftState(profile), warnings };
  }
  try {
    const candidate = raw as BridgeDraftState;
    assertStateBelongsToLeague(profile, candidate);
    return {
      state: {
        ...emptyDraftState(profile),
        ...candidate,
        // Never let a loaded blob change which league this slot represents.
        league_key: profile.league_key,
        schema: BRIDGE_STATE_SCHEMA,
      },
      warnings,
    };
  } catch (error) {
    warnings.push(
      error instanceof Error
        ? `Discarded stored draft state: ${error.message}`
        : "Discarded stored draft state (unreadable).",
    );
    return { state: emptyDraftState(profile), warnings };
  }
}
