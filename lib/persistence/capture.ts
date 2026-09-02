/**
 * Reusable capture + sync logic.
 *
 * `captureLeagueState` and `syncLeagueTransactions` contain ALL the work. The
 * CLI (`scripts/capture-snapshot.ts`) and a future Vercel Cron / API job are
 * just thin callers — no capture logic lives in a route handler or a script.
 *
 * Both are safe to run repeatedly on overlapping windows:
 *   - snapshots dedupe on content hash (immutable versioning)
 *   - the ledger dedupes on (league, season, provider, provider_transaction_id)
 */

import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { getProvider } from "@/lib/providers/registry";
import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import { resolveLeagueStrict } from "@/lib/leagues/resolve";
import { defaultCrosswalkSource } from "./supabase/crosswalk-source";
import { getPersistence } from "./index";
import type { CaptureType, PersistenceBundle } from "./types";
import type { CanonicalTransaction } from "@/lib/canonical/schema";

export interface CaptureOptions {
  capture_type?: CaptureType;
  trigger?: "CLI" | "CRON" | "API" | "TEST";
  persistence?: PersistenceBundle;
}

export interface CaptureLeagueStateResult {
  ok: boolean;
  league_slug: string;
  week: number | null;
  snapshot_outcome: "created" | "duplicate" | "error" | "skipped";
  snapshot_id: string | null;
  persistence_status: string;
  live_provider_status: string;
  warnings: string[];
  error?: string;
}

export async function captureLeagueState(
  leagueSlug: string,
  options: CaptureOptions = {},
): Promise<CaptureLeagueStateResult> {
  const persistence = options.persistence ?? getPersistence();
  const captureType = options.capture_type ?? "AD_HOC";
  const runId = await persistence.runs.start({
    league_slug: leagueSlug,
    run_type: "SNAPSHOT",
    trigger: options.trigger ?? "CLI",
  });

  const state = await buildCanonicalLeagueState(leagueSlug, {
    includeMatchups: true,
    includeRecentTransactions: true,
    reportPersistence: false,
  });

  if (!state.ok || !state.snapshot) {
    await persistence.runs.finish(runId, { status: "ERROR", error: state.detail ?? "state unavailable" });
    return {
      ok: false,
      league_slug: leagueSlug,
      week: null,
      snapshot_outcome: "skipped",
      snapshot_id: null,
      persistence_status: await persistence.snapshots.status(),
      live_provider_status: state.snapshot?.live_provider_status ?? "PROVIDER_ERROR",
      warnings: [],
      error: state.detail ?? "Could not build canonical league state.",
    };
  }

  const put = await persistence.snapshots.put(state.snapshot, {
    capture_type: captureType,
    capture_run_id: runId,
  });

  const warnings = state.snapshot.warnings.map((w) => `${w.code}: ${w.message}`);
  if (put.outcome === "error") warnings.push(`snapshot_put_failed: ${put.error ?? "unknown"}`);

  await persistence.runs.finish(runId, {
    status: put.outcome === "error" ? "ERROR" : "OK",
    snapshots_written: put.outcome === "created" ? 1 : 0,
    warnings,
    error: put.error ?? null,
  });

  return {
    ok: put.outcome !== "error",
    league_slug: leagueSlug,
    week: state.snapshot.week,
    snapshot_outcome: put.outcome,
    snapshot_id: put.meta?.id ?? null,
    persistence_status: put.status,
    live_provider_status: state.snapshot.live_provider_status,
    warnings,
    error: put.error,
  };
}

export interface SyncTransactionsResult {
  ok: boolean;
  league_slug: string;
  season: number;
  seen: number;
  inserted: number;
  duplicates: number;
  persistence_status: string;
  warnings: string[];
  error?: string;
}

export async function syncLeagueTransactions(
  leagueSlug: string,
  options: CaptureOptions & { week?: number | null } = {},
): Promise<SyncTransactionsResult> {
  const persistence = options.persistence ?? getPersistence();
  const resolution = resolveLeagueStrict(leagueSlug);
  if (!resolution.ok) {
    return {
      ok: false,
      league_slug: leagueSlug,
      season: 0,
      seen: 0,
      inserted: 0,
      duplicates: 0,
      persistence_status: await persistence.ledger.status(),
      warnings: [],
      error: resolution.detail,
    };
  }
  const league = resolution.league;
  const runId = await persistence.runs.start({
    league_slug: leagueSlug,
    run_type: "TRANSACTION_SYNC",
    trigger: options.trigger ?? "CLI",
  });

  const provider = getProvider(league.provider);
  const crosswalk = defaultCrosswalkSource()
    ? new PlayerCrosswalk(defaultCrosswalkSource()!)
    : new PlayerCrosswalk(NoCrosswalk);

  const result = await provider.getTransactions(
    {
      league_slug: league.league_slug,
      external_league_id: league.external_league_id,
      season: league.season,
      crosswalk,
    },
    { week: options.week ?? null },
  );

  if (!result.data) {
    await persistence.runs.finish(runId, { status: "ERROR", error: result.warnings[0]?.message });
    return {
      ok: false,
      league_slug: leagueSlug,
      season: league.season,
      seen: 0,
      inserted: 0,
      duplicates: 0,
      persistence_status: await persistence.ledger.status(),
      warnings: result.warnings.map((w) => w.message),
      error: result.warnings[0]?.message ?? "provider returned no transactions",
    };
  }

  const transactions: CanonicalTransaction[] = result.data;
  const appended = await persistence.ledger.append(transactions);

  const warnings = result.warnings.map((w) => `${w.code}: ${w.message}`);
  if (appended.error) warnings.push(`ledger_append_failed: ${appended.error}`);

  await persistence.runs.finish(runId, {
    status: appended.error ? "ERROR" : "OK",
    transactions_seen: appended.seen,
    transactions_new: appended.inserted,
    warnings,
    error: appended.error ?? null,
  });

  return {
    ok: !appended.error,
    league_slug: leagueSlug,
    season: league.season,
    seen: appended.seen,
    inserted: appended.inserted,
    duplicates: appended.duplicates,
    persistence_status: appended.status,
    warnings,
    error: appended.error,
  };
}
