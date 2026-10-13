/**
 * W2.P2 — production wiring for the scheduled Role Shadow capture. This is the ONLY place the research module meets the production context
 * builder, and it only READS: it builds the same weekly context any request would build (read-only toward fantasy platforms), hands the resulting
 * canonical forecasts to the pure capture module, and writes independent research rows. Gated by `ROLE_SHADOW_CAPTURE=1`; the route that calls it
 * authenticates with CRON_SECRET. Sleeper leagues only: Yahoo weekly forecasts are not part of this evidence (see the certification report).
 */
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { buildWeeklyTeamContext } from "@/lib/weekly/context";
import { listLeagueTargets, leagueConfigStatus } from "@/lib/leagues/registry";
import { buildWeekForecasts } from "@/lib/role-calibration/forecast-week";
import { runRoleShadowCapture, type LeagueLoadFailure, type LeagueWeekInput, type RoleForecastLike, type RunSummary } from "@/lib/role-shadow/capture";
import type { RoleShadowStore } from "@/lib/role-shadow/store";
import { loadSupabaseConfig, SupabaseRest } from "./rest";
import { SupabaseRoleShadowStore } from "./role-shadow-store";

export function resolveRoleShadowStore(env: NodeJS.ProcessEnv = process.env): RoleShadowStore | null {
  const cfg = loadSupabaseConfig(env);
  return cfg.configured && cfg.config ? new SupabaseRoleShadowStore(new SupabaseRest(cfg.config)) : null;
}

export async function loadProductionLeagueWeeks(): Promise<Array<LeagueWeekInput | LeagueLoadFailure>> {
  const out: Array<LeagueWeekInput | LeagueLoadFailure> = [];
  for (const t of listLeagueTargets().filter((x) => x.provider === "sleeper" && leagueConfigStatus(x) === "READY")) {
    try {
      const st = await buildCanonicalLeagueState(t.key, { reportPersistence: false });
      const mgr = st.snapshot?.managers[0];
      if (!st.snapshot || !mgr) { out.push({ league_slug: t.key, failure: "no canonical snapshot / manager" }); continue; }
      const res = await buildWeeklyTeamContext(t.key, mgr.manager_slug, { snapshotOverride: st.snapshot });
      const ctx = res.context;
      if (!ctx || !ctx.forecasts) { out.push({ league_slug: t.key, failure: res.code ?? "weekly context unavailable" }); continue; }
      const rostered = new Set(ctx.all_rostered.map((p) => p.canonical_player_id));
      out.push({
        league_slug: t.key, provider: ctx.league.provider, season: ctx.league.season, week: ctx.league.week,
        raw_scoring: ctx.league.raw_scoring, scoring_fingerprint: ctx.forecasts.identity?.scoring_fingerprint ?? st.snapshot.league.scoring_fingerprint ?? null,
        league_snapshot_id: ctx.lineage.snapshot.league_snapshot_id ?? null, forecast_identity_id: ctx.forecasts.identity?.identity_id ?? null,
        forecasts: [...ctx.forecasts.by_player.values()].filter((f) => rostered.has(f.canonical_player_id)),
      });
    } catch (e) {
      out.push({ league_slug: t.key, failure: e instanceof Error ? e.message : "league build failed" });
    }
  }
  return out;
}

/** Live-frozen Role forecasts: per-player, only games whose kickoff is still in the future at `nowMs`. */
export async function loadLiveRoleForecasts(season: number, week: number, nowMs: number): Promise<RoleForecastLike[]> {
  const r = await buildWeekForecasts({ season, week, captureKind: "LIVE_CAPTURED", nowMs });
  return r.forecasts as RoleForecastLike[];
}

export async function runScheduledRoleShadowCapture(opts: { dryRun?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<RunSummary> {
  const env = opts.env ?? process.env;
  return runRoleShadowCapture({ env, dryRun: opts.dryRun, store: resolveRoleShadowStore(env), loadLeagueWeeks: loadProductionLeagueWeeks, loadRoleForecasts: loadLiveRoleForecasts });
}
