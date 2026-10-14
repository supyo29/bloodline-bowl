/**
 * Yahoo pending waiver claims — READ ONLY, and only ever for a team the authenticated account OWNS (Yahoo does not expose other managers' claims).
 *
 *   GET /league/{league_key}/transactions;team_key={own_team};type=waiver
 *
 * Visibility is therefore a property of the CONNECTION, not of the league:
 *   - the account owns no team in the league      -> UNAVAILABLE (reason says so); never an empty "no claims" list
 *   - the read fails or the body is not parseable -> UNAVAILABLE (never fabricated as zero claims)
 *   - a parseable response                        -> AVAILABLE with the pending claims of the owned team(s)
 * LIVE STATUS: the owned-team path has not been exercised against Yahoo (neither registered connection owns a team); the parser is fixture-tested only.
 */
import type { YahooFantasyClient } from "./client";
import { YahooApiError } from "./client";
import { fantasyContent, mergeYahooEntity, collectionEntries } from "./parse";
import { parseYahooTransaction } from "./fetch";

export interface PendingClaim { team_key: string; transaction_key: string; add_player_key: string | null; drop_player_key: string | null; bid: number | null }
export type PendingClaimsRead =
  | { visibility: "AVAILABLE"; reason: string; claims: PendingClaim[] }
  | { visibility: "UNAVAILABLE"; reason: string; claims: [] };

export async function readPendingClaims(client: Pick<YahooFantasyClient, "get">, leagueKey: string, ownedTeamKeys: string[]): Promise<PendingClaimsRead> {
  if (ownedTeamKeys.length === 0) return { visibility: "UNAVAILABLE", reason: "the authenticated Yahoo account owns no team in this league; Yahoo exposes pending claims only for an owned team", claims: [] };
  const claims: PendingClaim[] = [];
  for (const teamKey of ownedTeamKeys) {
    try {
      const { data } = await client.get(`/league/${leagueKey}/transactions;team_key=${teamKey};type=waiver`);
      const fc = fantasyContent(data);
      if (!fc) return { visibility: "UNAVAILABLE", reason: "Yahoo's pending-claims response had no fantasy_content", claims: [] };
      const leagueMerged = mergeYahooEntity(fc.league ?? fc.leagues);
      const coll = mergeYahooEntity(leagueMerged.transactions);
      const entries = collectionEntries(coll).length > 0 ? collectionEntries(coll) : collectionEntries(leagueMerged.transactions);
      for (const e of entries) {
        const t = parseYahooTransaction(e);
        if (!t || t.status.toLowerCase() !== "pending") continue;
        claims.push({
          team_key: teamKey, transaction_key: t.transaction_key,
          add_player_key: t.players.find((p) => p.type === "add")?.player_key ?? null,
          drop_player_key: t.players.find((p) => p.type === "drop")?.player_key ?? null,
          bid: t.faab_bid ?? null,
        });
      }
    } catch (err) {
      const kind = err instanceof YahooApiError ? err.kind : "ERROR";
      return { visibility: "UNAVAILABLE", reason: `Yahoo pending-claims read failed (${kind})`, claims: [] };
    }
  }
  return { visibility: "AVAILABLE", reason: `read pending claims for ${ownedTeamKeys.length} owned team(s)`, claims };
}
