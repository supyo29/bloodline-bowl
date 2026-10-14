/** TEMPORARY, preview-only, read-only: raw Yahoo 2025 team-DEF weekly stat response (parsed offline). Removed right after use. 2025 only (never 2026). */
import { defaultYahooMarketIO } from "@/lib/market-state/yahoo-load";
export const dynamic = "force-dynamic"; export const runtime = "nodejs"; export const maxDuration = 120;
export async function GET(request: Request): Promise<Response> {
  if (process.env.VERCEL_ENV !== "preview") return new Response("Not Found", { status: 404 });
  const q = new URL(request.url).searchParams; const week = Number(q.get("week") ?? "0"); const start = Number(q.get("start") ?? "0");
  if (!(week >= 1 && week <= 17) || ![0, 25].includes(start)) return new Response("bad args", { status: 400 });
  const o = await defaultYahooMarketIO.open("maclin-on-chicks-xvi"); if (!o.ok) return Response.json({ error: o.code });
  const { data } = await o.handle.client.get(`/game/461/players;position=DEF;start=${start};count=25/stats;type=week;week=${week}`);
  return Response.json(data);
}
