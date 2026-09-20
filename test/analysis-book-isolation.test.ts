/** Phase 3.5D Checkpoint F — isolation: the Analysis Book is read-only planning infrastructure; nothing in production imports it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadPlayerDirectory } from "@/lib/analysis-book/directory";
import { loadCapabilitySnapshot } from "@/lib/analysis-book/capability";
import { createBook } from "@/lib/analysis-book/contents";
import { buildResearchPlan } from "@/lib/analysis-book/plan";
import { TOPICS } from "@/lib/book-ready/query";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === "node_modules" || f === ".next" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
const NOW = "2026-09-20T12:00:00.000Z";

test("no production file imports (or even names) the Analysis Book — it is unreachable from every recommendation path", () => {
  const offenders = [...walk("app"), ...walk("lib")].filter((f) => !f.startsWith("lib/analysis-book/")).filter((f) => /analysis-book|analysis_book/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, [], "only the registry consumer list (a JSON doc) may name it");
});
test("inside lib/analysis-book only executor.ts touches Book-Ready; the planner/navigation/synthesis layers cannot retrieve evidence", () => {
  const importers = walk("lib/analysis-book").filter((f) => /book-ready/.test(readFileSync(f, "utf8")));
  assert.deepEqual(importers, ["lib/analysis-book/executor.ts"]);
  for (const f of walk("lib/analysis-book")) { const s = readFileSync(f, "utf8"); assert.doesNotMatch(s, /\bfetch\(|supabase|\.insert\(|\.upsert\(|writeFileSync|\.rm\(|unlinkSync|process\.env\./, `${f}: no writes, network or secrets`); assert.doesNotMatch(s, /from\s+["']@\/lib\/(weekly|trades|providers|persistence|leagues)/, `${f}: no production engine imports`); }
  for (const f of walk("lib/analysis-book").filter((x) => !x.endsWith("executor.ts") && !x.endsWith("research.ts"))) assert.doesNotMatch(readFileSync(f, "utf8"), /getEvidence|inProcessClient|executePlan/, `${f}: evidence retrieval is executor-only`);
});
test("the Analysis Book imports no start-sit-fi / matchup / waiver MODULE (topic names are registry strings only)", () => {
  for (const f of walk("lib/analysis-book")) for (const m of readFileSync(f, "utf8").matchAll(/from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)/g)) { const spec = m[1] ?? m[2]!; assert.doesNotMatch(spec, /start-sit-fi|weekly|matchup|orchestrator|trades|waiver/, `${f} imports ${spec}`); }
});
test("frozen Start/Sit model is byte-identical; building books and plans does not touch it or any production surface", () => {
  assert.equal(createHash("sha256").update(readFileSync("lib/weekly/data/start_sit_model.json")).digest("hex"), "85d2ddd501cc10d5b3a699629f80c0c3781fe12fa24fa834f41969cb0186b293");
  const r = createBook({ question: "Analyze Rome Odunze this week" }, loadPlayerDirectory(), loadCapabilitySnapshot(), NOW); assert.ok(r.ok);
  const before = JSON.stringify(r.session); buildResearchPlan(r.session, ["player.role.playing_time"], loadCapabilitySnapshot()); assert.equal(JSON.stringify(r.session), before, "planning does not mutate the session");
});
test("no new HTTP route: the Analysis Book is a library foundation (no mutation endpoint exists)", () => {
  const routes = walk("app").filter((f) => /analysis-book|analysis_book/.test(f)); assert.deepEqual(routes, []);
});

test("REGISTRY-CONSTRAINED: the planner infers capability from the surface registry — changing the registry changes researchability", () => {
  const root = mkdtempSync(join(tmpdir(), "abreg-")); for (const d of ["docs", "lib", "data"]) cpSync(d, join(root, d), { recursive: true });
  const dir = loadPlayerDirectory();
  const base = loadCapabilitySnapshot(root); const b0 = createBook({ question: "Analyze Rome Odunze this week" }, dir, base, NOW); assert.ok(b0.ok);
  assert.equal(b0.session.contents.find((c) => c.chapter_id === "player.role.playing_time")!.researchability.state, "HISTORY_LIMITED");
  const p = join(root, "docs/intelligence-surface-registry.json"); const reg = JSON.parse(readFileSync(p, "utf8"));
  for (const s of reg.surfaces) if (s.id === "role-opportunity") s.book_ready.capability_state = "UNSUPPORTED";
  writeFileSync(p, JSON.stringify(reg));
  const b1 = createBook({ question: "Analyze Rome Odunze this week" }, dir, loadCapabilitySnapshot(root), NOW); assert.ok(b1.ok);
  assert.equal(b1.session.contents.find((c) => c.chapter_id === "player.role.playing_time")!.researchability.state, "UNSUPPORTED", "registry says UNSUPPORTED -> the planner must not advertise it");
  for (const s of reg.surfaces) if (s.id === "role-opportunity") { s.book_ready.capability_state = "AVAILABLE"; s.book_ready.history.class = "CURRENT_ONLY"; }
  writeFileSync(p, JSON.stringify(reg));
  const b2 = createBook({ question: "Analyze Rome Odunze this week" }, dir, loadCapabilitySnapshot(root), NOW); assert.ok(b2.ok);
  assert.equal(b2.session.contents.find((c) => c.chapter_id === "player.role.playing_time")!.researchability.state, "CURRENT_ONLY", "registry says Role history is CURRENT_ONLY -> the planner follows it");
  // double guard: a registry that OVERSTATES Start/Sit history cannot make the planner advertise it, because the Book-Ready topic itself serves none
  for (const s of reg.surfaces) if (s.id === "start-sit-fi") { s.book_ready.history.class = "NATIVE_HISTORY"; s.book_ready.capability_state = "AVAILABLE"; }
  writeFileSync(p, JSON.stringify(reg));
  const b3 = createBook({ question: "Rome or Deebo?", league: "bloodline-bowl", manager: "supyo29" }, dir, loadCapabilitySnapshot(root), NOW); assert.ok(b3.ok);
  assert.equal(b3.session.contents.find((c) => c.chapter_id === "startsit.historical_accuracy")!.researchability.state, "CURRENT_ONLY", "topic capability flags guard against registry overstatement");
  const real = createBook({ question: "Rome or Deebo?", league: "bloodline-bowl", manager: "supyo29" }, dir, loadCapabilitySnapshot(), NOW); assert.ok(real.ok);
  assert.equal(real.session.contents.find((c) => c.chapter_id === "startsit.historical_accuracy")!.researchability.state, "CURRENT_ONLY");
  assert.throws(() => loadCapabilitySnapshot(mkdtempSync(join(tmpdir(), "abnoreg-"))), /registry missing/);
});
test("registry <-> planner: every registry query topic is known to the planner, and the planner names no topic the registry lacks", () => {
  const reg = JSON.parse(readFileSync("docs/intelligence-surface-registry.json", "utf8")) as { surfaces: Array<{ id: string; book_ready: { query_topics: string[] } }> };
  const registryTopics = new Set(reg.surfaces.flatMap((s) => s.book_ready.query_topics)); assert.deepEqual([...registryTopics].sort(), Object.keys(TOPICS).sort());
});
