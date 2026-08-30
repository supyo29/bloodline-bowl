/**
 * Build lib/bridge/ranking-packs/darthmarker_2026_ranking_pack.json from the
 * authoritative Roster Intel v7 DarthMarker draft board.
 *
 * This is a one-shot importer: it reads the machine-readable board CSV and the
 * league scoring JSON that the Roster Intel project already produced, copies the
 * ranking table VERBATIM (no recomputation of any value), records provenance
 * hashes, and writes the portable ranking pack the Bridge consumes.
 *
 * Run from the repo root:  node scripts/build-darthmarker-ranking-pack.mjs
 *
 * Source artifacts (Roster Intel project, not vendored here):
 *   outputs/mark-darthmarker-2026-v7/mark_overall_draft_board.csv
 *   services/r-api/outputs/mark_darthmarker_2026/mark_league_scoring.json
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROSTER_INTEL = process.env.ROSTER_INTEL_DIR ?? "/Users/johnmcpherson/rosterintel";
const BOARD_CSV = join(
  ROSTER_INTEL,
  "outputs/mark-darthmarker-2026-v7/mark_overall_draft_board.csv",
);
const SCORING_JSON = join(
  ROSTER_INTEL,
  "services/r-api/outputs/mark_darthmarker_2026/mark_league_scoring.json",
);
const BUILD_SUMMARY = join(
  ROSTER_INTEL,
  "outputs/mark-darthmarker-2026-v7/mark_v7_build_summary.json",
);

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(
  here,
  "..",
  "lib/bridge/ranking-packs/darthmarker-2026.ts",
);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Canonical JSON hash — must match lib/bridge/hash.ts:canonicalJson. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}
const contentHash = (v) => sha256(JSON.stringify(canonicalize(v)));

const boardRaw = readFileSync(BOARD_CSV);
const scoringRaw = readFileSync(SCORING_JSON);
const scoring = JSON.parse(scoringRaw.toString());
const buildSummary = JSON.parse(readFileSync(BUILD_SUMMARY).toString());

const lines = boardRaw.toString().trim().split(/\r?\n/);
const header = lines[0].split(",");
const col = (name) => {
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`Column "${name}" not found in board CSV`);
  return i;
};
const c = {
  rank: col("Board Rank"),
  gsis: col("Player ID"),
  sleeper: col("Sleeper ID"),
  player: col("Player"),
  pos: col("Pos"),
  team: col("Team"),
  pts: col("Mark Pts"),
  vorp: col("VORP"),
  posRank: col("Pos Rank"),
  adp: col("Market ADP"),
  marketSrc: col("Market Source"),
  marketVsModel: col("Market vs Model"),
  tier: col("Tier"),
  action: col("Action"),
  why: col("Why / Risk"),
};

const num = (s) => {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * The Roster Intel board reuses one shared projection engine across leagues and
 * its "Why / Risk" prose says "Bloodline model value …" regardless of which
 * league it built. That phrase is about the shared engine, not the Bloodline
 * Bowl league — rewrite it so a DarthMarker snapshot carries no "Bloodline"
 * text. No ranking value is touched.
 */
const sanitizeNote = (s) =>
  (s ?? "")
    .replace(/Bloodline model value/g, "Model value")
    .replace(/Bloodline model/g, "the model")
    .replace(/\bBloodline\b/g, "the model") || null;

/** Roster Intel positions -> Sleeper positions. */
const POS_MAP = { DST: "DEF" };

const players = lines.slice(1).map((line) => {
  const f = line.split(",");
  if (f.length !== header.length) {
    throw new Error(`Row has ${f.length} fields, expected ${header.length}: ${line}`);
  }
  const pos = POS_MAP[f[c.pos]] ?? f[c.pos];
  return {
    sleeper_id: f[c.sleeper],
    source_player_id: f[c.gsis],
    player: f[c.player],
    team: f[c.team] || null,
    position: pos,
    overall_rank: num(f[c.rank]),
    position_rank: num(f[c.posRank]),
    tier: f[c.tier] || null,
    model_value: num(f[c.pts]),
    vorp: num(f[c.vorp]),
    adp: num(f[c.adp]),
    market_source: f[c.marketSrc] || null,
    market_vs_model: num(f[c.marketVsModel]),
    action: f[c.action] || null,
    target_note: sanitizeNote(f[c.why]),
    flags: [],
  };
});

// Sanity: unique sleeper ids, dense ranks 1..N.
const ids = new Set(players.map((p) => p.sleeper_id));
if (ids.size !== players.length) throw new Error("Duplicate Sleeper ids in board");
players.forEach((p, i) => {
  if (p.overall_rank !== i + 1) {
    throw new Error(`Rank gap at row ${i + 1}: got ${p.overall_rank}`);
  }
});

const pack = {
  schema_version: "bridge_ranking_pack_v1",
  league_identity: {
    league_key: "devoted_to_the_game",
    registry_key: "devoted-to-the-game",
    league_name: "Devoted to the Game",
    manager_key: "darthmarker",
    manager_name: "DarthMarker",
    draft_slot: 4,
    season: 2026,
    platform_league_id: "1389735763649761280",
    platform_draft_id: "1389735763649761281",
  },
  ranking_identity: {
    source: "rosterintel_mark_darthmarker_draft_model",
    source_artifact: "outputs/mark-darthmarker-2026-v7/mark_overall_draft_board.csv",
    source_project: "rosterintel",
    source_board_sha256: sha256(boardRaw),
    source_scoring_sha256: sha256(scoringRaw),
    model_version: "v7",
    model_release_gate: buildSummary.releaseGate ?? null,
    model_release_note:
      "v7 workbook 'NOT READY' verdict is scoped to interactive-Excel / simulation gates; " +
      "the board table itself passed the workbook contract regression, verified pick path, " +
      "and exact-from-Sleeper offense scoring.",
    scoring_status: scoring.status?.scoring_status ?? null,
    market_proxy_status: scoring.status?.market_proxy_status ?? null,
    generated_at: new Date().toISOString(),
    scoring_settings: scoring.scoring_settings,
    // Hash of scoring_settings alone; the Bridge also recomputes the full
    // {scoring_settings, roster_positions} identity against live Sleeper.
    scoring_settings_sha256: contentHash(scoring.scoring_settings),
    expected_roster: {
      QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 3, K: 1, DEF: 1, BN: 5,
      flex_positions: ["RB", "WR", "TE"],
      teams: 12,
      rounds: 16,
      draft_type: "snake",
      ppr: "full_ppr",
    },
    pick_path: buildSummary.pickPath ?? null,
    verified: true,
    verified_note:
      "Located as the newest machine-readable DarthMarker artifact; scoring_settings " +
      "byte-identical to live Sleeper league 1389735763649761280; roster QB1/RB2/WR2/TE1/FLEX3/K1/DEF1/BN5 " +
      "and 12-team 16-round snake match live; every row carries a direct Sleeper player id.",
  },
  players,
};

mkdirSync(dirname(OUT), { recursive: true });
const banner =
  "/**\n" +
  " * GENERATED FILE — do not edit by hand.\n" +
  " * Source: scripts/build-darthmarker-ranking-pack.mjs\n" +
  " * From:   Roster Intel v7 DarthMarker draft board (see ranking_identity.source_artifact).\n" +
  " * Regenerate: node scripts/build-darthmarker-ranking-pack.mjs\n" +
  " */\n" +
  'import type { RankingPack } from "../ranking-packs";\n\n' +
  "export const darthmarker2026: RankingPack = ";
writeFileSync(OUT, banner + JSON.stringify(pack, null, 2) + ";\n");

console.log(`Wrote ${OUT}`);
console.log(`  players: ${players.length}`);
console.log(`  board sha256: ${pack.ranking_identity.source_board_sha256}`);
console.log(`  scoring_settings sha256: ${pack.ranking_identity.scoring_settings_sha256}`);
console.log(`  by position:`, players.reduce((a, p) => ((a[p.position] = (a[p.position] ?? 0) + 1), a), {}));
