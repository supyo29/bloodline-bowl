/**
 * Refresh-mode policy — pure, no I/O.
 *
 * Given a few cheap SIGNALS about a league right now, decide which refresh mode
 * applies and how long a published generation may be reused before a rebuild is
 * warranted. The caller gathers the signals (draft status, recent transaction
 * count) from state it already has; this function never fetches anything.
 *
 * Stage B ships all three modes so the semantics are stable, but does NOT enable
 * aggressive 2–5s live-draft polling — `LIVE_DRAFT` here only tightens the reuse
 * window and the freshness thresholds. The high-frequency runtime is Stage G.
 */

import type { RefreshMode } from "./freshness";

export interface RefreshSignals {
  /** A draft for this league is actively running (status "drafting"). */
  draft_active?: boolean;
  /** Completed transactions observed in roughly the last 30 minutes. */
  recent_transaction_count?: number;
  /** Operator/forced refresh — bypass reuse windows but keep the mode. */
  forced?: boolean;
}

export interface RefreshPolicy {
  mode: RefreshMode;
  /**
   * Max age (seconds) of a published generation before `getPublishedLeagueSnapshot`
   * should build + certify a fresh candidate. 0 ⇒ always rebuild (forced).
   */
  rebuild_after_seconds: number;
  /**
   * TTL (seconds) for the per-instance cache of the durable pointer read.
   * Small; the durable row is always authority.
   */
  pointer_cache_seconds: number;
  /** `revalidate` hint passed through to the underlying provider fetches. */
  provider_revalidate_seconds: number;
  rationale: string;
}

const BASE: Record<RefreshMode, Omit<RefreshPolicy, "mode" | "rationale">> = {
  NORMAL: {
    rebuild_after_seconds: 120,
    pointer_cache_seconds: 30,
    provider_revalidate_seconds: 120,
  },
  HIGH_ACTIVITY: {
    rebuild_after_seconds: 20,
    pointer_cache_seconds: 10,
    provider_revalidate_seconds: 20,
  },
  LIVE_DRAFT: {
    rebuild_after_seconds: 5,
    pointer_cache_seconds: 2,
    provider_revalidate_seconds: 5,
  },
};

export function resolveRefreshPolicy(signals: RefreshSignals = {}): RefreshPolicy {
  let mode: RefreshMode;
  let rationale: string;

  if (signals.draft_active) {
    mode = "LIVE_DRAFT";
    rationale = "a draft is actively running";
  } else if ((signals.recent_transaction_count ?? 0) > 0) {
    mode = "HIGH_ACTIVITY";
    rationale = `${signals.recent_transaction_count} transaction(s) in the recent window`;
  } else {
    mode = "NORMAL";
    rationale = "no draft, no recent roster churn";
  }

  const base = BASE[mode];
  if (signals.forced) {
    return {
      mode,
      rebuild_after_seconds: 0,
      pointer_cache_seconds: 0,
      provider_revalidate_seconds: base.provider_revalidate_seconds,
      rationale: `${rationale}; forced refresh bypasses reuse windows`,
    };
  }
  return { mode, ...base, rationale };
}
