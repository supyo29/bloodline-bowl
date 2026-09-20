/**
 * Phase 3.5D — the ONLY analysis-book module that touches Book-Ready. It executes a ResearchPlan against an
 * EvidenceClient (in-process getEvidence by default), deduplicated and cached, and reduces every block to a small stable
 * EvidenceRef (id + surface + version + through_week) so session state never carries evidence payloads.
 * Read-only: Book-Ready only reads. No fantasy mutation, no model activation.
 */
import type { EvidenceBlock } from "@/lib/book-ready/schema";
import type { CapabilitySnapshot } from "./capability";
import type { PlannedQuery, ResearchPlan } from "./plan";
import type { EvidenceIdentity, EvidenceRef } from "./schema";

export interface EvidenceResponse { status: string; detail?: string; blocks: EvidenceBlock[]; validation?: { ok: boolean }; performance?: { approx_bytes?: number } }
export interface EvidenceClient { get(req: { topic: string; params: Record<string, string>; history: boolean; comparisons: boolean }): Promise<EvidenceResponse> }
export const inProcessClient: EvidenceClient = {
  async get(req) { const { getEvidence } = await import("@/lib/book-ready/query"); return (await getEvidence(req)) as unknown as EvidenceResponse; },
};

export interface QueryResult {
  key: string; topic: string; status: "OK" | "DEFERRED" | "ERROR"; detail: string | null; refs: EvidenceRef[]; identities: EvidenceIdentity[];
  available: number; total: number; limitations: string[]; ms: number; bytes: number; from_cache: boolean; history: boolean; comparisons: boolean;
  /** per-block scale facts used to tell whether evidence for DIFFERENT subjects can be compared (unit kind + comparison population) */
  scales: Array<{ metric: string; subject_id: string; unit_kind: string | null; population: string | null }>;
}

export const refOf = (b: EvidenceBlock): EvidenceRef => ({
  evidence_id: b.evidence_id, surface: b.surface, topic: b.topic, metric: b.metric, subject_id: b.subject.id, availability: b.availability.state, analysis_class: b.origin.analysis_class,
  version: b.lineage.surface_version, season: b.temporal.season, through_week: b.freshness.through_week, week_state: (b.freshness.week_completion as { week_state?: string } | null | undefined)?.week_state ?? b.temporal.week_state ?? null,
  unit_kind: b.unit?.kind ?? null, population: b.comparison?.[0]?.population.id ?? null,
});
const identitiesOf = (refs: EvidenceRef[]): EvidenceIdentity[] => {
  const m = new Map<string, EvidenceIdentity>(); for (const r of refs) { const k = `${r.surface}|${r.version}|${r.through_week}`; if (!m.has(k)) m.set(k, { surface: r.surface, version: r.version, season: r.season, through_week: r.through_week, week_state: r.week_state }); } return [...m.values()];
};

/** Within-session cache. An entry is reused only if it covers the requested history/comparison flags AND the source identity is unchanged. */
export class QueryCache {
  private m = new Map<string, QueryResult>(); hits = 0; misses = 0;
  get(q: PlannedQuery, snap?: CapabilitySnapshot): QueryResult | null {
    const e = this.m.get(q.key); if (!e || e.status !== "OK") { this.misses += 1; return null; }
    if ((q.history && !e.history) || (q.comparisons && !e.comparisons)) { this.misses += 1; return null; }
    if (snap && e.identities.some((i) => snap.vintage[i.surface] && snap.vintage[i.surface]!.version !== i.version)) { this.misses += 1; return null; }
    this.hits += 1; return { ...e, from_cache: true };
  }
  set(r: QueryResult) { this.m.set(r.key, r); }
  get size() { return this.m.size; }
}

export interface Execution { results: Map<string, QueryResult>; calls: number; cache_hits: number; total_ms: number }

export async function executePlan(plan: ResearchPlan, o: { client?: EvidenceClient; cache?: QueryCache; snap?: CapabilitySnapshot; concurrency?: number } = {}): Promise<Execution> {
  const client = o.client ?? inProcessClient; const cache = o.cache ?? new QueryCache(); const results = new Map<string, QueryResult>(); let calls = 0; const t0 = performance.now(); const startHits = cache.hits;
  const run = async (q: PlannedQuery): Promise<void> => {
    if (q.deferred) { results.set(q.key, { key: q.key, topic: q.topic, status: "DEFERRED", detail: q.deferred, refs: [], identities: [], available: 0, total: 0, limitations: [q.deferred], ms: 0, bytes: 0, from_cache: false, history: q.history, comparisons: q.comparisons, scales: [] }); return; }
    const hit = cache.get(q, o.snap); if (hit) { results.set(q.key, hit); return; }
    const t = performance.now(); calls += 1;
    try {
      const r = await client.get({ topic: q.topic, params: q.params, history: q.history, comparisons: q.comparisons });
      const ok = r.status === "OK"; const refs = ok ? r.blocks.map(refOf) : [];
      const lim = [...new Set(r.blocks.flatMap((b) => b.limitations))].slice(0, 8);
      const scales = ok ? r.blocks.filter((b) => b.availability.state === "AVAILABLE").map((b) => ({ metric: b.metric, subject_id: b.subject.id, unit_kind: b.unit?.kind ?? null, population: b.comparison?.[0]?.population.id ?? null })) : [];
      const res: QueryResult = { key: q.key, topic: q.topic, status: ok ? "OK" : "ERROR", detail: ok ? null : `${r.status}${r.detail ? `: ${r.detail}` : ""}`, refs, identities: identitiesOf(refs), available: refs.filter((x) => x.availability === "AVAILABLE").length, total: refs.length, limitations: ok ? lim : [r.detail ?? r.status], ms: Math.round(performance.now() - t), bytes: r.performance?.approx_bytes ?? 0, from_cache: false, history: q.history, comparisons: q.comparisons, scales };
      results.set(q.key, res); if (ok) cache.set(res);
    } catch (e) { results.set(q.key, { key: q.key, topic: q.topic, status: "ERROR", detail: (e as Error).message, refs: [], identities: [], available: 0, total: 0, limitations: [(e as Error).message], ms: Math.round(performance.now() - t), bytes: 0, from_cache: false, history: q.history, comparisons: q.comparisons, scales: [] }); }
  };
  const conc = Math.max(1, o.concurrency ?? 4); const queue = [...plan.queries];
  while (queue.length) await Promise.all(queue.splice(0, conc).map(run));
  return { results, calls, cache_hits: cache.hits - startHits, total_ms: Math.round(performance.now() - t0) };
}

/**
 * Cross-subject comparability: the same metric for DIFFERENT subjects is comparable only if the unit kind matches and the
 * comparison population is the same. Returns human-readable incompatibilities (empty = comparable). Never converts a scale.
 */
export function incomparabilities(results: QueryResult[]): string[] {
  const byMetric = new Map<string, Array<QueryResult["scales"][number]>>();
  for (const r of results) for (const sc of r.scales) byMetric.set(`${r.topic}:${sc.metric}`, [...(byMetric.get(`${r.topic}:${sc.metric}`) ?? []), sc]);
  const out: string[] = [];
  for (const [k, list] of byMetric) {
    if (new Set(list.map((x) => x.subject_id)).size < 2) continue;
    const units = new Set(list.map((x) => x.unit_kind)); const pops = new Set(list.filter((x) => x.population).map((x) => x.population));
    if (units.size > 1) out.push(`INCOMPARABLE ${k}: unit kinds differ (${[...units].join(" vs ")}); no conversion is attempted`);
    if (pops.size > 1) out.push(`NOT DIRECTLY COMPARABLE ${k}: comparison populations differ (${[...pops].join(" vs ")}); percentiles/ranks are relative to different groups`);
  }
  return out;
}
