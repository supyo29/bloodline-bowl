/** Phase 3.5C — registry <-> query layer agreement (single registry, extended). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOPICS } from "@/lib/book-ready/query";
import { PHASE_NAMESPACES } from "@/lib/book-ready/phase-namespaces";
import type { BookReadyCapability, IntelligenceSurface } from "@/lib/canonical/intelligence-surface-registry";

const reg = JSON.parse(readFileSync("docs/intelligence-surface-registry.json", "utf8")) as { surfaces: Array<IntelligenceSurface & { book_ready?: BookReadyCapability }>; phase_namespaces?: unknown; book_ready_contract_version?: string };
const HIST = ["NATIVE_HISTORY", "RECONSTRUCTABLE_AS_OF", "RETROSPECTIVE_ONLY", "CURRENT_ONLY", "UNSUPPORTED"];
test("every surface declares a book_ready block", () => { for (const s of reg.surfaces) assert.ok(s.book_ready, s.id); });
test("declared topics exist in TOPICS for the same surface, and every topic is declared (both directions)", () => {
  const declared = new Map<string, string>(); for (const s of reg.surfaces) for (const t of s.book_ready!.query_topics) declared.set(t, s.id);
  for (const [t, sid] of declared) { assert.ok(TOPICS[t], `${t} declared but not implemented`); assert.equal(TOPICS[t]!.surface, sid); }
  for (const [t, spec] of Object.entries(TOPICS)) assert.equal(declared.get(t), spec.surface, `${t} implemented but undeclared`);
});
test("history classes, refresh policies and chart hints are well-formed", () => {
  for (const s of reg.surfaces) { const b = s.book_ready!; assert.ok(HIST.includes(b.history.class), s.id); assert.ok(b.history.note.length > 10); assert.ok(b.refresh_policy.cadence && b.refresh_policy.rationale, s.id); assert.ok(Array.isArray(b.chart_ready)); }
});
test("only one registry exists; contract version + namespaces recorded", () => {
  assert.match(reg.book_ready_contract_version!, /^book-ready-evidence-/); assert.ok(reg.phase_namespaces);
  assert.ok(Object.keys(PHASE_NAMESPACES).length >= 5);
});
