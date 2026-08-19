/**
 * Shared types for the factual analytics layer (`/api/history`,
 * `/api/transactions`, `/api/matchups`, `/api/standings`, `/api/managers`,
 * `/api/roster-analysis`, `/api/snapshot`).
 *
 * Design principle: every field here is a fact or a transparent, formula-backed
 * derived metric. Nothing subjective (grades, labels, rankings by "quality")
 * belongs in this layer — that judgment is left to the AI consumer.
 */

export interface AnalyticsMetadata {
  schema_version: 1;
  generated_at: string;
  league_id: string;
  season: string | null;
  sources: Array<{ name: string; type: string; updated_at?: string | null }>;
  data_freshness: Record<string, string>;
  warnings: string[];
}

/** A derived metric with its inputs and formula made explicit. */
export interface DerivedValue {
  value: number | null;
  formula: string;
  inputs: Record<string, number | null>;
}

export function buildMetadata(
  input: Partial<AnalyticsMetadata> & { league_id: string },
): AnalyticsMetadata {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    season: null,
    sources: [{ name: "Sleeper", type: "league_data" }],
    data_freshness: {},
    warnings: [],
    ...input,
  };
}

/** A named manager identity, resolved wherever it appears in this layer. */
export interface ManagerRef {
  user_id: string | null;
  display_name: string | null;
  team_name: string | null;
}

/** A named, typed source citation for non-Sleeper data. */
export interface SourceCitation {
  name: string;
  type: string;
  updated_at: string | null;
}
