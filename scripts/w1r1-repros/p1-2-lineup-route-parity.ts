/**
 * W1.R1 P1-2 reproduction: the REAL `/api/lineup` route handler vs the REAL `/api/intelligence` builder, same league/manager/week/evidence.
 * The route module is imported unmodified; only `buildWeeklyTeamContext` is wrapped (via node's module mock) so it receives the golden
 * provider overrides the route cannot pass itself. Runs unchanged on 65a04f4 (disagreement) and on the fixed tree (parity).
 * Run:  node --experimental-test-module-mocks --import tsx scripts/w1r1-repros/p1-2-lineup-route-parity.ts
 */
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { setPersistence, memoryPersistence } from "../../lib/persistence";
import { PlayerCrosswalk, NoCrosswalk } from "../../lib/canonical/players";
import { goldenProvider, goldenProjectionProvider, goldenSchedule } from "../../test/fixtures/canonical-forecast-golden";

const ROOT = resolve(__dirname, "../..");
const ctxUrl = pathToFileURL(resolve(ROOT, "lib/weekly/context.ts")).href;

(async () => {
  setPersistence(memoryPersistence());
  const real = await import(ctxUrl);
  const withGolden = (slug: string, mgr: string, options: Record<string, unknown> = {}) =>
    real.buildWeeklyTeamContext(slug, mgr, {
      ...options,
      providerOverride: goldenProvider(),
      projectionProviderOverride: goldenProjectionProvider(),
      scheduleProviderOverride: goldenSchedule,
      riSeasonProviderOverride: null,
      crosswalkOverride: new PlayerCrosswalk(NoCrosswalk),
      skipReturnGameEnrichment: true,
    });
  mock.module(ctxUrl, { namedExports: { ...real, buildWeeklyTeamContext: withGolden } });

  const { GET } = await import(pathToFileURL(resolve(ROOT, "app/api/lineup/[league]/[manager]/week/[week]/route.ts")).href);
  const { buildWeeklyIntelligence } = await import(pathToFileURL(resolve(ROOT, "lib/weekly/intelligence.ts")).href);

  const res: Response = await GET(new Request("http://x/api/lineup/bloodline-bowl/supyo29/week/5"), { params: Promise.resolve({ league: "bloodline-bowl", manager: "supyo29", week: "5" }) });
  const body = (await res.json()) as { data?: { lineup?: { slots: Array<{ slot: string; recommended_player_id: string | null }> } } };
  const intel = await buildWeeklyIntelligence("bloodline-bowl", "supyo29", { week: 5 });
  const slots = (l: { slots: Array<{ slot: string; recommended_player_id: string | null }> } | undefined) => (l?.slots ?? []).map((s) => `${s.slot}:${s.recommended_player_id}`);
  const route = slots(body.data?.lineup);
  const intelligence = slots(intel.intelligence?.lineup);
  const injured = ["g-wr-out", "g-rb-ir"];
  console.log(JSON.stringify({
    p1: "P1-2",
    route_status: res.status,
    route_lineup: route,
    intelligence_lineup: intelligence,
    endpoints_agree: JSON.stringify(route) === JSON.stringify(intelligence),
    route_starts_OUT_or_IR_player: route.some((x) => injured.some((i) => x.endsWith(i))),
    intelligence_starts_OUT_or_IR_player: intelligence.some((x) => injured.some((i) => x.endsWith(i))),
  }));
})().catch((e) => { console.error(e); process.exit(1); });
