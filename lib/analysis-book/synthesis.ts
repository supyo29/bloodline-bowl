/**
 * Phase 3.5D — coverage-aware SYNTHESIS CONTRACT. No model, no prose engine, no new score.
 *
 * Honesty rules enforced here (each is tested):
 *   - a finding may only rest on chapters that were actually researched (revisions exist); NOT_OPENED, blocked, unsupported
 *     and support-only chapters cannot be cited, and cited evidence must come from THOSE chapters' own research
 *   - model results, observations and analyst synthesis are kept apart (`kind`); an analyst synthesis may not carry a number
 *     or claim a new score, and a model result keeps a verbatim reference to the model's own evidence
 *   - conditional / shadow / projected / stale / partial / mixed-vintage support can only ever yield a TENTATIVE claim
 *   - mixed vintages are stated per source and are never described as one synchronized "current" week
 *   - the report always lists what was NOT researched and what CANNOT be researched
 */
import type { CapabilitySnapshot } from "./capability";
import { evaluateChapter } from "./capability";
import { canonicalJson, shortHash } from "./contents";
import { SEMANTIC_GROUPS } from "./selection";
import { effectiveStatus, staleMap } from "./session";
import type { AnalysisBookSession, ChapterStatus, ClaimStrength, EvidenceIdentity, EvidenceRef, Finding, FindingKind, Researchability } from "./schema";

const RESEARCHED: ChapterStatus[] = ["EXPLORED", "PARTIAL", "STALE", "NEEDS_REFRESH"];
const MODEL_CLASSES = ["MODELED", "PROJECTED", "CONDITIONAL", "SHADOW"]; const OBSERVED_CLASSES = ["OBSERVED", "DESCRIPTIVE", "RECONSTRUCTED"];
const NO_STRONG_CLASSES = ["CONDITIONAL", "SHADOW", "PROJECTED"];

export interface FindingInput { kind: FindingKind; text: string; chapters: string[]; evidence_ids: string[]; model_value_ref?: string; numeric?: number; claims_trend?: boolean }
export type AddFindingResult = { ok: true; session: AnalysisBookSession; finding: Finding } | { ok: false; errors: string[] };

/** request-scoped surfaces (matchup, roster health, schedule) are live builds with NO NFL through-week; say that instead of a fake week */
const when = (i: EvidenceIdentity) => (i.through_week === null ? `${i.season ?? "?"} live request-scoped build (no NFL through-week)` : `${i.season ?? "?"} week ${i.through_week}${i.week_state ? ` (${i.week_state})` : ""}`);
const label = (i: EvidenceIdentity) => `${i.surface} ${when(i)}${i.version ? ` [${i.version}]` : ""}`;
/** Per-source temporal statement. Never says "current week N intelligence" — every source keeps its own vintage. */
export function vintageStatement(ids: EvidenceIdentity[]): { mixed: boolean; statement: string } {
  const uniq = [...new Map(ids.map((i) => [`${i.surface}|${i.version}|${i.through_week}`, i])).values()].sort((a, b) => a.surface.localeCompare(b.surface));
  if (!uniq.length) return { mixed: false, statement: "no evidence vintage recorded" };
  const keys = new Set(uniq.map((i) => `${i.season}|${i.through_week}|${i.week_state ?? ""}`));
  const mixed = keys.size > 1;
  return { mixed, statement: mixed ? `MIXED VINTAGE — sources differ in season/week/completeness and are not one synchronized snapshot: ${uniq.map(label).join("; ")}.` : `single vintage: ${uniq.map(label).join("; ")}.` };
}

const CURRENT_CLAIM = /\bcurrent\b[^.]*\b(week\s*\d+|intelligence|evidence|data)\b|\b(this|latest)\s+week'?s?\b[^.]*\b(intelligence|evidence|data)\b|\bup[- ]to[- ]date\b/i;
const NEW_SCORE = /\b(score|rating|grade|projection|projected points?|value)\s*(?:of|=|:|is)\s*-?\d/i;

const latestRefs = (s: AnalysisBookSession, chapter: string): EvidenceRef[] => { const st = s.chapters[chapter]; const rev = st?.revisions[st.revisions.length - 1]; return rev ? rev.evidence_refs : []; };
const allRefs = (s: AnalysisBookSession, chapter: string): EvidenceRef[] => (s.chapters[chapter]?.revisions ?? []).flatMap((r) => r.evidence_refs);

export function assessFinding(s: AnalysisBookSession, f: { chapters: string[]; evidence_refs: string[]; kind: FindingKind; claims_trend?: boolean }, snap: CapabilitySnapshot | null): { strength: ClaimStrength; reasons: string[]; identities: EvidenceIdentity[]; mixed: boolean; statement: string } {
  const stale = snap ? staleMap(s, snap) : new Map();
  const reasons: string[] = []; const refs = new Map<string, EvidenceRef>();
  for (const c of f.chapters) for (const r of allRefs(s, c)) if (f.evidence_refs.includes(r.evidence_id)) refs.set(r.evidence_id, r);
  for (const c of f.chapters) {
    const status = effectiveStatus(s, c, stale); const cc = s.contents.find((x) => x.chapter_id === c.split("/")[0])!;
    if (status === "PARTIAL") reasons.push(`chapter ${cc.display_number} (${cc.title}) is only PARTIALLY researched`);
    if (status === "STALE" || status === "NEEDS_REFRESH") reasons.push(`chapter ${cc.display_number} (${cc.title}) research is ${status === "STALE" ? "stale: a source has updated since" : "queued for refresh"}`);
    const r: Researchability = snap && cc.kind === "EVIDENCE" ? evaluateChapter(cc.needs, s.subject, snap).state : cc.researchability.state;
    if (["SOURCE_CONFLICT", "SOURCE_LAG", "CONDITIONAL", "PARTIAL"].includes(r)) reasons.push(`chapter ${cc.display_number} (${cc.title}) is ${r}`);
    if (f.claims_trend && ["HISTORY_LIMITED", "CURRENT_ONLY"].includes(r)) reasons.push(`trend claim over ${r} evidence in chapter ${cc.display_number}`);
  }
  for (const r of refs.values()) { if (NO_STRONG_CLASSES.includes(r.analysis_class)) reasons.push(`cites ${r.analysis_class} evidence (${r.surface}/${r.metric})`); if (r.availability !== "AVAILABLE") reasons.push(`cites ${r.availability} evidence (${r.surface}/${r.metric})`); }
  const identities = [...refs.values()].map((r) => ({ surface: r.surface, version: r.version, season: r.season, through_week: r.through_week, week_state: r.week_state }));
  const v = vintageStatement(identities); if (v.mixed) reasons.push("cited evidence spans different vintages");
  return { strength: reasons.length ? "TENTATIVE" : "STRONG", reasons: [...new Set(reasons)], identities: [...new Map(identities.map((i) => [`${i.surface}|${i.version}|${i.through_week}`, i])).values()], mixed: v.mixed, statement: v.statement };
}

export function addFinding(s: AnalysisBookSession, input: FindingInput, snap: CapabilitySnapshot | null = null): AddFindingResult {
  const errors: string[] = [];
  if (!input.text.trim()) errors.push("finding text is empty");
  if (!input.chapters.length) errors.push("a finding must cite the chapters it rests on");
  if (!input.evidence_ids.length) errors.push("a finding must cite the evidence it rests on (evidence ids)");
  const stale = snap ? staleMap(s, snap) : new Map();
  for (const c of input.chapters) {
    const st = s.chapters[c]; if (!st) { errors.push(`unknown chapter ${c}`); continue; }
    if (!RESEARCHED.includes(st.status) || !st.revisions.length) { const cc = s.contents.find((x) => x.chapter_id === c.split("/")[0]); errors.push(`chapter ${cc?.display_number ?? c} (${cc?.title ?? c}) has not been researched${st.used_as_support.length ? " (it was only used as support for another chapter)" : ""}${st.blocked_reason ? `; blocked: ${st.blocked_reason}` : ""} — a finding cannot rest on it`); }
  }
  if (errors.length) return { ok: false, errors };
  const known = new Map<string, EvidenceRef>(); for (const c of input.chapters) for (const r of allRefs(s, c)) known.set(r.evidence_id, r);
  const cited: EvidenceRef[] = [];
  for (const id of input.evidence_ids) { const r = known.get(id); if (!r) errors.push(`evidence ${id} was not retrieved by the cited chapters' own research`); else cited.push(r); }
  if (input.kind === "OBSERVATION" && cited.some((r) => !OBSERVED_CLASSES.includes(r.analysis_class))) errors.push(`an OBSERVATION may cite only observed/descriptive evidence; ${cited.filter((r) => !OBSERVED_CLASSES.includes(r.analysis_class)).map((r) => r.analysis_class).join(", ")} evidence must be reported as a MODEL_RESULT`);
  if (input.kind === "MODEL_RESULT") {
    if (!input.model_value_ref) errors.push("a MODEL_RESULT must reference the model's own evidence value (model_value_ref)"); else if (!input.evidence_ids.includes(input.model_value_ref)) errors.push("model_value_ref must be one of the cited evidence ids"); else if (known.get(input.model_value_ref) && !MODEL_CLASSES.includes(known.get(input.model_value_ref)!.analysis_class)) errors.push(`model_value_ref points at ${known.get(input.model_value_ref)!.analysis_class} evidence, not a model output`);
    if (input.numeric !== undefined) errors.push("a MODEL_RESULT does not restate numbers: the value lives in the referenced evidence and is never altered");
  }
  if (input.kind === "ANALYST_SYNTHESIS") {
    if (input.numeric !== undefined) errors.push("an ANALYST_SYNTHESIS may not carry a number: that would be a new predictive score");
    if (NEW_SCORE.test(input.text)) errors.push("an ANALYST_SYNTHESIS may not state a new score, rating or projection value");
  }
  if (input.kind !== "ANALYST_SYNTHESIS" && input.numeric !== undefined && input.kind === "OBSERVATION") errors.push("cite the numeric evidence by id; do not restate it");
  const a = assessFinding(s, { chapters: input.chapters, evidence_refs: input.evidence_ids, kind: input.kind, claims_trend: input.claims_trend }, snap);
  if (a.mixed && CURRENT_CLAIM.test(input.text)) errors.push(`this finding rests on mixed-vintage evidence and must not be described as current: ${a.statement}`);
  void stale;
  if (errors.length) return { ok: false, errors };
  const finding: Finding = { id: `f:${shortHash({ k: input.kind, t: input.text, c: [...input.chapters].sort(), e: [...input.evidence_ids].sort() }, 10)}`, kind: input.kind, text: input.text, chapters: input.chapters, evidence_refs: input.evidence_ids, ...(input.model_value_ref ? { model_value_ref: input.model_value_ref } : {}), claim_strength: a.strength, strength_reasons: a.reasons, temporal_context: a.identities, mixed_vintage: a.mixed, vintage_statement: a.statement, cross_chapter: new Set(input.chapters.map((c) => c.split("/")[0])).size > 1 };
  if (s.findings.some((f) => f.id === finding.id)) return { ok: true, session: s, finding: s.findings.find((f) => f.id === finding.id)! };
  const n = structuredClone(s); n.findings.push(finding); return { ok: true, session: n, finding };
}

/* --------------------------------------------------------------------------------------------- report */
export interface CoverageRow { chapter_id: string; number: number; title: string; status: ChapterStatus; researchability: Researchability; depth: number; reason?: string }
export interface SynthesisReport {
  final: boolean; synthesis_permitted: boolean; notes: string[];
  researched: CoverageRow[]; partial: CoverageRow[]; stale: CoverageRow[]; not_researched: CoverageRow[]; not_researchable: CoverageRow[]; support_only: CoverageRow[];
  ranges: { researched: string; not_researched: string; not_researchable: string };
  coverage: { researched: number; total: number; ratio: number };
  conclusions: { strong: Finding[]; tentative: Finding[] };
  by_kind: { model_results: Finding[]; observations: Finding[]; analyst_synthesis: Finding[] };
  cross_chapter_findings: Finding[];
  unresolved_questions: Array<{ chapter: string; number: number; question: string; why: string }>;
  unexamined_dimensions: string[];
  vintage: { sources: EvidenceIdentity[]; mixed: boolean; statement: string; mismatches: string[] };
  limitations: string[]; coverage_hash: string;
}

export const rangesOf = (nums: number[]): string => { const a = [...new Set(nums)].sort((x, y) => x - y); const out: string[] = []; for (let i = 0; i < a.length;) { let j = i; while (j + 1 < a.length && a[j + 1] === a[j]! + 1) j++; out.push(j > i ? `${a[i]}-${a[j]}` : `${a[i]}`); i = j + 1; } return out.length ? out.join(", ") : "none"; };

export const coverageHash = (s: AnalysisBookSession): string => shortHash(canonicalJson(Object.entries(s.chapters).map(([k, v]) => [k, v.status, v.revisions.length, v.depth])), 12);

export function synthesize(s: AnalysisBookSession, snap: CapabilitySnapshot, o: { final: boolean; now: string }): { report: SynthesisReport; session: AnalysisBookSession } {
  const stale = staleMap(s, snap); const rows: CoverageRow[] = [];
  const researched: CoverageRow[] = [], partial: CoverageRow[] = [], staleRows: CoverageRow[] = [], notResearched: CoverageRow[] = [], notResearchable: CoverageRow[] = [], supportOnly: CoverageRow[] = [];
  for (const c of s.contents.filter((x) => x.kind === "EVIDENCE")) {
    const st = s.chapters[c.chapter_id]!; const eff = effectiveStatus(s, c.chapter_id, stale); const r = evaluateChapter(c.needs, s.subject, snap).state;
    const row: CoverageRow = { chapter_id: c.chapter_id, number: c.display_number, title: c.title, status: eff, researchability: r, depth: st.depth }; rows.push(row);
    if (RESEARCHED.includes(st.status) && st.revisions.length) { if (eff === "STALE" || eff === "NEEDS_REFRESH") staleRows.push({ ...row, reason: "a source has updated since this was researched" }); else if (eff === "PARTIAL") partial.push({ ...row, reason: (st.revisions[st.revisions.length - 1]!.coverage.unsatisfied.join("; ")) || "partial evidence" }); else researched.push(row); }
    else if (["UNSUPPORTED", "UNAVAILABLE"].includes(r)) notResearchable.push({ ...row, reason: c.researchability.reasons[0] ?? r });
    else if (st.used_as_support.length) supportOnly.push({ ...row, reason: `evidence used as support for ${[...new Set(st.used_as_support.map((u) => u.by))].join(", ")}; never explored` });
    else notResearched.push(row);
  }
  const evidenceChapters = rows.length; const researchedAll = [...researched, ...partial, ...staleRows];
  const notes: string[] = []; if (!researchedAll.length) notes.push("nothing has been researched: there is no research to synthesize");
  if (notResearched.length + supportOnly.length) notes.push(`${notResearched.length + supportOnly.length} chapter(s) were never opened; conclusions do not cover them`);
  if (notResearchable.length) notes.push(`${notResearchable.length} chapter(s) cannot be researched with current evidence`);
  if (o.final && researchedAll.length < evidenceChapters) notes.push(`FINAL synthesis of PARTIAL coverage: ${researchedAll.length} of ${evidenceChapters} chapters researched — Contents being exhaustive does not mean research was`);
  // reassess every finding against current state so stale/partial support is never presented as settled
  const assessed = s.findings.map((f) => { const a = assessFinding(s, f, snap); return { ...f, claim_strength: a.strength, strength_reasons: a.reasons, temporal_context: a.identities, mixed_vintage: a.mixed, vintage_statement: a.statement } as Finding; });
  const ids = researchedAll.flatMap((r) => (s.chapters[r.chapter_id]!.revisions[s.chapters[r.chapter_id]!.revisions.length - 1]?.identities ?? []));
  const vs = vintageStatement(ids); const bySurface = new Map<string, EvidenceIdentity>(); for (const i of ids) if (!bySurface.has(i.surface)) bySurface.set(i.surface, i);
  const mism: string[] = []; const list = [...bySurface.values()]; for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const a = list[i]!, b = list[j]!; if (a.season !== b.season || a.through_week !== b.through_week || (a.week_state ?? "") !== (b.week_state ?? "")) mism.push(`${a.surface} (${when(a)}) vs ${b.surface} (${when(b)})`); }
  const explored = new Set(researchedAll.flatMap((r) => s.contents.find((c) => c.chapter_id === r.chapter_id)!.tags));
  const unexamined = Object.entries(SEMANTIC_GROUPS).filter(([, g]) => s.contents.some((c) => c.tags.some((t) => g.tags.includes(t))) && !g.tags.some((t) => explored.has(t))).map(([k]) => k);
  const unresolved = [...notResearched, ...supportOnly, ...partial, ...notResearchable].map((r) => ({ chapter: r.chapter_id, number: r.number, question: s.contents.find((c) => c.chapter_id === r.chapter_id)!.question, why: r.reason ?? (r.status === "NOT_OPENED" ? "not researched" : r.status) }));
  const limitations = [...new Set([...notes, ...(vs.mixed ? [vs.statement] : []), ...researchedAll.flatMap((r) => s.chapters[r.chapter_id]!.revisions[s.chapters[r.chapter_id]!.revisions.length - 1]?.limitations.slice(0, 2) ?? [])])].slice(0, 20);
  const report: SynthesisReport = {
    final: o.final, synthesis_permitted: researchedAll.length > 0, notes,
    researched, partial, stale: staleRows, not_researched: notResearched, not_researchable: notResearchable, support_only: supportOnly,
    ranges: { researched: rangesOf(researchedAll.map((r) => r.number)), not_researched: rangesOf([...notResearched, ...supportOnly].map((r) => r.number)), not_researchable: rangesOf(notResearchable.map((r) => r.number)) },
    coverage: { researched: researchedAll.length, total: evidenceChapters, ratio: evidenceChapters ? Math.round((researchedAll.length / evidenceChapters) * 1000) / 1000 : 0 },
    conclusions: { strong: assessed.filter((f) => f.claim_strength === "STRONG"), tentative: assessed.filter((f) => f.claim_strength === "TENTATIVE") },
    by_kind: { model_results: assessed.filter((f) => f.kind === "MODEL_RESULT"), observations: assessed.filter((f) => f.kind === "OBSERVATION"), analyst_synthesis: assessed.filter((f) => f.kind === "ANALYST_SYNTHESIS") },
    cross_chapter_findings: assessed.filter((f) => f.cross_chapter), unresolved_questions: unresolved, unexamined_dimensions: unexamined,
    vintage: { sources: [...bySurface.values()], mixed: vs.mixed, statement: vs.statement, mismatches: mism }, limitations, coverage_hash: coverageHash(s),
  };
  const n = structuredClone(s); n.synthesis_state = { status: o.final ? "FINAL" : "PARTIAL", last_run_at: o.now, coverage_hash: report.coverage_hash };
  return { report, session: n };
}

/** A previously run synthesis is out of date once research state changed. */
export const synthesisIsCurrent = (s: AnalysisBookSession): boolean => s.synthesis_state.status !== "NOT_STARTED" && s.synthesis_state.coverage_hash === coverageHash(s);

export function renderSynthesisText(r: SynthesisReport): string {
  const L: string[] = [r.final ? "FINAL SYNTHESIS" : "SYNTHESIS OF WHAT WE'VE COVERED", ""];
  L.push(`Researched: ${r.ranges.researched}  (${r.coverage.researched} of ${r.coverage.total} chapters)`, `Not researched: ${r.ranges.not_researched}`, `Cannot be researched with current evidence: ${r.ranges.not_researchable}`, "");
  for (const n of r.notes) L.push(`! ${n}`); if (r.notes.length) L.push("");
  L.push(`Evidence vintage: ${r.vintage.statement}`); for (const m of r.vintage.mismatches) L.push(`  mismatch: ${m}`); L.push("");
  const sect = (t: string, fs: Finding[]) => { L.push(`${t} (${fs.length})`); for (const f of fs) L.push(`  [${f.kind}] ${f.text}  — chapters ${f.chapters.join(", ")}; ${f.vintage_statement}${f.claim_strength === "TENTATIVE" ? ` Why tentative: ${f.strength_reasons.join("; ")}` : ""}`); L.push(""); };
  sect("STRONG conclusions", r.conclusions.strong); sect("TENTATIVE conclusions", r.conclusions.tentative);
  L.push(`UNRESOLVED / UNRESEARCHED (${r.unresolved_questions.length})`); for (const u of r.unresolved_questions.slice(0, 40)) L.push(`  ${u.number}. ${u.question}  — ${u.why}`); L.push("");
  if (r.unexamined_dimensions.length) L.push(`Unexamined dimensions: ${r.unexamined_dimensions.join(", ")}`);
  return L.join("\n");
}
