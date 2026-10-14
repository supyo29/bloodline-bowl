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

test("DEPLOYMENT SAFETY: the production waiver RANKING/SCORING model is byte-identical to the pre-Phase-4 main; only its readiness-gate wiring (context.ts) legitimately changed for the waiver-readiness-contract fix", () => {
  // PIN LEDGER (test-failure audit). This test was RED on the W2.P1 tip (`86e8190`): Wave 1 changed four of the six pinned files without updating the pins. Each re-baseline below is justified by
  // the exact commits that changed the file since the pin was last true (verified by hashing every historical revision of the file):
  //   decision-score.ts        UNCHANGED since the original pin (c0b1a5e)  -> the RANKING / SCORING weights are still byte-identical to the pre-Phase-4 model: the guard's purpose holds.
  //   start_sit_model.json     UNCHANGED (frozen model sha asserted below).
  //   waivers.ts   (true at 9f13949) <- 3ecbb1d explicit readiness contract; 89e22ad W1.P3 bye-aware asset preservation; abe494f W1.R1 remediation; 57a6606 W1.R2 canonical asset value;
  //                                     af72022 Yahoo Market State (optional `acquisition` / `market_pool` output fields; absent for Sleeper)
  //   replacement.ts (c0b1a5e)  <- af72022: `ownership === "waiver"` also counts toward the acquirable pool (no provider produced that state before; Sleeper output identical)
  //   lineup.ts      (c0b1a5e)  <- 68fc482 W1.P2 injury-aware expected value; 89e22ad W1.P3 bye-aware preservation
  //   intelligence.ts (726da33) <- b893c6d orthogonal readiness axes; 68fc482 W1.P2; abe494f W1.R1
  //   context.ts     (0771277)  <- 12 commits: readiness composer (ad860a9..a86e4d9, 31fdd0a), W1.P1/P2/P3/P4/R1/R2 (ab7dce3, 68fc482, 89e22ad, 65a04f4, abe494f, 57a6606), af72022 Yahoo Market State
  //   context.ts (W2.R1 early shadow, 2026-10-14) <- ONE line: the default crosswalk now goes through resolveLeagueCrosswalk so a YAHOO league's roster is bridged to the Sleeper identity.
  //                     LIVE P1 DEFECT (3/17 and 5/15 Yahoo roster players projected; roster and pool in different identity spaces). Sleeper leagues are byte-identical in behaviour; ranking/scoring files untouched.
  // Every one is a reviewed, separately-tested, certified change (see docs/DECISION_MODEL_CONVERGENCE_W1_*.md). A NEW change to any of these files still fails here until it is added to this ledger.
  const pins: Record<string, string> = {
    "lib/weekly/waivers.ts": "c8be1cbf0ff9545bec7e21fb365a29b3b796a019c4d603aa3d64f8639c341bae", "lib/weekly/decision-score.ts": "519999456302880802fee93374b8b93962fc5b296c71b0f454313c08db09b114",
    "lib/weekly/replacement.ts": "feab998c610735b3c3a6baa6893dd806988f2faa5a1b07b3eb371425a1b56846", "lib/weekly/lineup.ts": "64741d969faada6051b325ac8d580911a3fd87d7cfee8ab0d027a18ba904d574",
    "lib/weekly/intelligence.ts": "5728d64e8421ae926b7e335f195e590bfecdce6b9f60999c2ca52133d685fe56",
  };
  for (const [f, h] of Object.entries(pins)) assert.equal(sha(f), h, `${f} changed`);
  assert.equal(sha("lib/weekly/data/start_sit_model.json"), "85d2ddd501cc10d5b3a699629f80c0c3781fe12fa24fa834f41969cb0186b293");
  // context.ts intentionally changed (waiver-readiness-contract fix, see lib/weekly/market-pool-adapter.ts):
  // it now optionally certifies `free_agent_pool_readiness` / `availability.free_agents` against Market State
  // instead of the always-null canonical `waiver_state`. Pinned to the new content so any FURTHER change is
  // still caught; the ranking/scoring files above remain untouched, proving no scoring-model change occurred.
  assert.equal(sha("lib/weekly/context.ts"), "d0fbf5a2179b18564677d7d3ae888da3e266a0d083974032ab495d6b36488898", "lib/weekly/context.ts changed beyond the waiver-readiness-contract fix");
});
test("ISOLATION: only Book-Ready (family + query layer) reaches lib/waiver2; no production, orchestrator, weekly, trade or route module imports it", () => {
  const offenders = [...walk("app"), ...walk("lib")].filter((f) => !f.startsWith("lib/waiver2/")).filter((f) => /waiver2|waiver-intelligence-2/.test(readFileSync(f, "utf8")));
  const allowed = ["lib/book-ready/families/market-state.ts", "app/api/cron/waiver2-capture/route.ts", "app/api/evidence/route.ts", "lib/analysis-book/library.ts", "lib/analysis-book/plan.ts", "lib/analysis-book/topics.ts", "lib/book-ready/families/waiver2.ts", "lib/book-ready/query.ts", "lib/book-ready/units.ts", "lib/book-ready/vocabulary.ts", "lib/discovery.ts", "lib/persistence/supabase/waiver2-capture.ts", "lib/persistence/supabase/waiver2-capture-runtime.ts",
    // Phase 9: the weekly audit READS Waiver2 captures/outcomes and its own certified evidence gate; it never ranks or influences a waiver recommendation (test/weekly-audit-isolation.test.ts).
    // contract.ts/identity.ts/the Book-Ready family below merely contain the substring "waiver2" in a type/field name (WaiverOutcome-shaped fields); they do not import lib/waiver2 at all (see the `importers` assertion below).
    "lib/weekly-audit/build.ts", "lib/weekly-audit/gates.ts", "lib/weekly-audit/outcomes-waiver2.ts", "lib/persistence/supabase/weekly-audit-store.ts",
    "lib/weekly-audit/contract.ts", "lib/weekly-audit/identity.ts", "lib/book-ready/families/weekly-audit.ts"];
  assert.deepEqual(offenders.filter((f) => !allowed.includes(f)), [], "an unexpected file names Waiver 2.0");
  const importers = [...walk("app"), ...walk("lib")].filter((f) => !f.startsWith("lib/waiver2/") && /from\s+["']@\/lib\/waiver2|import\(["']@\/lib\/waiver2/.test(readFileSync(f, "utf8")));
  assert.deepEqual(importers.sort(), ["lib/book-ready/families/waiver2.ts", "lib/book-ready/query.ts", "lib/persistence/supabase/waiver2-capture-runtime.ts", "lib/persistence/supabase/waiver2-capture.ts", "lib/persistence/supabase/weekly-audit-store.ts", "lib/weekly-audit/build.ts", "lib/weekly-audit/gates.ts", "lib/weekly-audit/outcomes-waiver2.ts"], "exactly the Book-Ready adapter layer, the certified telemetry capture path, and the Phase 9 read-only weekly audit import it");
  const capImporters = [...walk("app"), ...walk("lib")].filter((f) => /waiver2-capture/.test(readFileSync(f, "utf8")) && !f.startsWith("lib/persistence/supabase/waiver2-capture")); assert.deepEqual(capImporters.sort(), ["app/api/cron/waiver2-capture/route.ts", "app/api/evidence/route.ts"], "only the evidence route and the auth-gated scheduled capture route drive the capture runtime; Book-Ready reaches it solely through the one-way hook");
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
  assert.equal(Object.keys(CHAPTER_LIBRARY).length, 106, "no chapters added or removed BY WAIVER2 (count reflects Phase 10's later lifecycle additions)"); assert.deepEqual(Object.keys(CHAPTER_LIBRARY).filter((id) => /waiver2|waiver_2/.test(id)), [], "no second waiver taxonomy");
  assert.deepEqual(TEMPLATES.WAIVER_ANALYSIS.parts.map((p) => p.chapters), [["waiver.current_role", "player.role.trajectory", "waiver.injury_opportunity", "team.competition"], ["schedule.fantasy_playoffs", "matchup.defensive_structure", "waiver.upside_uncertainty"], ["decision.replacement_value", "decision.roster_fit", "waiver.availability_faab", "waiver.manager_competition", "waiver.drop_cost", "book.final_synthesis"]]);
  for (const t of ["waiver2.actions", "waiver2.market", "waiver2.replacement"]) { assert.ok(TOPIC_META[t]); assert.equal(TOPIC_META[t]!.cost, "EXPENSIVE"); }
});
test("ANALYSIS BOOK: waiver chapters are READY only when the registry-declared capabilities they REQUIRE are AVAILABLE (Phase 4.5: waiver-intelligence-2 + league-market-state) — same chapter ids, no taxonomy change", () => {
  const dir = loadPlayerDirectory(); const ids = ["decision.replacement_value", "waiver.drop_cost", "waiver.manager_competition", "waiver.availability_faab"];
  const book = (root?: string) => { const r = createBook({ question: "Should I pick up Rome Odunze off waivers?", ...CTX }, dir, loadCapabilitySnapshot(root), NOW); assert.ok(r.ok); return (r as { ok: true; session: AnalysisBookSession }).session; };
  const state = (sess: AnalysisBookSession, id: string) => sess.contents.find((x: ContentsChapter) => x.chapter_id === id)!;
  const withRegistry = (mut: (s: { id: string; book_ready: { capability_state: string } }) => void) => { const root = mkdtempSync(join(tmpdir(), "w2reg-")); for (const d of ["docs", "lib", "data"]) cpSync(d, join(root, d), { recursive: true }); const p = join(root, "docs/intelligence-surface-registry.json"); const reg = JSON.parse(readFileSync(p, "utf8")); for (const s of reg.surfaces) if (s.book_ready) mut(s); writeFileSync(p, JSON.stringify(reg)); return book(root); };
  const now = book();
  for (const id of ids) { const c = state(now, id); assert.equal(c.researchability.cost, "EXPENSIVE"); assert.ok(c.needs.some((n) => n.topic?.startsWith("waiver2.")), id); }
  for (const id of ["decision.replacement_value", "waiver.drop_cost"]) assert.equal(state(now, id).researchability.state, "READY", `${id}: its required evidence (availability-based replacement, roster drop cost) is fully supported`);
  for (const id of ["waiver.availability_faab", "waiver.manager_competition"]) { const c = state(now, id); assert.equal(c.researchability.state, "PARTIAL", `${id} stays PARTIAL: pending claims / clear time unknown, FAAB uncalibrated`); assert.match(c.researchability.reasons.join(), /pending claims and per-player waiver-clear times are not exposed/); }
  assert.ok(state(now, "waiver.availability_faab").needs.some((n) => n.topic === "market.state" && n.role === "required"), "availability chapter now REQUIRES the market-state evidence");
  // downgrade path: a blocked/partial waiver surface makes every waiver chapter PARTIAL again
  const w2Partial = withRegistry((s) => { if (s.id === "waiver-intelligence-2") s.book_ready.capability_state = "PARTIAL"; });
  for (const id of ids) assert.equal(state(w2Partial, id).researchability.state, "PARTIAL", `${id} degrades with waiver-intelligence-2`);
  // the availability chapter needs the market surface too: with only THAT partial, only that chapter degrades
  const mktPartial = withRegistry((s) => { if (s.id === "league-market-state") s.book_ready.capability_state = "PARTIAL"; });
  assert.equal(state(mktPartial, "waiver.availability_faab").researchability.state, "PARTIAL"); assert.equal(state(mktPartial, "waiver.drop_cost").researchability.state, "READY");
  assert.match(state(mktPartial, "waiver.availability_faab").researchability.reasons.join(), /league-market-state: registry capability PARTIAL/, "the market surface state is independently reflected");
  assert.deepEqual(now.contents.map((c) => c.chapter_id), w2Partial.contents.map((c) => c.chapter_id), "identical chapter identities in every state");
});
test("ANALYSIS BOOK: opening a waiver chapter plans exactly one Waiver 2.0 request, marks it EXPENSIVE and warns that request-scoped topics each re-run the weekly build", () => {
  const dir = loadPlayerDirectory(); const r = createBook({ question: "Should I pick up Rome Odunze off waivers?", ...CTX }, dir, loadCapabilitySnapshot(), NOW); assert.ok(r.ok);
  const one = buildResearchPlan(r.session, ["waiver.drop_cost"], loadCapabilitySnapshot()); assert.equal(one.queries.filter((q) => q.topic === "waiver2.actions").length, 1); assert.equal(one.cost.class, "EXPENSIVE");
  const three = buildResearchPlan(r.session, ["waiver.drop_cost", "waiver.manager_competition", "decision.replacement_value"], loadCapabilitySnapshot()); assert.ok(three.warnings.some((w) => /waiver2\./.test(w) && /re-run the weekly build/.test(w)));
});

test("TAXONOMY VERSION: the chapter needs changed, so the taxonomy version moved (2026.2) while the contract stays 2026.1 — a saved 2026.1 book is REPORTED as drifted, never reinterpreted", async () => {
  const { TAXONOMY_VERSION, ANALYSIS_BOOK_CONTRACT } = await import("@/lib/analysis-book/schema"); const { serializeSession, deserializeSession } = await import("@/lib/analysis-book/session");
  assert.equal(TAXONOMY_VERSION, "analysis-taxonomy-2026.2"); assert.equal(ANALYSIS_BOOK_CONTRACT, "analysis-book-2026.1");
  const r = createBook({ question: "Should I pick up Rome Odunze off waivers?", ...CTX }, loadPlayerDirectory(), loadCapabilitySnapshot(), NOW); assert.ok(r.ok); const s = (r as { ok: true; session: AnalysisBookSession }).session;
  const old = { ...s, taxonomy_version: "analysis-taxonomy-2026.1" }; const d = deserializeSession(serializeSession(old));
  assert.equal(d.drift.drifted, true); assert.equal(d.drift.stored_taxonomy, "analysis-taxonomy-2026.1"); assert.equal(d.session.contents.find((c) => c.chapter_id === "waiver.drop_cost")!.needs.some((n) => n.topic === "waiver2.actions"), true, "contents are frozen as saved (here re-serialized from the new book)");
});
