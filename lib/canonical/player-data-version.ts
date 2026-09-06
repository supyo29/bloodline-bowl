/**
 * `player_data_version` — a content hash of the player metadata a snapshot
 * carries, so two recommendations can be compared for "did the underlying
 * player data materially differ".
 *
 * Why a content hash and not a timestamp: neither Sleeper's `/players/nfl` dump
 * nor Yahoo's player feed exposes a generation number or an ETag we can trust
 * across requests. A wall-clock stamp would make every rebuild look "different"
 * even when nothing changed. Instead we hash the fields that actually affect a
 * recommendation:
 *   - canonical_player_id  (identity)
 *   - nfl_team             (bye/opponent, roster legality)
 *   - position + eligible_positions (slot eligibility)
 *   - injury_status + status (availability)
 *   - is_team_defense
 *
 * Names, first/last, and the raw `identifiers` crosswalk are deliberately
 * excluded — a name spelling fix or a new espn_id alias does not change any
 * recommendation. `resolution.method`/`confidence` is included because a player
 * flipping from `stable_id` to `unresolved` DOES matter.
 */

import { createHash } from "node:crypto";
import type { CanonicalPlayer } from "./schema";

export const PLAYER_DATA_VERSION_ALGO = "v1" as const;

export function playerDataVersion(players: readonly CanonicalPlayer[]): string {
  const rows = players
    .map((p) => [
      p.canonical_player_id,
      p.nfl_team ?? "",
      p.position,
      [...p.eligible_positions].sort().join(","),
      p.injury_status ?? "",
      p.status ?? "",
      p.is_team_defense ? "1" : "0",
      p.resolution.method,
    ].join(""))
    .sort();
  const digest = createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 16);
  return `players:${PLAYER_DATA_VERSION_ALGO}:${digest}`;
}
