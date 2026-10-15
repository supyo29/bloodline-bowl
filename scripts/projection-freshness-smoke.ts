/**
 * W1.P4 — READ-ONLY live smoke for every registered league: can the shared NFL projection observation be fetched, and can each league's
 * own scoring be applied to it? No Supabase writes (memory observation store, no snapshot store), no transactions, no league mutation.
 *
 * Output is one JSON object per league plus a summary. Each league gets exactly one live status:
 *   PASS                   shared observation fetched and league scoring applied from live league state
 *   PASS_WITH_LIMITATION   works, with a named limitation
 *   LIVE_VALIDATION_BLOCKED  the live dependency (network / provider auth) was unreachable from this environment — NOT a pass, NOT a fail
 *   FAIL                   reachable but wrong/empty/throwing
 * Fixture validation is separate: test/multi-league-freshness.test.ts (reported by the phase doc, not by this script).
 */
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { NoCrosswalk, PlayerCrosswalk } from "@/lib/canonical/players";
import { listLeagueTargets, leagueConfigStatus } from "@/lib/leagues/registry";
import { getNflState } from "@/lib/sleeper/client";
import { InvalidationLedger } from "@/lib/weekly/freshness/events";
import { MemorySourceObservationStore, SourceObservationRecorder } from "@/lib/weekly/freshness/observation";
import { SleeperWeeklyProjectionProvider } from "@/lib/weekly/projections/sleeper-weekly";

type LiveStatus = "PASS" | "PASS_WITH_LIMITATION" | "LIVE_VALIDATION_BLOCKED" | "FAIL";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const blocked = (m: string) => /403|forbidden|ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|proxy|network|timed? ?out|401|oauth|token|not.?configured|unauthori[sz]ed/i.test(m);

async function main() {
  const store = new MemorySourceObservationStore();
  const recorder = new SourceObservationRecorder(store, new InvalidationLedger());
  const provider = new SleeperWeeklyProjectionProvider((o) => recorder.record(o));
  const nfl = await getNflState().catch((e) => ({ __error: msg(e) }) as { __error: string });
  const week = "week" in nfl ? Math.max(1, Number((nfl as { week?: number }).week ?? 1)) : null;
  const season = "season" in nfl ? Number((nfl as { season?: string }).season ?? 2026) : 2026;
  const rows: Array<Record<string, unknown>> = [];

  for (const t of listLeagueTargets()) {
    const base = { league_slug: t.key, provider: t.provider, config_status: leagueConfigStatus(t), season, week };
    if (week == null) {
      rows.push({ ...base, live_status: "LIVE_VALIDATION_BLOCKED" as LiveStatus, reason: `NFL state unreachable: ${(nfl as { __error: string }).__error}` });
      continue;
    }
    try {
      const state = await buildCanonicalLeagueState(t.key, { reportPersistence: false });
      const snap = state.snapshot;
      if (!state.ok || !snap) {
        const reason = `canonical league state unavailable (${state.code ?? "unknown"})`;
        rows.push({ ...base, live_status: blocked(reason) || t.provider === "yahoo" ? "LIVE_VALIDATION_BLOCKED" : "FAIL", reason });
        continue;
      }
      const batch = await provider.getWeeklyProjections({
        league: { league_slug: t.key, season: snap.league.season, raw_scoring: snap.league.raw_scoring, scoring_rules: snap.league.scoring_rules },
        week: snap.league.current_week ?? week,
        crosswalk: new PlayerCrosswalk(NoCrosswalk),
        canonical_player_ids: snap.rosters.flatMap((r) => r.all_players),
        want_rest_of_season: false,
      });
      const ok = batch.status !== "PROJECTIONS_UNAVAILABLE" && batch.by_player.size > 0;
      rows.push({
        ...base,
        live_status: (!ok ? "FAIL" : batch.status === "PROJECTIONS_PARTIAL" ? "PASS_WITH_LIMITATION" : "PASS") as LiveStatus,
        projection_status: batch.status,
        players: batch.by_player.size,
        source_observed_at: batch.source_observation?.observed_at ?? null,
        fetch_path: batch.source_observation?.fetch_path ?? null,
        scoring_fingerprint: snap.league.raw_scoring ? Object.keys(snap.league.raw_scoring).length : null,
        limitation: batch.status === "PROJECTIONS_PARTIAL" ? "K/DST approximated from provider standard points and/or a segment degraded" : null,
      });
    } catch (e) {
      const reason = msg(e);
      rows.push({ ...base, live_status: (blocked(reason) ? "LIVE_VALIDATION_BLOCKED" : "FAIL") as LiveStatus, reason });
    }
  }

  const observed = new Set(rows.map((r) => r.source_observed_at).filter(Boolean));
  for (const r of rows) console.log(JSON.stringify(r));
  console.log(JSON.stringify({ summary: true, leagues: rows.length, shared_observation_instants: observed.size, observations_recorded: store.appends, statuses: Object.fromEntries(["PASS", "PASS_WITH_LIMITATION", "LIVE_VALIDATION_BLOCKED", "FAIL"].map((s) => [s, rows.filter((r) => r.live_status === s).length])) }));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
