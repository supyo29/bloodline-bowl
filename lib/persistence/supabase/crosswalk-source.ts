/**
 * Supabase-backed player identity crosswalk source.
 *
 * Reads the shared `public.nfl_players` table (24k+ rows, one per NFL player /
 * season) which already carries `sleeper_id`, `yahoo_id`, `gsis_id`, `pfr_id`,
 * `espn_id` alongside names/positions/teams. This is a READ-ONLY consumer — the
 * bridge never writes to `nfl_players`.
 *
 * The crosswalk core (`lib/canonical/players.ts`) is store-independent; this is
 * just one `CrosswalkSource` implementation. `NoCrosswalk` is used when Supabase
 * is not configured, so provider ids and names still resolve.
 */

import type { CrosswalkRow, CrosswalkSource } from "@/lib/canonical/players";
import { SupabaseRest, loadSupabaseConfig } from "./rest";

interface NflPlayerRow {
  gsis_id: string | null;
  sleeper_id: string | null;
  yahoo_id: string | null;
  espn_id: string | null;
  pfr_id: string | null;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  latest_team: string | null;
  is_current_player: boolean | null;
}

export class SupabaseCrosswalkSource implements CrosswalkSource {
  readonly name = "supabase:nfl_players";
  #cache: CrosswalkRow[] | null = null;

  constructor(private readonly rest: SupabaseRest) {}

  async load(): Promise<CrosswalkRow[]> {
    if (this.#cache) return this.#cache;
    // Only rows with a sleeper OR yahoo id are useful for a fantasy crosswalk.
    const rows = await this.rest.select<NflPlayerRow>("nfl_players", {
      select:
        "gsis_id,sleeper_id,yahoo_id,espn_id,pfr_id,display_name,first_name,last_name,position,latest_team,is_current_player",
      order: "is_current_player.desc",
      limit: 30000,
    });
    this.#cache = rows
      .filter((r) => r.sleeper_id || r.yahoo_id)
      .map(
        (r): CrosswalkRow => ({
          gsis_id: r.gsis_id,
          sleeper_id: r.sleeper_id,
          yahoo_id: r.yahoo_id,
          espn_id: r.espn_id,
          pfr_id: r.pfr_id,
          full_name:
            r.display_name ??
            ([r.first_name, r.last_name].filter(Boolean).join(" ").trim() || "Unknown"),
          position: r.position,
          nfl_team: r.latest_team,
        }),
      );
    return this.#cache;
  }
}

/** Build the best available crosswalk source for the current environment. */
export function defaultCrosswalkSource(env: NodeJS.ProcessEnv = process.env): CrosswalkSource | null {
  const cfg = loadSupabaseConfig(env);
  if (!cfg.configured || !cfg.config) return null;
  return new SupabaseCrosswalkSource(new SupabaseRest(cfg.config));
}
