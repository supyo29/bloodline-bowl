/**
 * Phase 3.5D — chapter research orchestration: plan -> execute -> record. Chapters selected together share ONE plan
 * (shared retrieval happens once); each selected chapter is recorded EXPLORED/PARTIAL from ITS OWN primary evidence;
 * evidence fetched only as a dependency is recorded as USED_AS_SUPPORT on the supporting chapter and leaves it NOT_OPENED.
 */
import type { CapabilitySnapshot } from "./capability";
import { CHAPTER_LIBRARY } from "./library";
import { buildResearchPlan, type PlanOptions, type ResearchPlan } from "./plan";
import { executePlan, incomparabilities, QueryCache, type EvidenceClient, type Execution, type QueryResult } from "./executor";
import { beginResearch, recordChapterResearch, recordSupport, type ChapterResearchResult } from "./session";
import type { AnalysisBookSession, EvidenceRef, Need } from "./schema";

export interface ResearchOutcome { session: AnalysisBookSession; plan: ResearchPlan; execution: Execution; chapters: Record<string, { status: string; satisfied: string[]; unsatisfied: string[]; evidence_refs: number }> }

const label = (n: Need) => n.topic ?? n.capability ?? "?";

export async function researchChapters(s0: AnalysisBookSession, keys: string[], o: { snap: CapabilitySnapshot; client?: EvidenceClient; cache?: QueryCache; now: string; depth?: Record<string, number> } & Pick<PlanOptions, "scenario">): Promise<ResearchOutcome> {
  const plan = buildResearchPlan(s0, keys, o.snap, { depth: o.depth, scenario: o.scenario });
  let s = beginResearch(s0, plan.selected);
  const exec = await executePlan(plan, { client: o.client, cache: o.cache, snap: o.snap });
  const chapters: ResearchOutcome["chapters"] = {};
  for (const key of plan.selected) {
    const [id, sub] = key.split("/"); const c = s.contents.find((x) => x.chapter_id === id)!;
    const primary = plan.queries.filter((q) => q.supports.some((x) => x.chapter === key && x.role === "PRIMARY"));
    const results = primary.map((q) => exec.results.get(q.key)!).filter(Boolean);
    const refs = new Map<string, EvidenceRef>(); for (const r of results) for (const e of r.refs) refs.set(e.evidence_id, e);
    const identities = new Map<string, QueryResult["identities"][number]>(); for (const r of results) for (const i of r.identities) identities.set(`${i.surface}|${i.version}|${i.through_week}`, i);
    // coverage is judged per REQUIRED need: satisfied only if every query serving it returned available evidence
    const needs = sub ? c.subchapters.find((x) => x.id === sub)!.needs : c.needs.filter((n) => n.role === "required");
    const satisfied: string[] = []; const unsatisfied: string[] = [];
    for (const n of needs) {
      const l = label(n); if (n.capability) { unsatisfied.push(`${l} (unsupported)`); continue; }
      const qs = primary.filter((q) => q.topic === n.topic && q.supports.some((x) => x.chapter === key && x.need === l));
      if (!qs.length) { unsatisfied.push(`${l} (missing context)`); continue; }
      const rs = qs.map((q) => exec.results.get(q.key)!);
      if (rs.some((r) => r.status === "DEFERRED")) unsatisfied.push(`${l} (scenario input required)`); else if (rs.every((r) => r.status === "OK" && r.available > 0)) satisfied.push(l); else unsatisfied.push(`${l} (no available evidence)`);
    }
    const limitations = [...new Set([...results.flatMap((r) => (r.detail ? [r.detail] : [])), ...results.flatMap((r) => r.limitations), ...incomparabilities(results), ...plan.unsupported_requirements.filter((u) => u.chapter === key).map((u) => u.reason), ...plan.partial_requirements.filter((u) => u.chapter === key).map((u) => u.reason)])];
    const res: ChapterResearchResult = { depth: plan.depth[key] ?? 1, identities: [...identities.values()], evidence_refs: [...refs.values()], query_keys: primary.map((q) => q.key), coverage: { satisfied, unsatisfied }, limitations };
    s = recordChapterResearch(s, key, res, o.now);
    chapters[key] = { status: s.chapters[key]!.status, satisfied, unsatisfied, evidence_refs: refs.size };
  }
  // dependency evidence: USED_AS_SUPPORT only, and only for chapters the user did not select
  const selectedIds = new Set(plan.selected.map((k) => k.split("/")[0]!));
  const supportByChapter = new Map<string, { via: string; refs: Map<string, EvidenceRef> }>();
  for (const q of plan.queries) for (const sup of q.supports) if (sup.role === "SUPPORT" && !selectedIds.has(sup.chapter)) {
    const cur = supportByChapter.get(`${sup.chapter}<-${sup.via}`) ?? { via: sup.via ?? "?", refs: new Map() }; for (const e of exec.results.get(q.key)?.refs ?? []) cur.refs.set(e.evidence_id, e); supportByChapter.set(`${sup.chapter}<-${sup.via}`, cur);
  }
  for (const [k, v] of supportByChapter) { const ch = k.split("<-")[0]!; if (v.refs.size && s.chapters[ch]) s = recordSupport(s, ch, v.via, [...v.refs.values()], o.now); }
  void CHAPTER_LIBRARY;
  return { session: s, plan, execution: exec, chapters };
}
