/**
 * W1.R2 / P1-A repro: a final-pregame capture built from a FRESH network fetch, through the REAL buildWeeklyTeamContext and the REAL
 * CanonicalProjectionSnapshotProvider (no injected composition clock). The live provider stamps `observed_at` when its response ARRIVES, exactly
 * as lib/sleeper/client.ts does (`fetchedAt = Date.now()` after the response). Prints the timing and the final-pregame write decisions.
 * Run: node --import tsx scripts/w1r2-repros/p1-a-live-fetch-final-pregame.ts
 */
import { buildWeeklyTeamContext } from "../../lib/weekly/context";
import { PlayerCrosswalk, NoCrosswalk } from "../../lib/canonical/players";
import { setPersistence, memoryPersistence } from "../../lib/persistence";
import { CanonicalProjectionSnapshotProvider } from "../../lib/weekly/projections/canonical-provider";
import { MemoryFinalPregameStore, type FinalPregameStore } from "../../lib/weekly/freshness/final-pregame";
import { goldenProvider, goldenProjectionProvider, goldenSchedule } from "../../test/fixtures/canonical-forecast-golden";
import type { ProjectionProvider } from "../../lib/weekly/projections/types";

const LATENCY_MS = 25;

export function liveLikeProvider(mode: "network" | "cache", kickoffMs: number): { provider: ProjectionProvider; fetchStartedAt: () => string | null } {
  const inner = goldenProjectionProvider();
  const cachedAt = new Date(Date.now() - 60_000).toISOString();
  let started: string | null = null;
  void kickoffMs;
  return {
    fetchStartedAt: () => started,
    provider: {
      name: inner.name, model_version: inner.model_version,
      async getWeeklyProjections(req) {
        started = new Date().toISOString();
        const b = await inner.getWeeklyProjections(req);
        if (mode === "network") await new Promise((r) => setTimeout(r, LATENCY_MS)); // the network round trip
        const observed_at = mode === "network" ? new Date(Date.now()).toISOString() : cachedAt; // stamped on ARRIVAL, like the real client
        return { ...b, status: "READY", source_observation: { provider: "sleeper", observed_at, observation_id: `srcobs:${mode}0000000000000`.slice(0, 27), content_hash: "h", fetch_path: mode === "network" ? "LIVE_FETCH" : "PROCESS_CACHE" } as never };
      },
    },
  };
}

const noStore = { kind: "none", durable: false, async readLatest() { return null; }, async record() { return { status: "NOT_CONFIGURED", artifact_id: null, observed_at: null, durable: false }; } } as never;

export async function runOnce(mode: "network" | "cache", policy: "refresh" | "prefer") {
  setPersistence(memoryPersistence());
  const kickoffMs = Date.now() + 2 * 3600_000;
  const kickoffSource = { name: "fixture", async getWeekGames() { return ["KC", "MIA", "SF", "OPP", "BUF", "DAL", "PHI", "NYJ"].map((t, i) => ({ game_id: `g${i}`, home_team: t, away_team: `X${i}`, kickoff_at: new Date(kickoffMs).toISOString(), status: "pre_game" })); } };
  const store = new MemoryFinalPregameStore();
  const counts: Record<string, number> = {};
  const wrapped: FinalPregameStore = Object.assign(Object.create(store), {
    upsertMany: async (recs: Parameters<FinalPregameStore["upsertMany"]>[0]) => { const c = await store.upsertMany(recs); for (const [k, v] of Object.entries(c)) if (v) counts[k] = (counts[k] ?? 0) + v; return c; },
  });
  const live = liveLikeProvider(mode, kickoffMs);
  const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
    week: 5, providerOverride: goldenProvider(), scheduleProviderOverride: goldenSchedule, riSeasonProviderOverride: null, crosswalkOverride: new PlayerCrosswalk(NoCrosswalk), skipReturnGameEnrichment: true,
    projectionProviderOverride: new CanonicalProjectionSnapshotProvider(live.provider, noStore, { kickoffSource }),
    projectionSnapshotPolicy: policy, finalPregameStoreOverride: wrapped,
  } as never);
  const ctx = r.context!;
  const f = [...ctx.forecasts!.by_player.values()][0]!;
  return {
    mode, policy,
    fetch_started_at: live.fetchStartedAt(),
    source_observed_at: f.freshness.source_observed_at,
    composed_at: f.freshness.forecast_composed_at,
    observed_le_composed: Date.parse(f.freshness.source_observed_at!) <= Date.parse(f.freshness.forecast_composed_at!),
    write_counts: counts,
    revisions_recorded: store.revisionCount(),
    capture: (ctx as unknown as { final_pregame_capture?: unknown }).final_pregame_capture ?? "(not reported)",
  };
}

if (process.argv[1]?.endsWith("p1-a-live-fetch-final-pregame.ts")) {
  (async () => {
    for (const mode of ["network", "cache"] as const) for (const policy of ["refresh", "prefer"] as const) console.log(JSON.stringify(await runOnce(mode, policy)));
  })();
}
