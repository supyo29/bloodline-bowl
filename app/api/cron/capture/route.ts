/**
 * GET /api/cron/capture — automated historical capture.
 *
 * Wired to Vercel Cron (see `vercel.json`). Runs the SAME reusable services the
 * CLI uses — `captureLeagueState` + `syncLeagueTransactions` — for every active
 * Sleeper league. Safe to run repeatedly:
 *   - snapshots dedupe on content hash (immutable versioning)
 *   - the ledger dedupes on (league, season, provider, provider_transaction_id)
 *
 * Yahoo leagues are registered but SKIPPED while `config_status` is not READY —
 * no fake snapshots are created before authentication exists.
 *
 * AUTH: Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically
 * when the `CRON_SECRET` env var is set. Manual runs must send the same header.
 * With no `CRON_SECRET` configured the endpoint refuses to run (401) rather
 * than being world-triggerable.
 *
 * FAILURE VISIBILITY: a persistence outage or any per-league failure returns a
 * non-2xx status and logs `[cron:capture]` lines — it never reports success
 * falsely. `PERSISTENCE_NOT_CONFIGURED` is an explicit 503.
 */

import { captureLeagueState, syncLeagueTransactions } from "@/lib/persistence/capture";
import { getPersistence } from "@/lib/persistence";
import { listLeagueTargets, leagueConfigStatus } from "@/lib/leagues/registry";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  // Allow ?secret= for manual curl during activation, constant-time-ish compare.
  const qs = new URL(request.url).searchParams.get("secret");
  return qs != null && qs === secret;
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return errorResponse(
      401,
      "unauthorized",
      process.env.CRON_SECRET
        ? "Missing or invalid Bearer token."
        : "CRON_SECRET is not configured; this endpoint is disabled.",
    );
  }

  const startedAt = new Date().toISOString();
  const persistence = getPersistence();
  const persistenceStatus = await persistence.status().catch(() => "PERSISTENCE_ERROR" as const);

  if (persistenceStatus !== "READY") {
    console.error(
      `[cron:capture] persistence=${persistenceStatus} — nothing captured. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.`,
    );
    return jsonResponse(
      {
        ok: false,
        status: persistenceStatus,
        started_at: startedAt,
        detail: "Persistence is not available. No snapshots or transactions were written.",
        results: [],
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const activeSleeper = listLeagueTargets().filter(
    (t) => t.provider === "sleeper" && leagueConfigStatus(t) === "READY",
  );
  const skipped = listLeagueTargets()
    .filter((t) => !(t.provider === "sleeper" && leagueConfigStatus(t) === "READY"))
    .map((t) => ({ league_slug: t.key, provider: t.provider, reason: leagueConfigStatus(t) }));

  const results: unknown[] = [];
  let anyFailure = false;

  for (const target of activeSleeper) {
    const snapshot = await captureLeagueState(target.key, {
      capture_type: "AD_HOC",
      trigger: "CRON",
      persistence,
    });
    const sync = await syncLeagueTransactions(target.key, { trigger: "CRON", persistence });

    if (!snapshot.ok || !sync.ok) anyFailure = true;

    console.log(
      `[cron:capture] ${target.key}: snapshot=${snapshot.snapshot_outcome}` +
        ` (id=${snapshot.snapshot_id ?? "-"}, week=${snapshot.week ?? "?"}, live=${snapshot.live_provider_status})` +
        ` txn seen=${sync.seen} new=${sync.inserted} dup=${sync.duplicates}`,
    );
    for (const w of [...snapshot.warnings, ...sync.warnings]) console.warn(`[cron:capture] ${target.key} ! ${w}`);

    results.push({
      league_slug: target.key,
      snapshot: {
        outcome: snapshot.snapshot_outcome,
        id: snapshot.snapshot_id,
        week: snapshot.week,
        live_provider_status: snapshot.live_provider_status,
        persistence_status: snapshot.persistence_status,
        warnings: snapshot.warnings,
      },
      transactions: {
        seen: sync.seen,
        inserted: sync.inserted,
        duplicates: sync.duplicates,
        persistence_status: sync.persistence_status,
        warnings: sync.warnings,
      },
    });
  }

  return jsonResponse(
    {
      ok: !anyFailure,
      status: anyFailure ? "PARTIAL" : "OK",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      persistence: persistenceStatus,
      captured: activeSleeper.map((t) => t.key),
      skipped,
      results,
    },
    { status: anyFailure ? 500 : 200, headers: { "Cache-Control": "no-store" } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
