/**
 * GET /api/cron/weekly-audit — Phase 9 idempotent post-week audit job.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` (same convention as every other bridge cron). Server-only: no public
 * route can create outcome rows, an audit record, or a freshness-history row — writing happens ONLY inside
 * `buildWeeklyModelAudit({ write: true })`, which itself refuses to write unless the target week is `WEEK_COMPLETE`
 * (evidence-based, never "it's Tuesday").
 *
 * Idempotent: `audit_id` is a deterministic hash of the evidence, not a timestamp, so a repeated run over
 * unchanged evidence inserts nothing new (every underlying write uses `insertIgnoreDuplicates`). It checks the
 * PREVIOUS NFL week (current week's games are still in progress by construction) across every configured league,
 * building one shared `rawScoringByFingerprint` map so scoring is never re-derived per player.
 */
import { authorizeSecret } from "@/lib/http-auth";
import { handleOptions, jsonResponse } from "@/lib/http";
import { listLeagueTargets, leagueConfigStatus } from "@/lib/leagues/registry";
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { getNflState } from "@/lib/sleeper/client";
import { buildWeeklyModelAudit } from "@/lib/weekly-audit/build";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeSecret(request, "CRON_SECRET");
  if (!auth.ok) return jsonResponse({ ok: false, code: auth.code, detail: auth.detail }, { status: auth.status, headers: { "Cache-Control": "no-store" } });

  const url = new URL(request.url);
  const state = await getNflState().catch(() => null);
  const season = Number(url.searchParams.get("season") ?? state?.season ?? new Date().getFullYear());
  // Default target = the week BEFORE the provider's nominal current week: that week's games are the ones most
  // likely to already be complete. `buildWeeklyModelAudit` independently re-verifies closure via the real NFL
  // reality frontier and refuses to write if it is not actually WEEK_COMPLETE — this is only a starting guess.
  const week = Number(url.searchParams.get("week") ?? Math.max(1, (state?.week ?? 2) - 1));
  const write = url.searchParams.get("dry_run") !== "1";

  const rawScoringByFingerprint = new Map<string, Record<string, number>>();
  const leagueStatus: Array<{ league_slug: string; ok: boolean; scoring_fingerprint: string | null }> = [];
  for (const t of listLeagueTargets().filter((x) => x.provider === "sleeper" && leagueConfigStatus(x) === "READY")) {
    try {
      const st = await buildCanonicalLeagueState(t.key, { reportPersistence: false });
      const fp = st.snapshot?.league.scoring_fingerprint ?? null;
      if (st.snapshot && fp) { rawScoringByFingerprint.set(fp, st.snapshot.league.raw_scoring); leagueStatus.push({ league_slug: t.key, ok: true, scoring_fingerprint: fp }); }
      else leagueStatus.push({ league_slug: t.key, ok: false, scoring_fingerprint: null });
    } catch {
      leagueStatus.push({ league_slug: t.key, ok: false, scoring_fingerprint: null });
    }
  }

  const startedAt = new Date().toISOString();
  const audit = await buildWeeklyModelAudit({ season, week, rawScoringByFingerprint, write });
  return jsonResponse({
    ok: audit.severity !== "BLOCKING_DATA_QUALITY", audit_id: audit.audit_id, status: audit.status, severity: audit.severity,
    season, week, write_attempted: write, started_at: startedAt, finished_at: new Date().toISOString(), leagues: leagueStatus,
    week_closure: audit.week_closure, data_quality_findings: audit.data_quality.length,
  }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
