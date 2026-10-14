/** TEMPORARY, preview-only, read-only: dump Yahoo stat categories (name, position_type) for NON-ZERO scoring modifiers to resolve K/DST scoring semantics. Removed right after use. */
import { defaultYahooMarketIO } from "@/lib/market-state/yahoo-load";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  if (process.env.VERCEL_ENV !== "preview") return new Response("Not Found", { status: 404 });
  const slug = new URL(request.url).searchParams.get("league") ?? "";
  if (!["maclin-on-chicks-xvi", "rogers-park"].includes(slug)) return new Response("bad league", { status: 400 });
  const o = await defaultYahooMarketIO.open(slug); if (!o.ok) return Response.json({ error: o.code });
  const s = await defaultYahooMarketIO.settings(o.handle);
  const cat = new Map(s.stat_categories.map((c) => [String(c.stat_id), c]));
  const rows = s.stat_modifiers.filter((m) => m.value !== 0).map((m) => { const c = cat.get(String(m.stat_id)); return { stat_id: String(m.stat_id), name: c?.name ?? null, display_name: c?.display_name ?? null, position_type: c?.position_type ?? null, value: m.value }; });
  return Response.json({ slug, n_modifiers: rows.length, rows });
}
