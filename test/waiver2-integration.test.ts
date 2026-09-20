/** Phase 4 (Checkpoint F/H) — isolation, deployment safety, and Analysis Book integration without taxonomy duplication. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlayerDirectory } from "@/lib/analysis-book/directory";
import { loadCapabilitySnapshot } from "@/lib/analysis-book/capability";
import { createBook } from "@/lib/analysis-book/contents";
import { CHAPTER_LIBRARY, TEMPLATES } from "@/lib/analysis-book/library";
import { UNSUPPORTED_CAPABILITIES, TOPIC_META } from "@/lib/analysis-book/topics";
import { buildResearchPlan } from "@/lib/analysis-book/plan";
import type { AnalysisBookSession, ContentsChapter } from "@/lib/analysis-book/schema";

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === "node_modules" || f === ".next" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const NOW = "2026-09-20T12:00:00.000Z"; const CTX = { league: "bloodline-bowl", manager: "supyo29" };

test("DEPLOYMENT SAFETY: the production waiver engine and everything it depends on are byte-identical to the pre-Phase-4 main", () => {
  const pins: Record<string, string> = {
    "lib/weekly/waivers.ts": "fe197892d0d7b1be9cbb7c6cf9e2083439448cf9e37f643e2981029d72f05a80", "lib/weekly/decision-score.ts": "519999456302880802fee93374b8b93962fc5b296c71b0f454313c08db09b114",
    "lib/weekly/replacement.ts": "e96ca368004af71602e97330d7ad11901927e44a8c9c3b7ebcd6776635f00f5b", "lib/weekly/lineup.ts": "96efe16d8b0c9cf886c2fb111ecf83e88fb05322f2c57758387619d9a9067cc7",
    "lib/weekly/context.ts": "549244f45c7e8f399aa25d636e6df2e86b75937c864803e8b4fb63e7bf08cfdd", "lib/weekly/intelligence.ts": "cd677a1aa2ea704ae5f236b3636c2c2b8c149c7eed89daa4f8619077aa693350",
  };
  for (const [f, h] of Object.entries(pins)) assert.equal(sha(f), h, `${f} changed`);
  assert.equal(sha("lib/weekly/data/start_sit_model.json"), "85d2ddd501cc10d5b3a699629f80c0c3781fe12fa24fa834f41969cb0186b293");
});
test("ISOLATION: only Book-Ready (family + query layer) reaches lib/waiver2; no production, orchestrator, weekly, trade or route module imports it", () => {
  const offenders = [...walk("app"), ...walk("lib")].filter((f) => !f.startsWith("lib/waiver2/")).filter((f) => /waiver2|waiver-intelligence-2/.test(readFileSync(f, "utf8")));
  const allowed = ["lib/analysis-book/library.ts", "lib/analysis-book/plan.ts", "lib/analysis-book/topics.ts", "lib/book-ready/families/waiver2.ts", "lib/book-ready/query.ts", "lib/book-ready/units.ts", "lib/book-ready/vocabulary.ts", "lib/discovery.ts"];
  assert.deepEqual(offenders.filter((f) => !allowed.includes(f)), [], "an unexpected file names Waiver 2.0");
  const importers = [...walk("app"), ...walk("lib")].filter((f) => !f.startsWith("lib/waiver2/") && /from\s+["']@\/lib\/waiver2|import\(["']@\/lib\/waiver2/.test(readFileSync(f, "utf8")));
  assert.deepEqual(importers.sort(), ["lib/book-ready/families/waiver2.ts", "lib/book-ready/query.ts"], "exactly the Book-Ready adapter layer imports it");
  for (const f of ["weekly", "orchestrator", "trades"]) for (const g of walk(`lib/${f}`)) assert.doesNotMatch(readFileSync(g, "utf8"), /lib\/waiver2/, g);
  for (const g of walk("app/api").filter((x) => /waivers|intelligence|lineup/.test(x))) assert.doesNotMatch(readFileSync(g, "utf8"), /waiver2/, g);
});
test("READ-ONLY: Waiver 2.0 has no writes, no network, no secrets, no submission path and never imports the Analysis Book or Book-Ready", () => {
  for (const f of walk("lib/waiver2")) {
    const s = readFileSync(f, "utf8");
    assert.doesNotMatch(s, /\bfetch\(|supabase|\.insert\(|\.upsert\(|\.delete\(|writeFileSync|process\.env\.|\.post\(|method:\s*["']POST/i, `${f}: no writes, network or secrets`);
    assert.doesNotMatch(s, /from\s+["']@\/lib\/(book-ready|analysis-book|trades)/, `${f}: no upward imports`);
    assert.doesNotMatch(s, /submitClaim|placeClaim|submit_waiver|addDrop\(|transaction.*submit/i, `${f}: no claim submission`);
  }
});
test("FI is explanatory only: Waiver 2.0 gives Football Intelligence no numeric weight (routing respected)", () => {
  const v = readFileSync("lib/waiver2/value.ts", "utf8"); assert.match(v, /fi_numeric: false/); assert.match(v, /const fi = 0/); assert.match(v, /EXPLANATORY: no numeric weight/);
});

test("ANALYSIS BOOK: the named unsupported capabilities are REPLACED (not duplicated); chapter identities and templates are unchanged", () => {
  for (const k of ["replacement_level_evidence", "drop_cost_evidence", "manager_competition_evidence"]) assert.equal(UNSUPPORTED_CAPABILITIES[k], undefined, `${k} is now supplied by Waiver 2.0`);
  assert.equal(Object.keys(CHAPTER_LIBRARY).length, 99, "no chapters added or removed"); assert.deepEqual(Object.keys(CHAPTER_LIBRARY).filter((id) => /waiver2|waiver_2/.test(id)), [], "no second waiver taxonomy");
  assert.deepEqual(TEMPLATES.WAIVER_ANALYSIS.parts.map((p) => p.chapters), [["waiver.current_role", "player.role.trajectory", "waiver.injury_opportunity", "team.competition"], ["schedule.fantasy_playoffs", "matchup.defensive_structure", "waiver.upside_uncertainty"], ["decision.replacement_value", "decision.roster_fit", "waiver.availability_faab", "waiver.manager_competition", "waiver.drop_cost", "book.final_synthesis"]]);
  for (const t of ["waiver2.actions", "waiver2.market", "waiver2.replacement"]) { assert.ok(TOPIC_META[t]); assert.equal(TOPIC_META[t]!.cost, "EXPENSIVE"); }
});
test("ANALYSIS BOOK: waiver chapters upgrade UNSUPPORTED -> PARTIAL now (registry-gated on the pool) and PARTIAL -> READY the moment the registry declares the surface AVAILABLE — same chapter ids", () => {
  const dir = loadPlayerDirectory(); const ids = ["decision.replacement_value", "waiver.drop_cost", "waiver.manager_competition", "waiver.availability_faab"];
  const nowR = createBook({ question: "Should I pick up Rome Odunze off waivers?", ...CTX }, dir, loadCapabilitySnapshot(), NOW); assert.ok(nowR.ok); const now = { session: (nowR as { ok: true; session: AnalysisBookSession }).session };
  for (const id of ids) { const c: ContentsChapter = now.session.contents.find((x: ContentsChapter) => x.chapter_id === id)!; const nn = c.needs; assert.equal(c.researchability.state, "PARTIAL", id); assert.equal(c.researchability.cost, "EXPENSIVE"); assert.match(c.researchability.reasons.join(), /runtime availability is decided by its readiness contract/); assert.ok(nn.some((n) => n.topic?.startsWith("waiver2.")), id); }
  const root = mkdtempSync(join(tmpdir(), "w2reg-")); for (const d of ["docs", "lib", "data"]) cpSync(d, join(root, d), { recursive: true });
  const p = join(root, "docs/intelligence-surface-registry.json"); const reg = JSON.parse(readFileSync(p, "utf8")); for (const s of reg.surfaces) if (s.id === "waiver-intelligence-2" || s.id === "waiver-foundations") s.book_ready.capability_state = "AVAILABLE"; writeFileSync(p, JSON.stringify(reg));
  const readyR = createBook({ question: "Should I pick up Rome Odunze off waivers?", ...CTX }, dir, loadCapabilitySnapshot(root), NOW); assert.ok(readyR.ok); const ready = { session: (readyR as { ok: true; session: AnalysisBookSession }).session };
  for (const id of ids) assert.equal(ready.session.contents.find((x: ContentsChapter) => x.chapter_id === id)!.researchability.state, "READY", `${id} becomes READY with no taxonomy change`);
  assert.deepEqual(now.session.contents.map((c) => c.chapter_id), ready.session.contents.map((c) => c.chapter_id), "identical chapter identities in both states");
});
test("ANALYSIS BOOK: opening a waiver chapter plans exactly one Waiver 2.0 request, marks it EXPENSIVE and warns that request-scoped topics each re-run the weekly build", () => {
  const dir = loadPlayerDirectory(); const r = createBook({ question: "Should I pick up Rome Odunze off waivers?", ...CTX }, dir, loadCapabilitySnapshot(), NOW); assert.ok(r.ok);
  const one = buildResearchPlan(r.session, ["waiver.drop_cost"], loadCapabilitySnapshot()); assert.equal(one.queries.filter((q) => q.topic === "waiver2.actions").length, 1); assert.equal(one.cost.class, "EXPENSIVE");
  const three = buildResearchPlan(r.session, ["waiver.drop_cost", "waiver.manager_competition", "decision.replacement_value"], loadCapabilitySnapshot()); assert.ok(three.warnings.some((w) => /waiver2\./.test(w) && /re-run the weekly build/.test(w)));
});
