/** Phase 3.5D — machine-readable Contents view + a basic plain-text rendering (NOT the Phase 10 UI). Cheap: re-displaying never re-researches. */
import type { CapabilitySnapshot } from "./capability";
import { evaluateChapter } from "./capability";
import { effectiveStatus, staleMap, stateOf } from "./session";
import type { AnalysisBookSession, ChapterStatus, CostClass, Researchability } from "./schema";

export interface ContentsRow { number: number; label: string; key: string; chapter_id: string; title: string; researchability: Researchability; status: ChapterStatus; used_as_support: boolean; update_available: boolean; blocked_reason: string | null; cost: CostClass; depth: number; current: boolean; is_subchapter: boolean }
export interface ContentsView {
  book_id: string; question: string; book_types: string[]; contents_version: string; taxonomy_version: string;
  parts: Array<{ id: string; title: string; rows: ContentsRow[] }>;
  progress: { total: number; explored: number; partial: number; stale: number; needs_refresh: number; not_opened: number; unresearchable: number; support_only: number };
}
const MARK: Record<ChapterStatus, string> = { NOT_OPENED: " ", RESEARCHING: "…", EXPLORED: "✓", PARTIAL: "~", STALE: "↻", NEEDS_REFRESH: "⟳" };

export function contentsView(s: AnalysisBookSession, snap?: CapabilitySnapshot, opts: { subchapters?: boolean } = {}): ContentsView {
  const stale = snap ? staleMap(s, snap) : new Map();
  const parts = s.parts.map((p) => ({ id: p.id, title: p.title, rows: [] as ContentsRow[] }));
  const prog = { total: 0, explored: 0, partial: 0, stale: 0, needs_refresh: 0, not_opened: 0, unresearchable: 0, support_only: 0 };
  for (const c of s.contents) {
    const st = stateOf(s, c.chapter_id); const status = effectiveStatus(s, c.chapter_id, stale);
    // researchability is re-derived from the CURRENT capability snapshot when one is supplied; otherwise the frozen creation-time value is shown
    const r = snap && c.kind === "EVIDENCE" ? evaluateChapter(c.needs, s.subject, snap) : c.researchability;
    const row = (label: string, key: string, title: string, isSub: boolean, res: Researchability, stt: ReturnType<typeof stateOf>, stat: ChapterStatus): ContentsRow => ({ number: c.display_number, label, key, chapter_id: c.chapter_id, title, researchability: res, status: stat, used_as_support: stat === "NOT_OPENED" && stt.used_as_support.length > 0, update_available: stat === "STALE", blocked_reason: stt.blocked_reason ?? null, cost: r.cost, depth: stt.depth, current: s.current_chapter === c.chapter_id && !isSub, is_subchapter: isSub });
    parts.find((p) => p.id === c.part_id)!.rows.push(row(String(c.display_number), c.chapter_id, c.title, false, r.state, st, status));
    if (opts.subchapters) for (const sub of c.subchapters) { const k = `${c.chapter_id}/${sub.id}`; const sst = stateOf(s, k); parts.find((p) => p.id === c.part_id)!.rows.push(row(sub.label, k, sub.title, true, evaluateChapter(sub.needs, s.subject, snap ?? { registry_version: "", season: s.subject.season, surfaces: {}, vintage: {}, history_weeks: {}, frontier: null }).state, sst, sst.status)); }
    if (c.kind === "EVIDENCE") {
      prog.total += 1;
      if (status === "EXPLORED") prog.explored += 1; else if (status === "PARTIAL") prog.partial += 1; else if (status === "STALE") prog.stale += 1; else if (status === "NEEDS_REFRESH") prog.needs_refresh += 1; else if (["UNSUPPORTED", "UNAVAILABLE"].includes(r.state)) prog.unresearchable += 1; else prog.not_opened += 1;
      if (status === "NOT_OPENED" && st.used_as_support.length) prog.support_only += 1;
    }
  }
  return { book_id: s.book_id, question: s.question, book_types: s.book_types, contents_version: s.contents_version, taxonomy_version: s.taxonomy_version, parts, progress: prog };
}

export function renderContentsText(v: ContentsView): string {
  const lines: string[] = [`${v.question}  [${v.book_types.join(" + ")}]`, ""];
  for (const [i, p] of v.parts.entries()) {
    lines.push(`PART ${["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][i] ?? i + 1} — ${p.title}`, "");
    for (const r of p.rows) {
      const mark = r.current ? "→" : r.used_as_support ? "◦" : MARK[r.status];
      const state = r.status === "NOT_OPENED" || r.status === "RESEARCHING" ? r.researchability : `${r.status}${r.update_available ? " — update available" : ""}${r.researchability === "READY" ? "" : ` (${r.researchability})`}`;
      lines.push(`  ${r.is_subchapter ? "    " : ""}${mark} ${r.label.padStart(r.is_subchapter ? 3 : 2)}. ${r.title.padEnd(40)} ${state}${r.cost === "FAST" ? "" : `  [${r.cost}]`}${r.blocked_reason ? "  ! blocked" : ""}`);
    }
    lines.push("");
  }
  const g = v.progress; lines.push(`Progress: ${g.explored} explored, ${g.partial} partial, ${g.stale} stale, ${g.needs_refresh} refresh queued, ${g.not_opened} not opened, ${g.unresearchable} not researchable with current evidence (of ${g.total}).`);
  return lines.join("\n");
}
