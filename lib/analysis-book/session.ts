/**
 * Phase 3.5D — session/book STATE: pure functions over an AnalysisBookSession (each returns a NEW session; inputs are
 * never mutated). Explicit state, never conversational memory:
 *   - EXPLORED vs USED_AS_SUPPORT are tracked separately (support use never marks a chapter explored)
 *   - research revisions are preserved (a refresh appends; older research is not silently replaced)
 *   - STALE is DERIVED by comparing stored evidence identity with the current source identity (never wall-clock)
 *   - serialization is canonical and hash-verified, and remembers the taxonomy that generated the book
 */
import { CHAPTER_LIBRARY, TEMPLATES } from "./library";
import { canonicalJson, shortHash } from "./contents";
import type { CapabilitySnapshot } from "./capability";
import { ANALYSIS_BOOK_CONTRACT, TAXONOMY_VERSION, type AnalysisBookSession, type ChapterRevision, type ChapterStatus, type EvidenceIdentity, type EvidenceRef } from "./schema";

const clone = <T>(x: T): T => structuredClone(x);
export const MAX_DEPTH = 3;

/** chapter key: `chapter_id` or `chapter_id/SUB` for a subchapter */
export const stateOf = (s: AnalysisBookSession, key: string) => { const st = s.chapters[key]; if (!st) throw new Error(`unknown chapter key ${key}`); return st; };

export interface ChapterResearchResult {
  depth: number; identities: EvidenceIdentity[]; evidence_refs: EvidenceRef[]; query_keys: string[];
  coverage: { satisfied: string[]; unsatisfied: string[] }; limitations: string[];
}

export function beginResearch(s: AnalysisBookSession, keys: string[]): AnalysisBookSession {
  const n = clone(s);
  for (const k of keys) { const st = stateOf(n, k); if (st.status === "NOT_OPENED") st.status = "RESEARCHING"; }
  n.current_chapter = keys[0]?.split("/")[0] ?? n.current_chapter; return n;
}

/** Record a finished chapter research. No evidence at all => the chapter is NOT marked researched (it is reported blocked). */
export function recordChapterResearch(s: AnalysisBookSession, key: string, r: ChapterResearchResult, now: string): AnalysisBookSession {
  const n = clone(s); const st = stateOf(n, key);
  const usable = r.evidence_refs.filter((e) => e.availability === "AVAILABLE");
  if (!usable.length) {
    st.blocked_reason = r.limitations.join("; ") || "no evidence available for this chapter";
    if (st.status === "RESEARCHING") st.status = st.revisions.length ? (st.revisions[st.revisions.length - 1]!.status) : "NOT_OPENED";
    return n;
  }
  const status: ChapterStatus = r.coverage.unsatisfied.length ? "PARTIAL" : "EXPLORED";
  const rev: ChapterRevision = { revision: st.revisions.length + 1, depth: r.depth, researched_at: now, identities: r.identities, evidence_refs: r.evidence_refs, query_keys: r.query_keys, coverage: r.coverage, status, limitations: r.limitations };
  st.revisions.push(rev); st.status = status; st.depth = Math.max(st.depth, r.depth); st.blocked_reason = null;
  n.current_chapter = key.split("/")[0]!; return n;
}

/** Evidence retrieved on behalf of ANOTHER chapter. Recorded as support; never changes the supported chapter's status. */
export function recordSupport(s: AnalysisBookSession, key: string, by: string, refs: EvidenceRef[], now: string): AnalysisBookSession {
  const n = clone(s); stateOf(n, key).used_as_support.push({ by, at: now, evidence_refs: refs }); return n;
}

export function selectPart(s: AnalysisBookSession, partId: string | null): AnalysisBookSession { const n = clone(s); n.selected_part = partId; return n; }

export type DeeperResult = { ok: true; key: string; nextDepth: number } | { ok: false; message: string };
export function goDeeper(s: AnalysisBookSession, key?: string | null): DeeperResult {
  const k = key ?? s.current_chapter; if (!k) return { ok: false, message: "no current chapter; open a chapter first" };
  const st = s.chapters[k]; if (!st) return { ok: false, message: `unknown chapter ${k}` };
  if (!["EXPLORED", "PARTIAL", "STALE", "NEEDS_REFRESH"].includes(st.status)) return { ok: false, message: `chapter ${k} has not been researched yet; open it first` };
  if (st.depth >= MAX_DEPTH) return { ok: false, message: `chapter ${k} is already at maximum depth (${MAX_DEPTH}); use its subchapters or a related chapter` };
  return { ok: true, key: k, nextDepth: st.depth + 1 };
}

export function markNeedsRefresh(s: AnalysisBookSession, keys: string[]): { session: AnalysisBookSession; refreshed: string[]; skipped: string[] } {
  const n = clone(s); const refreshed: string[] = []; const skipped: string[] = [];
  for (const k of keys) { const st = stateOf(n, k); if (["EXPLORED", "PARTIAL", "STALE"].includes(st.status)) { st.status = "NEEDS_REFRESH"; refreshed.push(k); } else skipped.push(k); }
  return { session: n, refreshed, skipped };
}

/* ------------------------------------------------------------------------------------------ staleness */
export interface StaleReason { surface: string; kind: "NEW_THROUGH_WEEK" | "WEEK_COMPLETED" | "SEASON_CHANGED" | "VERSION_CHANGED"; from: string | null; to: string | null }
export interface StaleReport { key: string; stale: boolean; reasons: StaleReason[] }

const surfaceOf = (i: EvidenceIdentity[], surface: string) => i.find((x) => x.surface === surface);
/** Compare the identity a chapter was researched against with the CURRENT source identity. Time itself never makes anything stale. */
export function staleness(s: AnalysisBookSession, snap: CapabilitySnapshot): StaleReport[] {
  const out: StaleReport[] = [];
  for (const [key, st] of Object.entries(s.chapters)) {
    if (!["EXPLORED", "PARTIAL", "STALE", "NEEDS_REFRESH"].includes(st.status)) continue;
    const rev = st.revisions[st.revisions.length - 1]; if (!rev) continue;
    const reasons: StaleReason[] = [];
    for (const old of rev.identities) {
      const cur = snap.vintage[old.surface]; if (!cur) continue;
      if (old.season !== null && cur.season !== null && cur.season !== old.season) reasons.push({ surface: old.surface, kind: "SEASON_CHANGED", from: String(old.season), to: String(cur.season) });
      else if (old.through_week !== null && cur.through_week !== null && cur.through_week > old.through_week) reasons.push({ surface: old.surface, kind: "NEW_THROUGH_WEEK", from: `w${old.through_week}`, to: `w${cur.through_week}` });
      else if (old.week_state && cur.week_state && old.week_state !== cur.week_state && cur.week_state === "COMPLETE") reasons.push({ surface: old.surface, kind: "WEEK_COMPLETED", from: old.week_state, to: cur.week_state });
      else if (old.version && cur.version && old.version !== cur.version) reasons.push({ surface: old.surface, kind: "VERSION_CHANGED", from: old.version, to: cur.version });
    }
    out.push({ key, stale: reasons.length > 0, reasons });
  }
  return out;
}

/** Derived status: a researched chapter whose evidence identity changed is STALE (its research is preserved). */
export function effectiveStatus(s: AnalysisBookSession, key: string, stale: Map<string, StaleReport>): ChapterStatus {
  const st = stateOf(s, key);
  if (st.status === "NEEDS_REFRESH") return "NEEDS_REFRESH";
  if (["EXPLORED", "PARTIAL"].includes(st.status) && stale.get(key)?.stale) return "STALE";
  return st.status;
}
export const staleMap = (s: AnalysisBookSession, snap: CapabilitySnapshot) => new Map(staleness(s, snap).map((r) => [r.key, r]));

/* ------------------------------------------------------------------------------------------ serialization */
export const SESSION_FORMAT = "analysis-book-session:1";
export function serializeSession(s: AnalysisBookSession): string {
  const body = canonicalJson(s); return canonicalJson({ format: SESSION_FORMAT, hash: shortHash(body, 16), session: JSON.parse(body) });
}
export interface TaxonomyDrift { drifted: boolean; stored_taxonomy: string; current_taxonomy: string; removed_chapters: string[]; added_chapters: string[] }
export function deserializeSession(text: string): { session: AnalysisBookSession; drift: TaxonomyDrift } {
  const env = JSON.parse(text) as { format?: string; hash?: string; session?: AnalysisBookSession };
  if (env.format !== SESSION_FORMAT || !env.session) throw new Error(`not a ${SESSION_FORMAT} document`);
  if (env.hash !== shortHash(canonicalJson(env.session), 16)) throw new Error("session hash mismatch: the saved book was modified or corrupted");
  const s = env.session; if (!s.analysis_book_contract?.startsWith("analysis-book-")) throw new Error("unknown analysis book contract");
  // a saved book keeps the interpretation it was created under; drift is REPORTED, never applied silently
  const stored = new Set(s.contents.map((c) => c.chapter_id)); const cur = new Set(s.book_types.flatMap((t) => TEMPLATES[t]?.parts.flatMap((p) => p.chapters) ?? []).filter((id) => CHAPTER_LIBRARY[id]));
  const removed = [...stored].filter((id) => !CHAPTER_LIBRARY[id]); const added = [...cur].filter((id) => !stored.has(id) && id !== "book.final_synthesis");
  return { session: s, drift: { drifted: s.taxonomy_version !== TAXONOMY_VERSION || removed.length > 0, stored_taxonomy: s.taxonomy_version, current_taxonomy: TAXONOMY_VERSION, removed_chapters: removed, added_chapters: added } };
}
export { ANALYSIS_BOOK_CONTRACT };
