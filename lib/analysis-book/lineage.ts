/**
 * Phase 10 §12 — Book lineage. Pure. Returns REFERENCES to related Books (identity facts a caller can pass back into
 * `createBook`/`BookRequest`), never their chapters or prose. This is how a Weekly Review reaches all 32 teams and
 * every Pregame/Postgame Book without inlining them (Step 24: no N x chapter fan-out on a contents read), and how
 * the lifecycle Pregame -> Postgame -> Weekly Review -> Next-Week Outlook -> Pregame forms a real graph.
 */
import type { BookSubject, BookType } from "./schema";

export type BookRelation =
  | "PREGAME_OF_THIS_GAME" | "POSTGAME_OF_THIS_GAME"
  | "PRIOR_WEEK_REVIEW" | "NEXT_WEEK_OUTLOOK_FOR" | "WEEK_REVIEW_FOR"
  | "TEAM_BOOK" | "OPPONENT_TEAM_BOOK" | "PLAYER_BOOK" | "MANAGER_BOOK";

export interface RelatedBookRef {
  relation: BookRelation;
  book_type: BookType;
  season: number;
  week: number | null;
  /** enough to reconstruct a BookRequest deterministically — never the Book's contents/findings */
  scope: { team?: string | null; opponent_team?: string | null; gsis_id?: string | null; name?: string | null; league?: string | null; manager?: string | null };
  /** whether the referenced Book could actually be CREATED right now (frontier-gated); the reference itself always exists */
  currently_creatable: boolean | "UNKNOWN";
}

/** Pure. `gameStateKnown` tells whether the referenced game's frontier is known FINAL/PRE_GAME (drives `currently_creatable`); omit when not checked (reported UNKNOWN, never guessed). */
export function relatedBooks(current: { book_type: BookType; subject: BookSubject }, opts: { targetGameFrontier?: "PRE_GAME" | "IN_PROGRESS" | "FINAL" | "UNKNOWN" } = {}): RelatedBookRef[] {
  const { book_type, subject } = current;
  const out: RelatedBookRef[] = [];
  const season = subject.season; const week = subject.week ?? null;

  if (book_type === "PREGAME" && subject.kind === "GAME") {
    out.push({ relation: "POSTGAME_OF_THIS_GAME", book_type: "POSTGAME", season, week, scope: { team: subject.team, opponent_team: subject.opponent_team }, currently_creatable: opts.targetGameFrontier ? opts.targetGameFrontier === "FINAL" : "UNKNOWN" });
    if (subject.team) out.push({ relation: "TEAM_BOOK", book_type: "TEAM_ANALYSIS", season, week, scope: { team: subject.team }, currently_creatable: true });
    if (subject.opponent_team) out.push({ relation: "OPPONENT_TEAM_BOOK", book_type: "TEAM_ANALYSIS", season, week, scope: { team: subject.opponent_team }, currently_creatable: true });
  }
  if (book_type === "POSTGAME" && subject.kind === "GAME") {
    out.push({ relation: "PREGAME_OF_THIS_GAME", book_type: "PREGAME", season, week, scope: { team: subject.team, opponent_team: subject.opponent_team }, currently_creatable: false });
    if (week != null) out.push({ relation: "WEEK_REVIEW_FOR", book_type: "WEEK_REVIEW", season, week, scope: {}, currently_creatable: "UNKNOWN" });
  }
  if (book_type === "WEEK_REVIEW") {
    if (week != null) {
      out.push({ relation: "NEXT_WEEK_OUTLOOK_FOR", book_type: "NEXT_WEEK_OUTLOOK", season, week: week + 1, scope: {}, currently_creatable: true });
      out.push({ relation: "PRIOR_WEEK_REVIEW", book_type: "WEEK_REVIEW", season, week: week - 1, scope: {}, currently_creatable: "UNKNOWN" });
    }
    for (const team of NFL_TEAMS) out.push({ relation: "TEAM_BOOK", book_type: "TEAM_ANALYSIS", season, week, scope: { team }, currently_creatable: true });
  }
  if (book_type === "NEXT_WEEK_OUTLOOK" && week != null) {
    out.push({ relation: "PRIOR_WEEK_REVIEW", book_type: "WEEK_REVIEW", season, week: week - 1, scope: {}, currently_creatable: "UNKNOWN" });
  }
  if ((book_type === "PLAYER_ANALYSIS" || book_type === "START_SIT_COMPARISON") && subject.players.length) {
    for (const p of subject.players) {
      out.push({ relation: "PLAYER_BOOK", book_type: "PLAYER_ANALYSIS", season, week, scope: { gsis_id: p.gsis_id ?? null, name: p.name }, currently_creatable: true });
      if (p.team) out.push({ relation: "TEAM_BOOK", book_type: "TEAM_ANALYSIS", season, week, scope: { team: p.team }, currently_creatable: true });
    }
  }
  if (subject.manager && subject.league) out.push({ relation: "MANAGER_BOOK", book_type: "MANAGER_REVIEW", season, week, scope: { league: subject.league, manager: subject.manager }, currently_creatable: true });

  // de-duplicate identical references (e.g. two players on the same team both pointing at that TEAM_BOOK)
  const seen = new Set<string>();
  return out.filter((r) => { const k = `${r.relation}|${r.book_type}|${r.season}|${r.week}|${r.scope.team ?? ""}|${r.scope.gsis_id ?? r.scope.name ?? ""}|${r.scope.manager ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const NFL_TEAMS = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS"] as const;
