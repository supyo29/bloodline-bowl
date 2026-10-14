/** TEMPORARY, preview-only, read-only: Yahoo 2025 team-DEF weekly stat lines (stat_id -> value) to resolve Yahoo D/ST scoring semantics. Removed right after use. 2025 only (never 2026). */
import { defaultYahooMarketIO } from "@/lib/market-state/yahoo-load";
export const dynamic = "force-dynamic"; export const runtime = "nodejs"; export const maxDuration = 120;
type J = Record<string, unknown>;
function walk(o: unknown, out: Array<{ name: string | null; team: string | null; stats: Record<string, string> }>): void {
  if (Array.isArray(o)) { for (const x of o) walk(x, out); return; }
  if (!o || typeof o !== "object") return;
  const j = o as J;
  if (Array.isArray(j.player)) {
    const meta: J = {}; let stats: Record<string, string> = {};
    for (const part of j.player as unknown[]) {
      if (Array.isArray(part)) for (const m of part) if (m && typeof m === "object") Object.assign(meta, m);
      else if (part && typeof part === "object" && (part as J).player_stats) { const st = ((part as J).player_stats as unknown as J).stats as unknown as unknown[]; for (const s of st ?? []) { const x = (s as J).stat as unknown as J | undefined; if (x) stats[String(x.stat_id)] = String(x.value); } }
    }
    const nm = ((meta.name as unknown as J | undefined)?.full) as string | undefined; out.push({ name: nm ?? null, team: (meta.editorial_team_abbr as string | undefined) ?? null, stats }); return;
  }
  for (const v of Object.values(j)) walk(v, out);
}
export async function GET(request: Request): Promise<Response> {
  if (process.env.VERCEL_ENV !== "preview") return new Response("Not Found", { status: 404 });
  const q = new URL(request.url).searchParams; const week = Number(q.get("week") ?? "0"); if (!(week >= 1 && week <= 17)) return new Response("bad week", { status: 400 });
  const o = await defaultYahooMarketIO.open("maclin-on-chicks-xvi"); if (!o.ok) return Response.json({ error: o.code });
  const rows: Array<{ name: string | null; team: string | null; stats: Record<string, string> }> = [];
  for (const start of [0, 25]) { const { data } = await o.handle.client.get(`/game/461/players;position=DEF;start=${start};count=25/stats;type=week;week=${week}`); walk(data, rows); }
  return Response.json({ week, n: rows.length, rows });
}
