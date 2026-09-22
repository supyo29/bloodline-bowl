/**
 * Phase 3.5D — book creation: question -> classification -> subject -> EXHAUSTIVE Contents (Parts + chapters), each chapter
 * carrying capability-aware researchability. Uses ONLY the taxonomy, the surface registry and manifests. It performs no
 * evidence queries and runs no model, so creating a 30+ chapter book is a metadata operation.
 */
import { createHash } from "node:crypto";
import { CHAPTER_LIBRARY, TEMPLATES } from "./library";
import { classifyQuestion } from "./classify";
import { extractEntities, type PlayerDirectory } from "./entities";
import { evaluateChapter, type CapabilitySnapshot } from "./capability";
import { gateFrontier } from "./frontier";
import { ANALYSIS_BOOK_CONTRACT, PLANNER_RULES_VERSION, TAXONOMY_VERSION, type AnalysisBookSession, type BookFrontier, type BookSubject, type BookType, type ChapterDef, type ChapterState, type ContentsChapter } from "./schema";

export interface BookRequest {
  question: string;
  /** optional caller context (never guessed): the league/manager the user is asking as, a target week */
  league?: string; manager?: string; week?: number; season?: number;
  /** Phase 10 — a lifecycle book type (PREGAME/POSTGAME/WEEK_REVIEW/NEXT_WEEK_OUTLOOK) the caller wants, when the
   * question's phrasing alone should route there (classification still decides for ordinary questions). */
  requested_type?: BookType;
  /** Phase 10 — the REAL, already-fetched temporal frontier for a lifecycle book type. Required for PREGAME/POSTGAME/
   * WEEK_REVIEW/NEXT_WEEK_OUTLOOK; never computed inside this pure function (no I/O here — see `frontier.ts`/callers). */
  frontier?: BookFrontier;
}
export type CreateBookResult =
  | { ok: true; session: AnalysisBookSession }
  | { ok: false; status: "NEEDS_CLARIFICATION"; note: string; ambiguous: string[] }
  | { ok: false; status: "FRONTIER_VIOLATION"; note: string; book_type: BookType };

export const canonicalJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
export const shortHash = (v: unknown, n = 12): string => createHash("sha256").update(typeof v === "string" ? v : canonicalJson(v)).digest("hex").slice(0, n);

const GAME_SCOPED: ReadonlySet<BookType> = new Set(["GAME_ANALYSIS", "PREGAME", "POSTGAME"]);
const TEAM_SCOPED: ReadonlySet<BookType> = new Set(["DEFENSE_ANALYSIS", "TEAM_ANALYSIS"]);
const LEAGUE_SCOPED: ReadonlySet<BookType> = new Set(["WEEK_REVIEW", "NEXT_WEEK_OUTLOOK"]);

function buildSubject(type: BookType, req: BookRequest, e: ReturnType<typeof extractEntities>, dir: PlayerDirectory): BookSubject {
  const kind: BookSubject["kind"] = GAME_SCOPED.has(type) ? "GAME" : TEAM_SCOPED.has(type) ? "TEAM" : LEAGUE_SCOPED.has(type) ? "EVENT" : type === "WAIVER_ANALYSIS" ? "WAIVER" : type === "TRADE_ANALYSIS" ? "TRADE" : type === "MANAGER_REVIEW" ? "MANAGER" : type === "WHY_ANALYSIS" || type === "PLAYER_VS_DEFENSE_GAME_ANALYSIS" ? "EVENT" : e.players.length > 1 ? "PLAYERS" : "PLAYER";
  const players = e.players;
  const teams = e.teams;
  const teamOfPlayer = players[0]?.team ?? null;
  // a defense named alongside a player is the OPPONENT; two bare teams are the game's two sides
  const team = kind === "GAME" || kind === "TEAM" ? (teams[0] ?? null) : teamOfPlayer;
  const opponent = kind === "GAME" ? (teams[1] ?? null) : kind === "TEAM" ? null : teams.find((t) => t !== teamOfPlayer) ?? players[0]?.opponent ?? null;
  const team_qb: Record<string, string> = {};
  for (const t of new Set([team, opponent, ...players.map((p) => p.team)].filter((x): x is string => !!x))) if (dir.team_qb[t]) team_qb[t] = dir.team_qb[t]!;
  return { kind, players, team, opponent_team: opponent, league: req.league ?? null, manager: req.manager ?? null, unresolved: [...e.unresolved, ...e.ambiguous.map((a) => `ambiguous:${a}`)], season: req.season ?? dir.season, week: req.week ?? dir.current_week, team_qb_gsis: team_qb };
}

function relevant(def: ChapterDef, s: BookSubject): boolean {
  if (!def.applies_to) return true;
  const known = s.players.filter((p) => p.position); if (!known.length) return true;
  return known.some((p) => def.applies_to!.includes(p.position!));
}

/** In a player-vs-defense book the defense chapters describe the OPPONENT of the player's team, not the player's own team. */
function adaptForBook(type: BookType, def: ChapterDef): ChapterDef {
  if (type !== "PLAYER_VS_DEFENSE_GAME_ANALYSIS" || !def.id.startsWith("defense.")) return def;
  return { ...def, needs: def.needs.map((n) => (n.bind === "own_team" ? { ...n, bind: "opponent" as const } : n)) };
}

export function composeParts(primary: BookType, secondary: BookType[]) {
  const seen = new Set<string>(); const parts: Array<{ id: string; title: string; chapters: string[] }> = [];
  const add = (type: BookType, prefix: string | null) => {
    for (const p of TEMPLATES[type].parts) {
      const chapters = p.chapters.filter((c) => c !== "book.final_synthesis" && !seen.has(c)); chapters.forEach((c) => seen.add(c));
      if (chapters.length) parts.push({ id: prefix ? `${prefix}.${p.id}` : p.id, title: prefix ? `SUPPLEMENT (${TEMPLATES[type].title}) — ${p.title}` : p.title, chapters });
    }
  };
  add(primary, null); for (const t of secondary) add(t, t.slice(0, 3));
  const last = parts[parts.length - 1]; if (last) last.chapters.push("book.final_synthesis"); else parts.push({ id: "END", title: "SYNTHESIS", chapters: ["book.final_synthesis"] });
  return parts;
}

export function createBook(req: BookRequest, dir: PlayerDirectory, snap: CapabilitySnapshot, now: string): CreateBookResult {
  const e = extractEntities(req.question, dir);
  const cls = classifyQuestion(req.question, e);
  // Phase 10: an explicit `requested_type` (structured lifecycle creation, e.g. by a cron or a lineage follow-through)
  // wins over free-text classification but never bypasses it silently — it is still checked against real entities below.
  const primary: BookType | null = req.requested_type ?? cls.primary;
  if (!req.requested_type && (cls.status !== "CLASSIFIED" || !cls.primary)) return { ok: false, status: "NEEDS_CLARIFICATION", note: cls.note ?? "unclassified", ambiguous: e.ambiguous };
  if (!primary) return { ok: false, status: "NEEDS_CLARIFICATION", note: "no book type could be determined", ambiguous: e.ambiguous };
  const secondary = req.requested_type ? [] : cls.secondary;
  const gate = gateFrontier(primary, req.frontier);
  if (!gate.allowed) return { ok: false, status: "FRONTIER_VIOLATION", note: gate.reason, book_type: primary };
  const subject = { ...buildSubject(primary, req, e, dir), frontier: req.frontier ?? null };
  const parts = composeParts(primary, secondary);
  const contents: ContentsChapter[] = []; let n = 0; const outParts: Array<{ id: string; title: string }> = [];
  for (const part of parts) {
    let any = false;
    for (const id of part.chapters) {
      const base = CHAPTER_LIBRARY[id]!; if (!relevant(base, subject)) continue;
      const def = adaptForBook(primary, base);
      n += 1; any = true;
      const subs = (def.subchapters ?? []).map((s, i) => ({ id: s.id, label: `${n}${String.fromCharCode(65 + i)}`, title: s.title, needs: s.needs ?? def.needs }));
      contents.push({ chapter_id: id, display_number: n, part_id: part.id, title: def.title, question: def.question, tags: def.tags, needs: def.needs, depends_on: def.depends_on ?? [], viz: def.viz ?? [], subchapters: subs, kind: def.kind ?? "EVIDENCE", researchability: evaluateChapter(def.needs, subject, snap, def.kind === "SYNTHESIS") });
    }
    if (any) outParts.push({ id: part.id, title: part.title });
  }
  const book_id = `book:${shortHash({ q: req.question.trim().toLowerCase().replace(/\s+/g, " "), subject: { p: subject.players.map((p) => p.gsis_id ?? p.name), t: subject.team, o: subject.opponent_team, l: subject.league, m: subject.manager, w: subject.week, s: subject.season }, types: [primary, ...secondary], frontier: req.frontier ? { g: req.frontier.game_state, w: req.frontier.week_closure } : null, taxonomy: TAXONOMY_VERSION, rules: PLANNER_RULES_VERSION })}`;
  const chapters: Record<string, ChapterState> = {};
  for (const c of contents) { chapters[c.chapter_id] = { status: "NOT_OPENED", depth: 0, revisions: [], used_as_support: [] }; for (const s of c.subchapters) chapters[`${c.chapter_id}/${s.id}`] = { status: "NOT_OPENED", depth: 0, revisions: [], used_as_support: [] }; }
  return { ok: true, session: {
    analysis_book_contract: ANALYSIS_BOOK_CONTRACT, taxonomy_version: TAXONOMY_VERSION, planner_rules_version: PLANNER_RULES_VERSION,
    book_id, question: req.question, book_types: [primary, ...secondary], subject, classification: { primary, secondary, matched_rules: req.requested_type ? ["requested_type"] : cls.matched_rules },
    contents_version: `contents:${shortHash({ parts: outParts, chapters: contents.map((c) => c.chapter_id), taxonomy: TAXONOMY_VERSION })}`,
    capability_basis: { registry_version: snap.registry_version, season: snap.season, vintage: Object.values(snap.vintage).map(({ lag_weeks: _l, ...i }) => i) },
    parts: outParts, contents, chapters, current_chapter: null, selected_part: null, findings: [], synthesis_state: { status: "NOT_STARTED", last_run_at: null, coverage_hash: null }, created_at: now,
  } };
}
