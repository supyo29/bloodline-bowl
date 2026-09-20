/**
 * Phase 3.5D — question -> book type. Explicit, ORDERED, typed rules over extracted features and resolved entities
 * (never a single keyword match). The matched rule ids are returned so classification is inspectable and testable.
 * Ambiguous or empty questions return NEEDS_CLARIFICATION rather than a guess.
 */
import type { BookType } from "./schema";
import type { Entities } from "./entities";

export interface Features { why: boolean; trade: boolean; waiver: boolean; startsit: boolean; compare: boolean; myTeam: boolean; defenseWord: boolean; gameWord: boolean }
export interface Classification { status: "CLASSIFIED" | "NEEDS_CLARIFICATION"; primary: BookType | null; secondary: BookType[]; matched_rules: string[]; note?: string }

export function features(q: string): Features {
  const s = q.toLowerCase();
  return {
    why: /^\s*(why|how did|how come|what happened|what went)|\bwhy did\b|\bwhat happened\b/.test(s),
    trade: /\btrade\b|\bswap\b|\bacquire\b|\bsell high\b|\bbuy low\b|\btrading\b/.test(s),
    waiver: /\bwaiver|\bpick ?up\b|\bfree agent|\bfaab\b|\bstream(ing)?\b|\bwire\b/.test(s),
    startsit: /\bstart\b|\bsit\b|\bbench\b|\bflex\b|\blineup\b/.test(s),
    compare: /\bvs\.?\b|\bversus\b|\bcompare\b|\bbetter than\b|\bor\b/.test(s),
    myTeam: /\bmy (team|roster|lineup|season)\b|\bmanager\b/.test(s),
    defenseWord: /\bdefen[cs]e\b|\bsecondary\b|\bfront seven\b|\bpass rush\b|\bstop(ped)?\b|\bcoverage\b|\bshut\b/.test(s),
    gameWord: /\bgame\b|\bpreview\b|\bbreakdown\b|\bgame plan\b|\bmatchup\b/.test(s),
  };
}

interface Rule { id: string; when: (f: Features, e: Entities) => boolean; type: BookType; secondary?: BookType[] }
const RULES: Rule[] = [
  { id: "manager-review:manager-entity", when: (_f, e) => !!e.manager_hint && e.players.length === 0, type: "MANAGER_REVIEW" },
  { id: "player-vs-defense:why+player+defense", when: (f, e) => f.why && e.players.length >= 1 && (e.teams.length >= 1 || f.defenseWord), type: "PLAYER_VS_DEFENSE_GAME_ANALYSIS" },
  { id: "why:event-question", when: (f, e) => f.why && (e.players.length >= 1 || e.teams.length >= 1), type: "WHY_ANALYSIS" },
  { id: "trade:trade-verb", when: (f) => f.trade, type: "TRADE_ANALYSIS" },
  { id: "waiver:waiver-terms", when: (f) => f.waiver, type: "WAIVER_ANALYSIS" },
  { id: "startsit-comparison:multiple-players", when: (f, e) => e.players.length >= 2 && (f.compare || f.startsit), type: "START_SIT_COMPARISON" },
  { id: "startsit-single:one-player-start", when: (f, e) => e.players.length === 1 && f.startsit, type: "START_SIT_COMPARISON", secondary: ["PLAYER_ANALYSIS"] },
  { id: "defense:team+defense-word", when: (f, e) => e.players.length === 0 && e.teams.length === 1 && f.defenseWord, type: "DEFENSE_ANALYSIS" },
  { id: "game:two-teams", when: (_f, e) => e.players.length === 0 && e.teams.length >= 2, type: "GAME_ANALYSIS" },
  { id: "game:game-word-team", when: (f, e) => e.players.length === 0 && e.teams.length === 1 && f.gameWord, type: "GAME_ANALYSIS" },
  { id: "manager-review:my-team", when: (f, e) => f.myTeam && e.players.length === 0, type: "MANAGER_REVIEW" },
  { id: "player:single-player", when: (_f, e) => e.players.length === 1, type: "PLAYER_ANALYSIS" },
  { id: "comparison:default-multiple-players", when: (_f, e) => e.players.length >= 2, type: "START_SIT_COMPARISON" },
];

export function classifyQuestion(question: string, e: Entities): Classification {
  const f = features(question);
  for (const r of RULES) if (r.when(f, e)) {
    // "What happened to Mark's team?" is a manager review that also asks WHY — keep it as a supplement, not a second book
    const secondary = [...(r.secondary ?? [])]; if (r.type === "MANAGER_REVIEW" && f.why) secondary.push("WHY_ANALYSIS");
    return { status: "CLASSIFIED", primary: r.type, secondary, matched_rules: [r.id] };
  }
  return { status: "NEEDS_CLARIFICATION", primary: null, secondary: [], matched_rules: [], note: e.ambiguous.length ? `ambiguous names: ${e.ambiguous.join(", ")} — use a full name` : "could not tell what to analyze: name a player, team, game, manager, waiver target or trade" };
}
