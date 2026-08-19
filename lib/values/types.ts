/**
 * Player-value provider abstraction.
 *
 * The bridge never invents a universal player value. Every value returned
 * must be attributed to a named, timestamped source; if no source is
 * configured, the provider says so honestly rather than fabricating numbers.
 * A future provider (ADP, auction values, dynasty rankings, projections) only
 * has to implement this interface — nothing else in the bridge changes.
 */

export interface PlayerValue {
  source: string;
  source_type: string;
  updated_at: string;
  season: string | null;
  format: string | null;
  value: number;
}

export interface PlayerValueProvider {
  /** A stable identifier for this provider, used in source citations. */
  readonly name: string;
  /** Whether this provider is currently configured and able to serve data. */
  isAvailable(): boolean;
  /** Human-readable reason `isAvailable()` is false, or null when available. */
  unavailableReason(): string | null;
  getValues(playerIds: string[]): Promise<Map<string, PlayerValue[]>>;
}
