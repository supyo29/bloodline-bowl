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
import { addReport, compareReport, dropReport, envelope, findPlayer, kdstReport, playerReport, rosterReport } from "@/lib/w2r1/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const VIEWS = new Set(["roster", "player", "drop", "add", "kdst", "compare"]);

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
  const result = await runWithWeeklyContext(league, manager, { week, enableMarketStatePool: true }, (ctx) => {
    const t1 = Date.now(); const inp = buildEarlyInputs(ctx); const adapterMs = Date.now() - t1;
    let data: unknown;
    if (view === "roster") data = rosterReport(ctx, inp);
    else if (view === "kdst") data = kdstReport(ctx, inp);
    else if (view === "add") data = addReport(ctx, inp, limit);
    else if (view === "compare") data = compareReport(ctx, inp);
    else {
      const f = findPlayer(inp, player as string);
      if (!f.ok) return { ambiguous: true as const, matches: f.matches };
      data = view === "player" ? playerReport(ctx, inp, f.id) : dropReport(ctx, inp, f.id);
    }
    return { ambiguous: false as const, body: envelope(ctx, inp, view, data), adapter_ms: adapterMs, excluded: inp.excluded.length };
  });
  if (!result.data) return errorResponse(result.status, result.code ?? "weekly_context_unavailable", result.detail);
  const d = result.data;
  if (d.ambiguous) return jsonResponse({ error: "player_not_found_or_ambiguous", matches: d.matches }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return jsonResponse({ ...d.body, timing: { total_ms: Date.now() - t0, adapter_ms: d.adapter_ms }, context: result.context_meta ? { status: result.context_meta.status, lineage: result.context_meta.lineage?.snapshot ?? null } : null }, { headers: { "Cache-Control": "no-store", "X-W2R1": "EARLY-SHADOW" } });
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
