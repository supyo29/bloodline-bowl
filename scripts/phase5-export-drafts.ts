/**
 * PHASE 5 — export completed snake drafts as the survival-calibration ground truth.
 *
 *   npx tsx scripts/phase5-export-drafts.ts
 *
 * Bloodline Bowl is a brand-new league (previous_league_id: null) and its 2026
 * draft is pre-draft, so it has NO historical picks. The only completed 12-team
 * snake drafts available are "Devoted to the Game":
 *   - 2026 draft 1389735763649761281  (completed 2026-08-31 — ~contemporaneous with the ADP snapshot)
 *   - 2025 draft 1264616402392723456
 *
 * Writes outputs/projections-2026/phase5_devoted_drafts.csv:
 *   season, draft_id, overall_pick, round, slot, roster_id, sleeper_id, name, position, team
 *
 * `analysis/phase5_market_survival.R` joins this to the vendored ADP snapshot.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DRAFTS: Array<{ season: number; draft_id: string }> = [
  { season: 2026, draft_id: "1389735763649761281" },
  { season: 2025, draft_id: "1264616402392723456" },
];
const OUT = join("outputs", "projections-2026");

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json() as Promise<T>;
}

interface RawPick {
  pick_no: number;
  round: number;
  draft_slot: number;
  roster_id: number | null;
  player_id: string;
  metadata?: { first_name?: string; last_name?: string; position?: string; team?: string };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const rows: string[] = [
    "season,draft_id,overall_pick,round,slot,roster_id,sleeper_id,name,position,team",
  ];
  for (const d of DRAFTS) {
    const picks = await jget<RawPick[]>(`https://api.sleeper.app/v1/draft/${d.draft_id}/picks`);
    picks.sort((a, b) => a.pick_no - b.pick_no);
    for (const p of picks) {
      const name = `${p.metadata?.first_name ?? ""} ${p.metadata?.last_name ?? ""}`.trim().replace(/,/g, "");
      rows.push(
        [
          d.season,
          d.draft_id,
          p.pick_no,
          p.round,
          p.draft_slot,
          p.roster_id ?? "",
          p.player_id,
          name,
          p.metadata?.position ?? "",
          p.metadata?.team ?? "",
        ].join(","),
      );
    }
    console.log(`  ${d.season}: ${picks.length} picks`);
  }
  writeFileSync(join(OUT, "phase5_devoted_drafts.csv"), rows.join("\n") + "\n");
  console.log(`  wrote ${OUT}/phase5_devoted_drafts.csv (${rows.length - 1} rows)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
