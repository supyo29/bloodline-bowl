/**
 * PHASE 5 — vendor the 2026 snake-draft market/ADP sources into the bridge repo.
 *
 *   node scripts/build-market-consensus.mjs
 *
 * Produces `lib/draft/data/market-adp-2026.ts` — a self-contained, timestamped
 * snapshot of every snake-usable market source, crosswalked to Sleeper player
 * ids. NO auction dollar values (Phase 5 §5).
 *
 * Sources (all 2026, all snake-usable):
 *   - Underdog ADP   (Half-PPR, 12-team, 2026-08-24)  — DIRECT_ADP
 *   - Yahoo ADP      (Half-PPR, 12-team, 2026-08-24)  — DIRECT_ADP
 *   - "Published ADP consensus" from the DarthMarker RI board (2026-08-30)
 *                                                     — DIRECT_ADP (pre-merged)
 *   - Sleeper search_rank (retrieved at build time)   — RANKING_PROXY
 *
 * The Underdog/Yahoo rows are lifted from the already-built rosterintel r-api
 * market pipeline (`~/rosterintel/services/r-api/outputs/bloodline_2026/`), which
 * scraped + identity-resolved them; this script re-resolves every row against
 * the live Sleeper player database so the vendored file needs no external repo.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { darthmarker2026 } from "@/lib/bridge/ranking-packs/darthmarker-2026";

const OUT_DIR = join("lib", "draft", "data");
const RI_MARKET = join(
  homedir(),
  "rosterintel/services/r-api/outputs/bloodline_2026/market_data.csv",
);

/* --------------------------------------------------------------- helpers */

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/g;
function normName(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.'`’]/g, "")
    .replace(SUFFIX, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split("\n");
  const hdr = splitCsvLine(lines[0]!);
  return lines.slice(1).map((l) => {
    const v = splitCsvLine(l);
    return Object.fromEntries(hdr.map((h, i) => [h, v[i] ?? ""])) as Record<string, string>;
  });
}
function splitCsvLine(l: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of l) {
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/* --------------------------------------------------------------- sleeper */

interface RawSleeper {
  position?: string | null;
  fantasy_positions?: string[] | null;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  search_rank?: number | null;
  gsis_id?: string | null;
  team?: string | null;
}
interface SourceRow { source: string; type: string; pick: number; format: string; teams: number; date: string }
interface VendoredPlayer {
  sleeper_id: string; name: string; position: string | null; team: string | null;
  search_rank: number | null; sources: SourceRow[];
}

async function fetchSleeperPlayers(): Promise<Record<string, RawSleeper>> {
  const res = await fetch("https://api.sleeper.app/v1/players/nfl");
  if (!res.ok) throw new Error(`Sleeper /players/nfl ${res.status}`);
  return res.json() as Promise<Record<string, RawSleeper>>;
}

/* --------------------------------------------------------------- main */

const POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

async function main(): Promise<void> {
  console.log("Fetching Sleeper player database…");
  const raw = await fetchSleeperPlayers();

  const byGsis = new Map<string, string>();
  const byNamePos = new Map<string, string[]>();
  const searchRank = new Map<string, number>();
  const meta = new Map<string, { name: string; pos: string; team: string | null }>();
  for (const [id, p] of Object.entries(raw)) {
    const pos = p.position === "DEF" ? "DEF" : (p.fantasy_positions?.[0] ?? p.position ?? "");
    if (!POS.has(pos)) continue;
    const nm = normName(p.full_name || `${p.first_name ?? ""} ${p.last_name ?? ""}`);
    meta.set(id, { name: p.full_name ?? nm, pos, team: p.team ?? null });
    if (typeof p.search_rank === "number") searchRank.set(id, p.search_rank);
    if (p.gsis_id) byGsis.set(p.gsis_id, id);
    if (nm) {
      const k = `${nm}|${pos}`;
      if (!byNamePos.has(k)) byNamePos.set(k, []);
      byNamePos.get(k)!.push(id);
    }
  }
  console.log(`  ${meta.size} fantasy-relevant players; ${byGsis.size} with gsis_id`);

  const resolve = (
    gsis: string,
    name: string,
    pos: string,
    team: string | null,
  ): { id: string | null; how: string } => {
    if (gsis && byGsis.has(gsis)) return { id: byGsis.get(gsis)!, how: "gsis" };
    const k = `${normName(name)}|${pos}`;
    const cands = byNamePos.get(k) ?? [];
    if (cands.length === 1) return { id: cands[0]!, how: "name_pos" };
    if (cands.length > 1 && team) {
      const t = cands.filter((c) => meta.get(c)?.team === team);
      if (t.length === 1) return { id: t[0]!, how: "name_pos_team" };
      return { id: null, how: "ambiguous" };
    }
    return { id: null, how: cands.length ? "ambiguous" : "unmatched" };
  };

  const players = new Map<string, VendoredPlayer>();
  const ensure = (id: string): VendoredPlayer => {
    if (!players.has(id)) {
      const m = meta.get(id);
      players.set(id, {
        sleeper_id: id,
        name: m?.name ?? id,
        position: m?.pos ?? null,
        team: m?.team ?? null,
        search_rank: searchRank.get(id) ?? null,
        sources: [],
      });
    }
    return players.get(id)!;
  };

  const audit: {
    total: number; matched: number; ambiguous: number; unmatched: number;
    by_source: Record<string, { matched: number; unmatched: number }>;
  } = { total: 0, matched: 0, ambiguous: 0, unmatched: 0, by_source: {} };

  // (1) Underdog + Yahoo ADP from the rosterintel r-api pipeline
  if (existsSync(RI_MARKET)) {
    const rows = parseCsv(readFileSync(RI_MARKET, "utf8")).filter(
      (r) => r.market_metric === "overall_adp",
    );
    for (const r of rows) {
      const ms = r.market_source ?? "unknown";
      audit.total += 1;
      audit.by_source[ms] ??= { matched: 0, unmatched: 0 };
      const { id } = resolve(
        (r.canonical_player_id ?? "").replace(/^nfl-/, ""),
        r.player_name ?? "",
        r.position ?? "",
        r.team ?? null,
      );
      if (!id) {
        audit.unmatched += 1;
        audit.by_source[ms]!.unmatched += 1;
        continue;
      }
      const pick = Number(r.market_value ?? 0);
      if (!Number.isFinite(pick) || pick <= 0) {
        // pick 0 / blank = the source did not rank this player — not a signal.
        audit.unmatched += 1;
        audit.by_source[ms]!.unmatched += 1;
        continue;
      }
      audit.matched += 1;
      audit.by_source[ms]!.matched += 1;
      ensure(id).sources.push({
        source: ms === "fftoday_underdog_adp" ? "underdog_adp" : ms === "fftoday_yahoo_adp" ? "yahoo_adp" : ms,
        type: "DIRECT_ADP",
        pick,
        format: "half_ppr",
        teams: 12,
        date: "2026-08-24",
      });
    }
  } else {
    console.warn(`  WARNING: ${RI_MARKET} not found — Underdog/Yahoo ADP skipped`);
  }

  // (2) "Published ADP consensus" from the DarthMarker RI board
  {
    const pack = darthmarker2026 as unknown as {
      players: Array<{ adp?: number | null; sleeper_id: string; source_player_id?: string; player: string; position: string; team: string }>;
    };
    for (const p of pack.players) {
      if (p.adp == null || Number(p.adp) <= 0) continue;
      audit.total += 1;
      audit.by_source["published_adp_consensus"] ??= { matched: 0, unmatched: 0 };
      const id = p.sleeper_id && meta.has(p.sleeper_id)
        ? p.sleeper_id
        : resolve((p.source_player_id ?? "").replace(/^nfl-/, ""), p.player, p.position, p.team).id;
      if (!id) { audit.unmatched += 1; audit.by_source["published_adp_consensus"]!.unmatched += 1; continue; }
      audit.matched += 1;
      audit.by_source["published_adp_consensus"]!.matched += 1;
      ensure(id).sources.push({
        source: "published_adp_consensus",
        type: "DIRECT_ADP",
        pick: Number(p.adp),
        format: "consensus",
        teams: 12,
        date: "2026-08-30",
      });
    }
  }

  const list = [...players.values()].filter((p) => p.sources.length > 0);
  list.sort((a, b) => {
    const am = median(a.sources.map((s) => s.pick));
    const bm = median(b.sources.map((s) => s.pick));
    return am - bm;
  });

  console.log(`  vendored ${list.length} players with ≥1 ADP source`);
  console.log(`  identity: ${audit.matched} matched / ${audit.ambiguous} ambiguous / ${audit.unmatched} unmatched of ${audit.total} source rows`);
  console.log(`  by source:`, JSON.stringify(audit.by_source));

  mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    market_consensus_version: "ri-snake-market-2026.1",
    generated_at: new Date().toISOString(),
    league_context: { season: 2026, teams: 12, scoring: "half_ppr", roster: "QB,RB,RB,WR,WR,TE,FLEX,FLEX,K,DEF+5BN" },
    source_catalog: [
      { source: "underdog_adp", type: "DIRECT_ADP", platform: "Underdog (via FFToday)", format: "half_ppr", teams: 12, date: "2026-08-24", snake_usable: true },
      { source: "yahoo_adp", type: "DIRECT_ADP", platform: "Yahoo (via FFToday)", format: "half_ppr", teams: 12, date: "2026-08-24", snake_usable: true },
      { source: "published_adp_consensus", type: "DIRECT_ADP", platform: "RosterIntel board consensus", format: "consensus", teams: 12, date: "2026-08-30", snake_usable: true },
      { source: "sleeper_search_rank", type: "RANKING_PROXY", platform: "Sleeper", format: "n/a", teams: null, date: "build-time", snake_usable: true },
    ],
    excluded_sources: [
      { source: "fftoday_half_ppr_auction", reason: "auction dollar values — no validated snake transformation (§5)", date: "2026-08-20" },
      { source: "fantasypros_market_api", reason: "public API returned only 10 rate-limited rows (§4 NOT_USABLE_FOR_SURVIVAL)", date: "2026-08-20" },
    ],
    identity_audit: audit,
    players: list,
  };
  writeFileSync(join(OUT_DIR, "market-adp-2026.json"), JSON.stringify(payload, null, 1));

  const ts =
    `/** GENERATED by scripts/build-market-consensus.mjs — do not edit by hand.\n` +
    ` *  2026 snake-draft market/ADP snapshot, crosswalked to Sleeper ids. No auction values (§5). */\n` +
    `export interface MarketSourceRow { source: string; type: "DIRECT_ADP" | "RANKING_PROXY"; pick: number; format: string; teams: number; date: string }\n` +
    `export interface MarketPlayerRow { sleeper_id: string; name: string; position: string | null; team: string | null; search_rank: number | null; sources: MarketSourceRow[] }\n` +
    `export interface MarketAdp2026 {\n` +
    `  market_consensus_version: string; generated_at: string;\n` +
    `  league_context: { season: number; teams: number; scoring: string; roster: string };\n` +
    `  source_catalog: Array<{ source: string; type: string; platform: string; format: string; teams: number | null; date: string; snake_usable: boolean }>;\n` +
    `  excluded_sources: Array<{ source: string; reason: string; date: string }>;\n` +
    `  identity_audit: { total: number; matched: number; ambiguous: number; unmatched: number; by_source: Record<string, { matched: number; unmatched: number }> };\n` +
    `  players: MarketPlayerRow[];\n` +
    `}\n` +
    `export const MARKET_ADP_2026: MarketAdp2026 = ${JSON.stringify(payload)};\n`;
  writeFileSync(join(OUT_DIR, "market-adp-2026.ts"), ts);
  console.log(`  wrote ${OUT_DIR}/market-adp-2026.{json,ts}`);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

main().catch((e) => { console.error(e); process.exit(1); });
