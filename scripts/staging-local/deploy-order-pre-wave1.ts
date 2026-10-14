/**
 * DEPLOY-ORDER TEST (local only): the Wave 1 CODE running against the PRE-Wave-1 schema (what production has today: last applied 20260930180000-equivalent).
 * Question: if Wave 1 were merged/deployed BEFORE its two migrations are applied, does a decision request degrade visibly or break?
 */
import { check, finish, info, sql } from "./lib";
import { buildCanonicalLeagueState } from "../../lib/canonical/state";
import { buildWeeklyTeamContext } from "../../lib/weekly/context";
import { buildWaiverRecommendations } from "../../lib/weekly/waivers";

async function main(): Promise<void> {
  const tables = sql("select string_agg(relname, ',' order by relname) from pg_class where relname like 'bridge_final_pregame%' or relname like 'bridge_projection_source%'");
  info("D", "Wave 1 tables present in the pre-Wave-1 schema", { tables: tables || "(none)" });
  await check("D", "precondition: the Wave 1 tables are absent (production-equivalent schema)", async () => ({ ok: !tables, detail: tables }));
  const t0 = Date.now();
  const st = await buildCanonicalLeagueState("bloodline-bowl", { reportPersistence: false });
  const mgr = st.snapshot!.managers[0]!;
  let ctx; let err: string | null = null;
  try { ctx = (await buildWeeklyTeamContext("bloodline-bowl", mgr.manager_slug, { snapshotOverride: st.snapshot! })).context; } catch (e) { err = e instanceof Error ? e.message.slice(0, 300) : String(e); }
  info("D", "context build against the pre-Wave-1 schema", { ms: Date.now() - t0, threw: err, forecasts: ctx?.forecasts?.by_player.size ?? null, final_pregame_capture: ctx?.final_pregame_capture, freshness: ctx?.forecasts?.identity ? "identity present" : "no identity", warnings: ctx?.warnings?.map((w) => `${w.severity}:${w.code}`).slice(0, 12) });
  await check("D", "the decision request still SUCCEEDS (forecasts served) with the Wave 1 tables missing", async () => ({ ok: !err && !!ctx?.forecasts && ctx.forecasts.by_player.size > 300, detail: { threw: err, forecasts: ctx?.forecasts?.by_player.size } }));
  await check("D", "the failure is VISIBLE, not silent: the final-pregame capture reports a failure/not-captured status and a warning", async () => ({ ok: !!ctx && ctx.final_pregame_capture?.status !== "CAPTURED" && (ctx.warnings ?? []).some((w) => /final_pregame_capture|freshness|observation/.test(w.code)), detail: { status: ctx?.final_pregame_capture?.status, error: ctx?.final_pregame_capture?.error, codes: ctx?.warnings?.map((w) => w.code) } }));
  if (ctx) { const w = buildWaiverRecommendations(ctx) as unknown as { availability_status?: string }; info("D", "waiver endpoint still fail-closed", { availability_status: w.availability_status }); }
  finish("docs/evidence/w2p2-local-staging-deploy-order.json");
}
main().catch((e) => { console.error(e); process.exit(2); });
