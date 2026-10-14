/**
 * GET /api/w2r1/{league}/{manager}/{view}?week=&player=&limit=
 *
 * W2.R1 EARLY SHADOW — DIAGNOSTIC. Read-only; builds the SAME canonical weekly context production uses, then runs the S1-S3 mechanics over it.
 * views: roster | player | drop | add | kdst | compare.  Never served from a Vercel production deployment. No production decision is read or changed.
 */
import { runWithWeeklyContext } from "@/lib/weekly/intelligence";
import { jsonResponse, errorResponse, handleOptions } from "@/lib/http";
import { w2r1Enabled } from "@/lib/w2r1/guard";
import { buildEarlyInputs } from "@/lib/w2r1/adapter";
import { addReport, compareReport, dropReport, envelope, findPlayer, kdstReport, playerReport, rosterReport, upsideReport, withQualifiedDst } from "@/lib/w2r1/live";
import { KDST_LOADERS, UPSIDE_LOADERS } from "@/lib/w2r1/data/prospective";
import type { KdstCapture } from "@/lib/w2r1/dst-live";
import type { UpsideCapture } from "@/lib/w2r1/upside-live";
import { qualificationSummary } from "@/lib/w2r1/qualification";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const VIEWS = new Set(["roster", "player", "drop", "add", "kdst", "compare", "dst", "upside", "qualification"]);

export async function GET(request: Request, { params }: { params: Promise<{ league: string; manager: string; view: string }> }): Promise<Response> {
  if (!w2r1Enabled()) return new Response("Not Found", { status: 404 });
  const { league, manager, view } = await params;
  if (!VIEWS.has(view)) return errorResponse(404, "unknown_w2r1_view", `view must be one of ${[...VIEWS].join(", ")}`);
  const q = new URL(request.url).searchParams;
  const weekRaw = q.get("week"); const week = weekRaw ? Number.parseInt(weekRaw, 10) : undefined;
  if (weekRaw && (!Number.isInteger(week) || (week as number) < 1 || (week as number) > 22)) return errorResponse(400, "invalid_week", "week must be an integer 1..22.");
  const player = q.get("player"); const limit = Math.min(25, Math.max(1, Number.parseInt(q.get("limit") ?? "10", 10) || 10));
  if ((view === "player" || view === "drop") && !player) return errorResponse(400, "player_required", "pass ?player=<canonical id or name>");

  const t0 = Date.now();
  const kdstCaps = new Map<number, KdstCapture>(); const upCaps = new Map<number, UpsideCapture>();
  await Promise.all([...Object.entries(KDST_LOADERS)].map(async ([w, l]) => { kdstCaps.set(Number(w), await l()); }));
  await Promise.all([...Object.entries(UPSIDE_LOADERS)].map(async ([w, l]) => { upCaps.set(Number(w), await l()); }));
  const result = await runWithWeeklyContext(league, manager, { week, enableMarketStatePool: true }, (ctx) => {
    const t1 = Date.now(); const cap = kdstCaps.get(ctx.league.week) ?? null; const inp0 = buildEarlyInputs(ctx); const { inp, replaced } = withQualifiedDst(inp0, cap, ctx.league.slug, ctx.league.week); const adapterMs = Date.now() - t1;
    let data: unknown; const t2 = Date.now();
    if (view === "roster") data = rosterReport(ctx, inp);
    else if (view === "kdst" || view === "dst") data = { ...kdstReport(ctx, inp, cap), qualified_dst_values_applied: replaced };
    else if (view === "upside") data = upsideReport(ctx, inp, upCaps.get(ctx.league.week) ?? null, q.get("pos"), limit);
    else if (view === "qualification") data = qualificationSummary(ctx.league.slug);
    else if (view === "add") data = addReport(ctx, inp, limit);
    else if (view === "compare") data = compareReport(ctx, inp);
    else {
      const f = findPlayer(inp, player as string);
      if (!f.ok) return { ambiguous: true as const, matches: f.matches };
      data = view === "player" ? playerReport(ctx, inp, f.id) : dropReport(ctx, inp, f.id);
    }
    return { ambiguous: false as const, body: envelope(ctx, inp, view, data), adapter_ms: adapterMs, compute_ms: Date.now() - t2, excluded: inp.excluded.length };
  });
  if (!result.data) return errorResponse(result.status, result.code ?? "weekly_context_unavailable", result.detail);
  const d = result.data;
  if (d.ambiguous) return jsonResponse({ error: "player_not_found_or_ambiguous", matches: d.matches }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return jsonResponse({ ...d.body, timing: { total_ms: Date.now() - t0, context_ms: Math.max(0, Date.now() - t0 - d.adapter_ms - d.compute_ms), adapter_ms: d.adapter_ms, compute_ms: d.compute_ms }, context: result.context_meta ? { status: result.context_meta.status, lineage: result.context_meta.lineage?.snapshot ?? null } : null }, { headers: { "Cache-Control": "no-store", "X-W2R1": "EARLY-SHADOW" } });
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
