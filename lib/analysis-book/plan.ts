/**
 * Phase 3.5D — RESEARCH PLANNING: selected chapters (+ depth) -> the exact Book-Ready queries required, with shared
 * retrieval deduplicated. A plan is inspectable data; building it retrieves nothing.
 *
 * Depth ladder (deterministic):
 *   1  the chapter's standard investigation: every REQUIRED need with its declared history / comparison requests
 *   2  + ENRICHMENT needs, and history + comparisons requested wherever the topic can provide them
 *   3  + the chapter's subchapter needs (deep dive)
 * Evidence DEPENDENCIES (depends_on) are retrieved as SUPPORT. Support never marks the supporting chapter explored.
 */
import type { CapabilitySnapshot } from "./capability";
import { bindNeed, evaluateChapter, evaluateNeed, maxCost } from "./capability";
import { shortHash } from "./contents";
import { CHAPTER_LIBRARY } from "./library";
import { TOPIC_META } from "./topics";
import type { AnalysisBookSession, ContentsChapter, CostClass, Need } from "./schema";

export interface QuerySupport { chapter: string; role: "PRIMARY" | "SUPPORT"; via?: string; need: string; required: boolean }
export interface PlannedQuery {
  key: string; topic: string; params: Record<string, string>; history: boolean; comparisons: boolean;
  cost: CostClass; est_ms: number; supports: QuerySupport[];
  /** scenario queries cannot run until the consumer supplies the scenario (never invented) */
  deferred: string | null;
}
export interface Requirement { chapter: string; need: string; reason: string }
export interface ResearchPlan {
  book_id: string; selected: string[]; depth: Record<string, number>; queries: PlannedQuery[]; shared_queries: string[];
  support_only_chapters: string[]; skipped_synthesis: string[];
  unsupported_requirements: Requirement[]; partial_requirements: Requirement[]; missing_context: Requirement[]; deferred_requirements: Requirement[];
  cost: { class: CostClass; est_ms_sequential: number; est_ms_parallel: number; by_class: Record<CostClass, number> };
  dedupe: { naive_query_count: number; unique_query_count: number; saved: number };
  /** honest cost notes the plan cannot remove (e.g. Book-Ready topics that each re-run the same underlying build) */
  warnings: string[];
}
export interface PlanOptions { depth?: Record<string, number>; scenario?: { unavailable: string[] } }

const needLabel = (n: Need) => n.topic ?? n.capability ?? "?";
const chapterOf = (s: AnalysisBookSession, key: string): { c: ContentsChapter; needs: Need[]; sub?: string } => {
  const [id, sub] = key.split("/"); const c = s.contents.find((x) => x.chapter_id === id);
  if (!c) throw new Error(`chapter ${id} is not in this book`);
  if (sub) { const sc = c.subchapters.find((x) => x.id === sub); if (!sc) throw new Error(`subchapter ${key} is not in this book`); return { c, needs: sc.needs, sub }; }
  return { c, needs: c.needs };
};

export function needsAtDepth(c: ContentsChapter, depth: number): Array<{ need: Need; history: boolean; comparisons: boolean }> {
  const out: Array<{ need: Need; history: boolean; comparisons: boolean }> = [];
  const push = (n: Need) => {
    const meta = n.topic ? TOPIC_META[n.topic] : undefined; if (!meta) return;
    // only request what the topic can actually return (an incapable topic would ignore the flag)
    out.push({ need: n, history: (!!n.history || depth >= 2) && meta.history_capable, comparisons: (!!n.comparisons || depth >= 2) && meta.comparison_capable });
  };
  for (const n of c.needs) if (n.role === "required" || depth >= 2) push(n);
  if (depth >= 3) for (const sub of c.subchapters) for (const n of sub.needs) if (!c.needs.includes(n)) push(n);
  return out;
}

const qKey = (topic: string, params: Record<string, string>) => `q:${topic}:${shortHash(params, 10)}`;

export function buildResearchPlan(s: AnalysisBookSession, keys: string[], snap: CapabilitySnapshot, opts: PlanOptions = {}): ResearchPlan {
  const selected = [...new Set(keys)].filter((k) => { const [id] = k.split("/"); return s.contents.find((c) => c.chapter_id === id)?.kind !== "SYNTHESIS"; });
  const skippedSynthesis = [...new Set(keys)].filter((k) => !selected.includes(k));
  const depth: Record<string, number> = {}; const merged = new Map<string, PlannedQuery>(); let naive = 0;
  const unsupported: Requirement[] = []; const partial: Requirement[] = []; const missing: Requirement[] = []; const deferredReq: Requirement[] = [];
  const supportOnly = new Set<string>(); const warnings: string[] = [];
  const selectedIds = new Set(selected.map((k) => k.split("/")[0]!));

  const addQueries = (owner: string, chapterKey: string, c: ContentsChapter, entries: Array<{ need: Need; history: boolean; comparisons: boolean }>, role: "PRIMARY" | "SUPPORT", via?: string) => {
    for (const { need, history, comparisons } of entries) {
      const b = bindNeed(need, s.subject); const label = needLabel(need);
      if (b.missing.length) { if (role === "PRIMARY") missing.push({ chapter: chapterKey, need: label, reason: `needs ${b.missing.join(", ")}` }); continue; }
      for (const raw of b.params) {
        const params = { ...raw }; let deferred: string | null = null;
        if (params.unavailable === "$SCENARIO_INPUT") { if (opts.scenario?.unavailable.length) params.unavailable = opts.scenario.unavailable.join(","); else { deferred = "scenario input (which player(s) are unavailable) must be supplied — never assumed"; delete params.unavailable; } }
        const meta = TOPIC_META[need.topic!]!; naive += 1;
        const key = qKey(need.topic!, { ...params, ...(deferred ? { $deferred: "scenario" } : {}) });
        const sup: QuerySupport = { chapter: chapterKey, role, ...(via ? { via } : {}), need: label, required: need.role === "required" };
        const cur = merged.get(key);
        if (cur) { cur.history ||= history; cur.comparisons ||= comparisons; cur.supports.push(sup); }
        else merged.set(key, { key, topic: need.topic!, params, history, comparisons, cost: meta.cost, est_ms: meta.est_ms, supports: [sup], deferred });
        if (deferred && role === "PRIMARY") deferredReq.push({ chapter: chapterKey, need: label, reason: deferred });
      }
    }
    void owner; void c;
  };

  for (const key of selected) {
    const { c, sub } = chapterOf(s, key); const d = opts.depth?.[key] ?? 1; depth[key] = d;
    const entries = sub ? c.subchapters.find((x) => x.id === sub)!.needs.map((n) => ({ need: n, history: !!n.history, comparisons: !!n.comparisons })).filter((e) => e.need.topic) : needsAtDepth(c, d);
    // requirement accounting comes from the same capability rules Contents used
    for (const n of (sub ? c.subchapters.find((x) => x.id === sub)!.needs : c.needs)) {
      if (n.role === "enrich" && d < 2 && !sub) continue;
      const ev = evaluateNeed(n, s.subject, snap); const label = needLabel(n);
      if (ev.kind === "UNSUPPORTED") unsupported.push({ chapter: key, need: label, reason: ev.reason });
      else if (ev.kind === "SUPPORTED" && ev.flags.length) partial.push({ chapter: key, need: label, reason: `${ev.flags.join("+")}: ${ev.reasons.join("; ")}` });
    }
    addQueries(key, key, c, entries, "PRIMARY");
    // A chapter that cannot run (unsupported, missing context, or scenario input not yet supplied) fetches NOTHING — including
    // its dependencies: support evidence for a chapter that cannot be researched would be wasted retrieval and false progress.
    const runnable = entries.some(({ need }) => !bindNeed(need, s.subject).missing.length && !(need.scenario && !opts.scenario?.unavailable.length));
    if (!runnable && c.depends_on.length && !sub) warnings.push(`${key}: its own evidence cannot run, so its dependencies (${c.depends_on.join(", ")}) were not retrieved`);
    // evidence dependencies: retrieved as SUPPORT; the dependency chapter is NOT explored by this
    for (const dep of runnable || sub ? c.depends_on : []) {
      const dc = s.contents.find((x) => x.chapter_id === dep); if (!dc) continue;
      if (!selectedIds.has(dep)) supportOnly.add(dep);
      addQueries(dep, dep, dc, needsAtDepth(dc, 1).map((e) => ({ ...e, history: false, comparisons: false })), "SUPPORT", key);
    }
  }
  const queries = [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
  // a query that supports a chapter only as SUPPORT while that chapter is itself selected is just that chapter's own evidence
  for (const q of queries) q.supports = q.supports.filter((x) => !(x.role === "SUPPORT" && selectedIds.has(x.chapter.split("/")[0]!)));
  const by: Record<CostClass, number> = { FAST: 0, MODERATE: 0, EXPENSIVE: 0 }; let cls: CostClass = "FAST"; let seq = 0; let par = 0;
  for (const q of queries) { by[q.cost] += 1; cls = maxCost(cls, q.cost); if (!q.deferred) { seq += q.est_ms; par = Math.max(par, q.est_ms); } }
  return {
    book_id: s.book_id, selected, depth, queries, shared_queries: queries.filter((q) => new Set(q.supports.map((x) => x.chapter)).size > 1).map((q) => q.key),
    support_only_chapters: [...supportOnly].sort(), skipped_synthesis: skippedSynthesis,
    unsupported_requirements: unsupported, partial_requirements: partial, missing_context: missing, deferred_requirements: deferredReq,
    cost: { class: cls, est_ms_sequential: seq, est_ms_parallel: par, by_class: by }, dedupe: { naive_query_count: naive, unique_query_count: queries.length, saved: naive - queries.length },
    warnings: [...warnings, ...sharedBuildWarnings(queries)],
  };
}

/** startsit.shadow, matchup.shadow and waiver.status each run their OWN weekly build in Book-Ready today; the plan reports that instead of pretending to share it. */
const WEEKLY_BUILD_TOPICS = new Set(["startsit.shadow", "matchup.shadow", "waiver.status"]);
function sharedBuildWarnings(queries: PlannedQuery[]): string[] {
  const g = new Map<string, string[]>(); for (const q of queries) if (WEEKLY_BUILD_TOPICS.has(q.topic) && !q.deferred) { const k = `${q.params.league}/${q.params.manager}`; g.set(k, [...(g.get(k) ?? []), q.topic]); }
  return [...g].filter(([, t]) => t.length > 1).map(([k, t]) => `${t.length} topics (${t.join(", ")}) for ${k} each re-run the weekly build inside Book-Ready (not shared today); expect ~${t.length}× the single-topic latency`);
}

/** Per-chapter view of a plan (which queries answer that chapter), for inspection and tests. */
export const queriesFor = (p: ResearchPlan, chapter: string, role?: "PRIMARY" | "SUPPORT") => p.queries.filter((q) => q.supports.some((x) => x.chapter === chapter && (!role || x.role === role)));
export { evaluateChapter, CHAPTER_LIBRARY };
