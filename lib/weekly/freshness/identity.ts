/**
 * W1.P4 — request-scoped forecast identity. One assembled analysis for one league has ONE identity; every section (lineup, matchup,
 * waivers, roster health) consumes the same forecast set, so they cannot silently mix snapshots. Identity separates league-INDEPENDENT
 * source facts (the source observation) from league-SPECIFIC derivatives (scoring fingerprint), because the same NFL observation is
 * deliberately shared across leagues while scored values never are.
 */

import { contentHash } from "@/lib/bridge/hash";
import { FRESHNESS_POLICY_VERSION } from "./policy";

export interface ForecastSetIdentity {
  identity_id: string;
  league_slug: string;
  provider: string;
  season: number;
  week: number;
  scoring_fingerprint: string | null;
  /** league-independent */
  source_observation: { provider: string | null; observed_at: string | null; observation_id: string | null; content_hash: string | null };
  snapshot_artifact_id: string | null;
  read_path: string | null;
  forecast_model_version: string;
  freshness_policy_version: typeof FRESHNESS_POLICY_VERSION;
  composed_at: string | null;
}

export function buildForecastSetIdentity(a: Omit<ForecastSetIdentity, "identity_id" | "freshness_policy_version">): ForecastSetIdentity {
  const { composed_at: _c, ...stable } = a; // composition time does not change WHICH evidence the set rests on
  void _c;
  return { ...a, freshness_policy_version: FRESHNESS_POLICY_VERSION, identity_id: `fcid:${contentHash({ ...stable, pv: FRESHNESS_POLICY_VERSION }).slice(0, 20)}` };
}

/** true iff two forecast sets rest on exactly the same league-scoped evidence */
export function sameEvidence(a: ForecastSetIdentity, b: ForecastSetIdentity): boolean {
  return a.identity_id === b.identity_id;
}
