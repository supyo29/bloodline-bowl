/**
 * Execution-scoped memoization of `buildCanonicalLeagueState`.
 *
 * Phase 1A finding: one logical operation that analyses several managers (or one
 * that composes weekly + trade views) can trigger several full provider reads of
 * the SAME league state. Within one such operation those reads must reuse one
 * immutable snapshot; across independent operations (separate HTTP requests, a
 * later cron tick) the provider must still be re-read so fresh data is observed.
 *
 * This is NOT a cache. It is an `AsyncLocalStorage` scope:
 *   - `runInLeagueStateScope(fn)` establishes a per-operation memo map for the
 *     duration of `fn` (and reuses a parent scope if one is already active, so
 *     nesting composes).
 *   - `buildCanonicalLeagueState` consults the active scope's map (if any) and
 *     otherwise behaves exactly as before — a fresh read every call.
 *
 * The memo key is `leagueSlug` + the read-shape flags. A scope assumes a
 * consistent provider/crosswalk ENVIRONMENT for its lifetime (the normal case:
 * one operation, one config). Callers that inject *different* provider/crosswalk
 * overrides for the same slug within one scope must not wrap those calls in a
 * shared scope — pass `{ bypassScope: true }` if needed.
 *
 * There is no TTL and no process-lifetime retention: the map is unreachable once
 * `fn` resolves.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CanonicalStateResult } from "./state";

type ScopeMap = Map<string, Promise<CanonicalStateResult>>;

const storage = new AsyncLocalStorage<ScopeMap>();

/**
 * Run `fn` inside a canonical-league-state memo scope. If a scope is already
 * active (nested composition), the existing one is reused.
 */
export function runInLeagueStateScope<T>(fn: () => Promise<T>): Promise<T> {
  const existing = storage.getStore();
  if (existing) return fn();
  return storage.run(new Map(), fn);
}

/** The active scope's memo map, or `undefined` when no scope is active. */
export function activeLeagueStateScope(): ScopeMap | undefined {
  return storage.getStore();
}

/** Whether an execution-scoped snapshot memo is currently active. */
export function inLeagueStateScope(): boolean {
  return storage.getStore() !== undefined;
}

export function leagueStateScopeKey(
  leagueSlug: string,
  flags: { includeMatchups: boolean; includeRecentTransactions: boolean; reportPersistence: boolean },
): string {
  return `${leagueSlug}|m=${flags.includeMatchups ? 1 : 0}|t=${flags.includeRecentTransactions ? 1 : 0}|p=${flags.reportPersistence ? 1 : 0}`;
}
