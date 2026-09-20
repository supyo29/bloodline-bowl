/**
 * Phase 3.5D — the navigation grammar. Deterministic parsing and resolution of what the user typed:
 *   4 | 4, 7, 12 | 4-9 | Part II | Parts I and IV | the workload chapters | everything about touchdowns | 18A
 *   next | next chapter | next 3 | everything remaining | contents | go deeper | refresh 4 | refresh Part II |
 *   refresh what we've covered | synthesize what we've covered | final synthesis
 * Parsing never touches evidence. Invalid input fails with a message that says what IS valid.
 */
import type { AnalysisBookSession } from "./schema";

export type Selector =
  | { kind: "numbers"; items: Array<{ from: number; to: number } | { label: string }> }
  | { kind: "parts"; refs: string[] }
  | { kind: "semantic"; phrase: string }
  | { kind: "remaining" } | { kind: "all" } | { kind: "covered" };

export type Command =
  | { kind: "contents" } | { kind: "select"; selector: Selector } | { kind: "next"; count: number } | { kind: "go_deeper"; target?: Selector }
  | { kind: "refresh"; selector: Selector } | { kind: "synthesize"; final: boolean } | { kind: "invalid"; message: string; input: string };

/** phrase keywords -> chapter tags. Groups are semantic (by tag), never by position. */
export const SEMANTIC_GROUPS: Record<string, { tags: string[]; words: string[] }> = {
  workload: { tags: ["workload"], words: ["workload", "usage", "volume", "opportunity"] },
  touchdowns: { tags: ["touchdowns"], words: ["touchdown", "td", "red zone", "redzone", "goal line", "scoring"] },
  role: { tags: ["role"], words: ["role"] },
  matchup: { tags: ["matchup"], words: ["matchup"] },
  coverage: { tags: ["coverage"], words: ["coverage"] },
  pressure: { tags: ["pressure", "protection"], words: ["pressure", "protection", "pass rush", "blitz"] },
  scheme: { tags: ["scheme"], words: ["scheme", "coaching", "tendenc"] },
  schedule: { tags: ["schedule"], words: ["schedule"] },
  efficiency: { tags: ["efficiency", "explosiveness"], words: ["efficien", "explosive"] },
  injury: { tags: ["injury", "contingency"], words: ["injur", "contingenc"] },
  roster: { tags: ["roster"], words: ["roster", "lineup"] },
  uncertainty: { tags: ["uncertainty", "risk"], words: ["uncertain", "risk", "confidence"] },
  projection: { tags: ["projection"], words: ["projection", "floor", "ceiling", "outlook range"] },
  market: { tags: ["market", "trade", "value"], words: ["market", "trade value"] },
  history: { tags: ["history", "trend", "trajectory"], words: ["history", "historical", "trend", "trajectory"] },
  team: { tags: ["team_environment"], words: ["team environment", "team context"] },
};

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const WORDNUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const clean = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/[?!.]+$/g, "").replace(/\s+/g, " ").trim();

function parseSelector(t: string, input: string): Selector | { error: string } {
  if (/^(everything remaining|all remaining|remaining|the rest|everything else|everything left)$/.test(t)) return { kind: "remaining" };
  if (/^(everything|all|all chapters|every chapter)$/.test(t)) return { kind: "all" };
  if (/^(what we'?ve covered|what we have covered|everything (we'?ve|we have) covered|covered|what'?s covered)$/.test(t)) return { kind: "covered" };
  const pm = /^parts? (.+)$/.exec(t) ?? /^(p\d+.*)$/.exec(t);
  if (pm) { const refs = pm[1]!.split(/,| and | & |\s+/).map((x) => x.trim()).filter((x) => x && x !== "and"); if (!refs.length) return { error: `${input}: name a Part, e.g. "Part II"` }; return { kind: "parts", refs }; }
  const num = /^(\d+[a-z]?(?:\s*(?:-|–|to|through)\s*\d+)?(?:\s*(?:,|and|&)\s*\d+[a-z]?(?:\s*(?:-|–|to|through)\s*\d+)?)*)$/.exec(t.replace(/^(chapters?|ch\.?) /, ""));
  if (num) {
    const items: Array<{ from: number; to: number } | { label: string }> = [];
    for (const piece of num[1]!.split(/\s*(?:,|and|&)\s*/)) {
      const r = /^(\d+)\s*(?:-|–|to|through)\s*(\d+)$/.exec(piece); const sub = /^(\d+)([a-z])$/.exec(piece);
      if (r) items.push({ from: Number(r[1]), to: Number(r[2]) }); else if (sub) items.push({ label: `${sub[1]}${sub[2]!.toUpperCase()}` }); else items.push({ from: Number(piece), to: Number(piece) });
    }
    return { kind: "numbers", items };
  }
  const sem = /^(?:the |all (?:the )?|everything about |anything about |everything on |all about )?(.+?)(?: chapters?)?$/.exec(t);
  if (sem && (/chapters?$/.test(t) || /^(everything|anything|all) (about|on)/.test(t) || /^all /.test(t))) return { kind: "semantic", phrase: sem[1]!.trim() };
  return { error: `${input}: not a chapter number, range, Part or topic. Try "4", "4, 7", "4-9", "Part II", "the workload chapters", "next 3", "contents".` };
}

export function parseCommand(input: string): Command {
  const t = clean(input);
  if (!t) return { kind: "invalid", message: "empty input; try \"contents\"", input };
  if (/^(contents|show contents|table of contents|toc|show the contents|show me the contents|contents please)$/.test(t)) return { kind: "contents" };
  let m = /^next(?: (?!chapters?$)(\d+|[a-z]+))?(?: chapters?)?$/.exec(t);
  if (m) { const n = m[1] ? (WORDNUM[m[1]] ?? Number(m[1])) : 1; if (!Number.isInteger(n) || n < 1 || n > 30) return { kind: "invalid", message: `"${input}": how many? try "next", "next 3"`, input }; return { kind: "next", count: n }; }
  if (/^(go deeper|deeper|dig deeper|go deeper on this|more depth)$/.test(t)) return { kind: "go_deeper" };
  m = /^go deeper (?:on |into )?(.+)$/.exec(t); if (m) { const s = parseSelector(m[1]!, input); return "error" in s ? { kind: "invalid", message: s.error, input } : { kind: "go_deeper", target: s }; }
  m = /^refresh (.+)$/.exec(t); if (m) { const s = parseSelector(m[1]!, input); return "error" in s ? { kind: "invalid", message: s.error, input } : { kind: "refresh", selector: s }; }
  if (/^(final synthesis|the final synthesis|synthesize everything|give me the final synthesis)$/.test(t)) return { kind: "synthesize", final: true };
  if (/^(synthesi[sz]e|synthesi[sz]e (what we'?ve covered|what we have covered|so far|everything we'?ve covered)|summari[sz]e what we'?ve covered)$/.test(t)) return { kind: "synthesize", final: false };
  const s = parseSelector(t.replace(/^(open|show|research|read|do|give me|take me to|let'?s do) /, ""), input);
  return "error" in s ? { kind: "invalid", message: s.error, input } : { kind: "select", selector: s };
}

/* ---------------------------------------------------------------------------------------------- resolution */
export type Resolution = { ok: true; keys: string[]; notes: string[] } | { ok: false; message: string };
const order = (s: AnalysisBookSession): string[] => s.contents.flatMap((c) => [c.chapter_id]);
export const isResearchable = (s: AnalysisBookSession, id: string): boolean => { const c = s.contents.find((x) => x.chapter_id === id); return !!c && c.kind === "EVIDENCE" && !["UNSUPPORTED", "UNAVAILABLE"].includes(c.researchability.state); };
const partIndexRef = (s: AnalysisBookSession, ref: string): number => {
  const r = ref.toLowerCase(); if (ROMAN[r]) return ROMAN[r]! - 1; if (/^\d+$/.test(r)) return Number(r) - 1;
  const byId = s.parts.findIndex((p) => p.id.toLowerCase() === r); return byId;
};

export function resolveSelector(s: AnalysisBookSession, sel: Selector): Resolution {
  const max = s.contents.length; const notes: string[] = [];
  const idAt = (n: number) => s.contents[n - 1]!.chapter_id;
  switch (sel.kind) {
    case "numbers": {
      const keys: string[] = [];
      for (const it of sel.items) {
        if ("label" in it) { const n = Number(it.label.slice(0, -1)); const c = s.contents[n - 1]; const sub = c?.subchapters.find((x) => x.label === it.label); if (!c || !sub) return { ok: false, message: `no subchapter ${it.label} in this book${c ? ` (chapter ${n} has ${c.subchapters.length ? c.subchapters.map((x) => x.label).join(", ") : "no subchapters"})` : ""}` }; keys.push(`${c.chapter_id}/${sub.id}`); continue; }
        if (it.from < 1 || it.to > max) return { ok: false, message: `chapter ${it.from < 1 ? it.from : it.to} does not exist: this book has chapters 1–${max}` };
        if (it.from > it.to) return { ok: false, message: `range ${it.from}-${it.to} is backwards; did you mean ${it.to}-${it.from}?` };
        for (let n = it.from; n <= it.to; n++) keys.push(idAt(n));
      }
      return { ok: true, keys: [...new Set(keys)], notes };
    }
    case "parts": {
      const keys: string[] = [];
      for (const ref of sel.refs) { const i = partIndexRef(s, ref); const p = s.parts[i]; if (!p) return { ok: false, message: `no Part "${ref}": this book has ${s.parts.map((x, k) => `Part ${["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][k] ?? k + 1} (${x.title})`).join("; ")}` }; keys.push(...s.contents.filter((c) => c.part_id === p.id).map((c) => c.chapter_id)); }
      return { ok: true, keys: [...new Set(keys)], notes };
    }
    case "semantic": {
      const phrase = sel.phrase.toLowerCase(); const group = Object.entries(SEMANTIC_GROUPS).find(([k, g]) => phrase === k || g.words.some((w) => phrase.includes(w)));
      const avail = Object.entries(SEMANTIC_GROUPS).filter(([, g]) => s.contents.some((c) => c.tags.some((t) => g.tags.includes(t)))).map(([k]) => k);
      if (!group) return { ok: false, message: `no chapter group matches "${sel.phrase}". Groups in this book: ${avail.join(", ")}` };
      const keys = s.contents.filter((c) => c.tags.some((t) => group[1].tags.includes(t))).map((c) => c.chapter_id);
      if (!keys.length) return { ok: false, message: `this book has no "${group[0]}" chapters. Groups in this book: ${avail.join(", ")}` };
      notes.push(`"${sel.phrase}" resolved to the ${group[0]} group (tags: ${group[1].tags.join(", ")}): ${keys.length} chapter(s)`);
      return { ok: true, keys, notes };
    }
    case "all": return { ok: true, keys: order(s), notes };
    case "remaining": {
      const open = s.contents.filter((c) => c.kind === "EVIDENCE" && s.chapters[c.chapter_id]!.status === "NOT_OPENED"); const keys = open.filter((c) => isResearchable(s, c.chapter_id) && !s.chapters[c.chapter_id]!.blocked_reason).map((c) => c.chapter_id);
      const skipped = open.filter((c) => !keys.includes(c.chapter_id)).map((c) => c.display_number);
      if (skipped.length) notes.push(`not researchable with current evidence (or blocked pending input), left out: ${skipped.join(", ")}`);
      if (!keys.length) return { ok: false, message: "no researchable chapters remain" };
      return { ok: true, keys, notes };
    }
    case "covered": {
      const keys = s.contents.filter((c) => ["EXPLORED", "PARTIAL", "STALE", "NEEDS_REFRESH"].includes(s.chapters[c.chapter_id]!.status)).map((c) => c.chapter_id);
      return keys.length ? { ok: true, keys, notes } : { ok: false, message: "nothing has been researched yet" };
    }
  }
}

/** Next n chapters in BOOK ORDER after the current chapter that have not been opened and can be researched (never assumes linear reading). */
export function nextChapters(s: AnalysisBookSession, count: number): Resolution {
  const ids = order(s); const start = s.current_chapter ? ids.indexOf(s.current_chapter) + 1 : 0;
  // a chapter that was already attempted and is BLOCKED (e.g. needs a scenario input) is not proposed again by Next; open it by number once the input exists
  const pick = (from: number, to: number) => ids.slice(from, to).filter((id) => s.chapters[id]!.status === "NOT_OPENED" && !s.chapters[id]!.blocked_reason && isResearchable(s, id));
  const after = pick(start, ids.length); const before = pick(0, start);
  const keys = [...after, ...before].slice(0, count); const notes: string[] = [];
  if (!keys.length) return { ok: false, message: "every researchable chapter has been opened; try \"contents\", \"go deeper\", \"refresh …\" or \"final synthesis\"" };
  if (keys.length < count) notes.push(`only ${keys.length} unopened researchable chapter(s) remain`);
  if (after.length < Math.min(count, keys.length)) notes.push("wrapped to earlier unopened chapters");
  return { ok: true, keys, notes };
}
