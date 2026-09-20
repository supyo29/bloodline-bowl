/** Phase 3.5D Checkpoint A — contract, taxonomy integrity, and taxonomy-vs-real-capability agreement. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAPTER_LIBRARY, TEMPLATES } from "@/lib/analysis-book/library";
import { TOPIC_META, UNSUPPORTED_CAPABILITIES } from "@/lib/analysis-book/topics";
import { ANALYSIS_BOOK_CONTRACT, TAXONOMY_VERSION, PLANNER_RULES_VERSION } from "@/lib/analysis-book/schema";
import { TOPICS } from "@/lib/book-ready/query";

test("versions are declared", () => { assert.equal(ANALYSIS_BOOK_CONTRACT, "analysis-book-2026.1"); assert.match(TAXONOMY_VERSION, /^analysis-taxonomy-/); assert.match(PLANNER_RULES_VERSION, /^analysis-planner-rules-/); });

test("TOPIC_META mirrors the real Book-Ready TOPICS exactly (no invented or forgotten topic; params and cost class agree)", () => {
  assert.deepEqual(Object.keys(TOPIC_META).sort(), Object.keys(TOPICS).sort());
  for (const [k, m] of Object.entries(TOPIC_META)) {
    assert.equal(TOPICS[k]!.surface, m.surface, k); assert.deepEqual(TOPICS[k]!.required, m.required, k); assert.equal(TOPICS[k]!.cost, m.bookready_cost, k);
    if (m.bookready_cost === "REQUEST_SCOPED_BUILD") assert.notEqual(m.cost, "FAST", `${k}: request-scoped builds are never FAST`);
  }
});
test("every unsupported capability has a stated reason and is NOT also a Book-Ready topic", () => {
  for (const [k, why] of Object.entries(UNSUPPORTED_CAPABILITIES)) { assert.ok(why.length > 15, k); assert.ok(!TOPICS[k], `${k} is claimed unsupported but is a topic`); }
});

test("chapter library integrity: every need names a real topic OR a declared unsupported capability; deps exist and are acyclic", () => {
  const seen = new Set<string>();
  for (const c of Object.values(CHAPTER_LIBRARY)) {
    assert.ok(!seen.has(c.id)); seen.add(c.id); assert.match(c.id, /^[a-z_]+(\.[a-z_]+)+$/, c.id);
    assert.ok(c.title && c.question, c.id);
    if (c.kind === "SYNTHESIS") { assert.deepEqual(c.needs, []); continue; }
    assert.ok(c.needs.some((n) => n.role === "required"), `${c.id} needs a required need`);
    for (const n of [...c.needs, ...(c.subchapters ?? []).flatMap((s) => s.needs ?? [])]) { assert.ok(Boolean(n.topic) !== Boolean(n.capability), `${c.id}: exactly one of topic/capability`); if (n.topic) assert.ok(TOPIC_META[n.topic], `${c.id}: unknown topic ${n.topic}`); else assert.ok(UNSUPPORTED_CAPABILITIES[n.capability!], `${c.id}: undeclared capability ${n.capability}`); }
    for (const d of c.depends_on ?? []) assert.ok(CHAPTER_LIBRARY[d], `${c.id} depends on unknown ${d}`);
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string) => { if (done.has(id)) return; assert.ok(!visiting.has(id), `dependency cycle at ${id}`); visiting.add(id); for (const d of CHAPTER_LIBRARY[id]!.depends_on ?? []) visit(d); visiting.delete(id); done.add(id); };
  Object.keys(CHAPTER_LIBRARY).forEach(visit);
});

test("scope discipline: a topic is only bound to a subject scope it can serve", () => {
  for (const c of Object.values(CHAPTER_LIBRARY)) for (const n of c.needs) {
    if (!n.topic) continue; const scope = TOPIC_META[n.topic]!.scope;
    if (scope === "MANAGER") assert.equal(n.bind, "manager", `${c.id}/${n.topic}`);
    if (scope === "QB") assert.ok(["team_qb", "self"].includes(n.bind), `${c.id}/${n.topic}`);
    if (scope === "TEAM") assert.ok(["own_team", "opponent", "both_teams"].includes(n.bind), `${c.id}/${n.topic}`);
    if (scope === "SCENARIO") assert.equal(n.scenario, true, `${c.id}: opp.scenario is always conditional`);
  }
});

test("every template: ends in the final synthesis, has unique chapters, and meets its explicit coverage expectations", () => {
  for (const t of Object.values(TEMPLATES)) {
    const ids = t.parts.flatMap((p) => p.chapters); assert.equal(new Set(ids).size, ids.length, `${t.type} repeats a chapter`);
    assert.equal(ids[ids.length - 1], "book.final_synthesis", t.type);
    const tags = new Set(ids.flatMap((id) => [...CHAPTER_LIBRARY[id]!.tags, ...(CHAPTER_LIBRARY[id]!.subchapters ?? []).flatMap((s) => s.tags ?? [])]));
    for (const e of t.coverage_expectations) assert.ok(tags.has(e), `${t.type} omits expected dimension "${e}"`);
    assert.ok(t.parts.length >= 3, t.type);
  }
  const player = TEMPLATES.PLAYER_ANALYSIS.parts.flatMap((p) => p.chapters).length; assert.ok(player >= 30, `player book is exhaustive in breadth (${player})`);
});
test("the taxonomy is NOT one universal list: book types differ in Parts and chapters", () => {
  const sigs = Object.values(TEMPLATES).map((t) => t.parts.map((p) => p.id + p.chapters.join()).join("|")); assert.equal(new Set(sigs).size, sigs.length);
});
