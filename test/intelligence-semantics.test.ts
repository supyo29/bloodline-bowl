/**
 * Phase 3.5B — schema / label semantics across every served intelligence artifact.
 *
 * Principle (from the FTN read_thrown correction): where source semantics are unverified, expose raw codes and
 * label the uncertainty; never translate to a convenient meaning. Where a numeric field's scale could be
 * misread (fraction vs percent, share vs count, ratio vs probability) it must be explicitly accounted for here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadFootballIntelligence } from "@/lib/football-intel";
import { usageOutputClass } from "@/lib/football-intel/read";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const json = (p: string) => JSON.parse(read(p)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function parseCsv(text: string): { head: string[]; rows: string[][] } {
  const rows: string[][] = []; let cur: string[] = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { cur.push(f); f = ""; }
    else if (c === "\n") { cur.push(f); rows.push(cur); cur = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || cur.length) { cur.push(f); rows.push(cur); }
  return { head: rows[0]!, rows: rows.slice(1).filter((r) => r.length > 1) };
}

/* ------------------------------- scale audit (fraction / percent / count / ratio) ------------------------------- */
const DATA_DIRS = ["lib/football-intel/data", "lib/player-role-intelligence/data", "lib/opportunity-propagation-intelligence/data", "lib/player-scheme-intelligence/data"];
const SCALED = /(share|rate|pct|percent|percentile|prob|proportion|fraction|continuity|turnover|ratio$)/i;

/**
 * Columns whose NAME reads like a fraction but whose documented meaning is not bounded to [0,1]. Every entry must
 * (a) still be needed (the artifact really exceeds 1 there) and (b) state why. Anything else exceeding 1 is a bug.
 */
const DOCUMENTED_NON_FRACTIONS: Array<{ file: string; column: RegExp; why: string }> = [
  { file: "player_game_role.csv", column: /^snap_share_derived$/, why: "offensive_snaps / team_offensive_plays; QB snaps can exceed the play denominator because kneels are excluded from it (Phase 2 Checkpoint B)" },
  { file: "player_role_profile.csv", column: /^participation_snap_share_(latest|recent|prior)$/, why: "EWMA of snap_share_derived — inherits the QB >1.0 case" },
  { file: "player_role_profile.csv", column: /_opportunity_total$/, why: "COUNT of opportunities (evidence volume / denominator), not a share, despite the prefix" },
  { file: "inheritance_priors_league.csv", column: /^league_rate$/, why: "inheritance RATIO (beneficiaries may collectively over-absorb the vacated share), never a probability" },
  { file: "inheritance_priors_position.csv", column: /^position_rate_blended$/, why: "inheritance RATIO, may exceed 1.0 by design" },
  { file: "inheritance_priors_team.csv", column: /^team_rate_blended$/, why: "inheritance RATIO, may exceed 1.0 by design" },
];

test("scale audit: every share/rate/percentile-named column is a [0,1] fraction, or a documented non-fraction that is still needed", () => {
  const needed = new Set<string>(); const violations: string[] = [];
  for (const dir of DATA_DIRS) for (const f of readdirSync(join(ROOT, dir)).filter((x) => x.endsWith(".csv"))) {
    const { head, rows } = parseCsv(read(`${dir}/${f}`));
    head.forEach((col, ci) => {
      if (!SCALED.test(col)) return;
      let max = -Infinity;
      for (const r of rows) { const v = Number(r[ci]); if (r[ci] !== "" && r[ci] !== "NA" && Number.isFinite(v)) max = Math.max(max, v); }
      if (max <= 1 + 1e-7) return;
      const ex = DOCUMENTED_NON_FRACTIONS.find((e) => e.file === f && e.column.test(col));
      if (ex) needed.add(`${ex.file}:${ex.column}`); else violations.push(`${dir}/${f}:${col} max=${max}`);
    });
  }
  assert.deepEqual(violations, [], "undocumented value >1 in a fraction-named column (percent/fraction swap or unit error?)");
  const stale = DOCUMENTED_NON_FRACTIONS.filter((e) => !needed.has(`${e.file}:${e.column}`)).map((e) => `${e.file}:${e.column}`);
  assert.deepEqual(stale, [], "documented exception no longer needed — remove it so the audit stays tight");
});

test("FI percentiles are 0-1 fractions, never 0-100 percents", () => {
  for (const f of ["team_profile.csv", "unit_coverage_profile.csv"]) {
    const { head, rows } = parseCsv(read(`lib/football-intel/data/${f}`));
    const ci = head.indexOf("league_percentile"); assert.ok(ci >= 0, f);
    for (const r of rows) { const v = Number(r[ci]); if (r[ci] !== "" && Number.isFinite(v)) assert.ok(v >= 0 && v <= 1, `${f} league_percentile=${v}`); }
  }
});

/* ------------------------------- FI usage output class (deferred defect #3) ------------------------------- */
test("usageOutputClass: an absent observation is never OBSERVED; real observations and other classes are untouched", () => {
  assert.equal(usageOutputClass("OBSERVED", null), "MODELED");
  assert.equal(usageOutputClass("OBSERVED", 0.31), "OBSERVED");
  assert.equal(usageOutputClass("OBSERVED", 0), "OBSERVED");
  assert.equal(usageOutputClass("MODELED", null), "MODELED");
  assert.equal(usageOutputClass("DESCRIPTIVE_ONLY", null), "DESCRIPTIVE_ONLY");
  assert.equal(usageOutputClass(undefined, null), "MODELED");
});

test("FI reader: no usage metric with a null observation is exposed as OBSERVED (incl. the whole route_participation family)", () => {
  const fi = loadFootballIntelligence({ force: true })!;
  const { head, rows } = parseCsv(read("lib/football-intel/data/player_usage_profile.csv"));
  const gi = head.indexOf("gsis_id");
  let checked = 0; let routeRows = 0;
  for (const gsis of new Set(rows.map((r) => r[gi]!))) {
    const u = fi.playerUsage({ gsis_id: gsis });
    for (const m of Object.values(u.metrics)) {
      checked++;
      if (m.observed === null) assert.notEqual(m.output_class, "OBSERVED", `${gsis}:${m.metric}`);
      if (m.metric === "route_participation") routeRows++;
    }
  }
  assert.ok(checked > 1000 && routeRows > 0, `checked ${checked}`);
});

test("FI builder + publish gate encode the same rule (so the next daily refresh republishes truthful labels)", () => {
  assert.match(read("analysis/football_intel/lib_usage.R"), /output_class\s*=\s*ifelse\(is\.finite\(obs\),\s*"OBSERVED",\s*"MODELED"\)/);
  assert.match(read("analysis/football_intel/validate_snapshot.R"), /never labels an absent observation OBSERVED/);
});

/* ------------------------------- descriptive / shadow can never become predictive ------------------------------- */
test("descriptive-only artifacts are labelled descriptive and carry no fantasy adjustment", () => {
  for (const f of ["ftn_descriptive.csv", "receiver_progression.csv"]) {
    const { head, rows } = parseCsv(read(`lib/football-intel/data/${f}`)); const ci = head.indexOf("output_class");
    assert.ok(ci >= 0 && rows.length > 0, f);
    assert.ok(rows.every((r) => r[ci] === "DESCRIPTIVE_ONLY"), `${f} must be DESCRIPTIVE_ONLY`);
  }
  const ps = json("lib/player-scheme-intelligence/data/player_scheme_manifest.json");
  assert.equal(ps.fantasy_adjustment_enabled, false); assert.equal(ps.tier_d.numeric_fantasy_adjustment, 0); assert.equal(ps.tier_d.lane, "SHADOW_ONLY");
  const { head, rows } = parseCsv(read("lib/player-scheme-intelligence/data/player_scheme_interactions.csv"));
  const ai = head.indexOf("numeric_fantasy_adjustment"); if (ai >= 0) assert.ok(rows.every((r) => Number(r[ai]) === 0), "interaction adjustment must be 0");
});

test("frozen Start/Sit model never assigns a coefficient to a DESCRIPTIVE_ONLY / NOT_PREDICTIVE family", () => {
  const m = json("lib/weekly/data/start_sit_model.json");
  for (const [pos, p] of Object.entries<any>(m.positions)) for (const f of p.families) // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.ok(["PREDICTIVE", "WEAKLY_PREDICTIVE"].includes(f.routing), `${pos}:${f.family} routing ${f.routing}`);
  assert.match(m.routing.DESCRIPTIVE_ONLY, /explanation-only/); assert.match(m.routing.NOT_PREDICTIVE, /forced 0/);
});

test("Role / Opportunity Propagation cannot present themselves as predictive or production-influencing", () => {
  const role = json("lib/player-role-intelligence/data/role_opportunity_manifest.json");
  const opp = json("lib/opportunity-propagation-intelligence/data/opportunity_propagation_manifest.json");
  assert.equal(role.deployment_state, "SHARED_CONTEXT"); assert.equal(role.eligible_to_influence_production, false);
  assert.equal(opp.deployment_state, "SHADOW_ONLY"); assert.equal(opp.eligible_to_influence_production, false);
  assert.equal(opp.uncertainty_ranges_supported, false);
  assert.match(opp.scenario_semantics, /CONDITIONAL/); assert.doesNotMatch(opp.scenario_semantics, /P\(player X (misses|is unavailable)\)\s*=/);
  assert.ok(opp.known_limitations !== undefined);
});

/* ------------------------------- source conflict stays visible ------------------------------- */
test("the FTN read_thrown SOURCE_CONFLICT is visible in the manifest, the route and discovery", () => {
  const fi = json("lib/football-intel/data/football_intelligence_manifest.json");
  assert.match(fi.notes.join(" "), /UNVERIFIED_SOURCE_CONFLICT/);
  assert.match(read("app/api/football-intel/players/[playerId]/progression/route.ts"), /unverified/i);
  assert.match(read("lib/discovery.ts"), /UNVERIFIED/);
  assert.match(read("lib/football-intel/schema.ts"), /until FTN\/nflverse confirms the mapping/);
});

/* ------------------------------- PERMANENT regression: FTN read_thrown numeric semantics ------------------------------- */
const BANNED_LABELS = /FIRST_READ|SECOND_READ|THIRD_PLUS_READ|THIRD_READ|PRE_SNAP_OR_ZERO/;
const walk = (dir: string, ext: string[]): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((e) => {
    const rel = `${dir}/${e}`;
    if (e === "node_modules" || e === "cache") return [];
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel, ext) : ext.some((x) => rel.endsWith(x)) ? [rel] : [];
  });

test("PERMANENT: no served artifact, builder, route, reader or discovery text maps numeric read_thrown to first/second/third read", () => {
  const offenders: string[] = [];
  const files = [
    ...walk("lib", [".ts", ".csv", ".json"]), ...walk("app", [".ts"]),
    ...walk("analysis/football_intel", [".R"]), ...walk("analysis/player_scheme_intelligence", [".R"]),
  ].filter((f) => !/\.test\.|\/tests?\//.test(f));
  for (const f of files) {
    const text = read(f);
    if (!BANNED_LABELS.test(text)) continue;
    // the ONLY permitted occurrences are validators/guards that FORBID those labels
    const allowed = /validate_snapshot\.R$|schema\.ts$/.test(f);
    if (!allowed) offenders.push(f);
  }
  assert.deepEqual(offenders, [], "an ordinal read label reappeared outside a guard");
});

test("PERMANENT: served progression artifacts expose only RAW_0/RAW_1/RAW_2 + supported named buckets", () => {
  for (const [file, col] of [["lib/football-intel/data/receiver_progression.csv", "bucket"], ["lib/player-scheme-intelligence/data/qb_progression_profile.csv", "bucket"]] as const) {
    const { head, rows } = parseCsv(read(file)); const ci = head.indexOf(col); assert.ok(ci >= 0, `${file} lacks ${col}`);
    const buckets = new Set(rows.map((r) => r[ci]));
    const allowed = new Set(["RAW_0", "RAW_1", "RAW_2", "CHECKDOWN", "DESIGNED", "SCRAMBLE_DRILL", "OTHER"]);
    assert.deepEqual([...buckets].filter((b) => !allowed.has(b!)), [], file);
    assert.ok(["RAW_0", "RAW_1", "RAW_2"].every((b) => buckets.has(b)), `${file} must expose the neutral raw codes`);
  }
});

test("PERMANENT: builder mapping keeps numeric codes neutral (an artifact refresh cannot reintroduce the old labels)", () => {
  const lib = read("analysis/player_scheme_intelligence/lib_charting.R");
  assert.match(lib, /psi_read_bucket/); assert.match(lib, /RAW_/); assert.doesNotMatch(lib.replace(/#[^\n]*/g, ""), BANNED_LABELS);
  const fiLib = read("analysis/football_intel/lib_interactions.R");
  assert.match(fiLib, /\.ftn_read_bucket/); assert.doesNotMatch(fiLib.replace(/#[^\n]*/g, ""), BANNED_LABELS);
  assert.ok(read("analysis/player_scheme_intelligence/tests/test_read_semantics.R").length > 0);
  assert.match(read("analysis/football_intel/validate_snapshot.R"), /never labels numeric codes first\/second\/third read/);
});

test("PERMANENT: no downstream logic treats progression buckets as a predictive input", () => {
  for (const f of walk("lib/weekly", [".ts"]).concat(walk("lib/trades", [".ts"]))) {
    const t = read(f);
    assert.ok(!/receiverProgression|summarizeReceiverProgression|qb_progression_profile|RAW_[012]/.test(t), `${f} consumes progression`);
  }
  assert.doesNotMatch(read("analysis/football_intel_startsit/config.R"), /progression|read_thrown/);
});

/* ------------------------------- directory metadata gaps are known, pinned, and never papered over ------------------------------- */
/**
 * Phase 3.5B finding (DIRECTORY_METADATA_GAP, P3): the Player-Scheme player directory has entries whose identity
 * metadata is source-incomplete — position `XX` (nflverse's "no position" code) or a fully blank row — while
 * profile files still hold real data for that gsis_id. We do NOT invent identities or rewrite `XX` (source-native).
 * The gap is pinned here so growth is noticed, and consumers must treat `XX` / blank as UNKNOWN, not a position.
 */
const KNOWN_DIRECTORY_GAPS: Record<string, string> = {
  "00-0036936": "Rondale Moore: directory position 'XX' although rushing/route profile rows exist",
  "00-0023968": "blank directory row (no name/team/position) although receiver_spatial_matrix has rows",
  "00-0028049": "blank directory row (no name/team/position) although profile rows exist",
  "00-0027713": "Aaron Hernandez: directory position 'XX' / team FA (retired) although historical profile rows exist",
};

test("Player-Scheme directory: placeholder identities (XX / blank) that own profile data are exactly the pinned known gaps", () => {
  const dir = "lib/player-scheme-intelligence/data";
  const d = parseCsv(read(`${dir}/player_directory.csv`)); const gi = d.head.indexOf("gsis_id"); const pi = d.head.indexOf("position");
  const placeholders = new Set(d.rows.filter((r) => r[pi] === "XX" || r[pi] === "").map((r) => r[gi]!));
  assert.ok(placeholders.size > 0);
  const withData = new Set<string>();
  for (const f of readdirSync(join(ROOT, dir)).filter((x) => x.endsWith(".csv") && x !== "player_directory.csv")) {
    const t = parseCsv(read(`${dir}/${f}`)); const ci = t.head.indexOf("gsis_id"); if (ci < 0) continue;
    for (const r of t.rows) if (placeholders.has(r[ci]!)) withData.add(r[ci]!);
  }
  assert.deepEqual([...withData].sort(), Object.keys(KNOWN_DIRECTORY_GAPS).sort(), "a new (or resolved) directory metadata gap — update KNOWN_DIRECTORY_GAPS and the 3.5B doc");
  // the four real positions are the only real positions; XX / '' must be treated as unknown by consumers
  const real = new Set(d.rows.filter((r) => r[pi] !== "XX" && r[pi] !== "").map((r) => r[pi]));
  assert.deepEqual([...real].sort(), ["QB", "RB", "TE", "WR"]);
});
