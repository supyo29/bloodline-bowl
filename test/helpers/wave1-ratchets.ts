/**
 * W1.R1 ratchet scanners. PURE functions over (path, source) so each detection claim is executable against planted variants, and the same
 * functions scan the real tree. These are HEURISTICS (regex + brace/paren matching), not a type-aware analyzer: they catch the common equivalent
 * forms listed in WAVE1_RATCHET_LIMITS and say plainly what they cannot catch.
 */

export const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function matchClose(s: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return s.length - 1;
}

/* ------------------------------------------------------------------------------------------------ lineup decision engine */

/** local names under which a file can call the optimizer: the export itself and any `as` alias */
export function lineupCallNames(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']*lineup)["']/g)) {
    for (const part of m[1]!.split(",")) {
      const mm = /^\s*(?:type\s+)?buildOptimalLineup(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (mm) names.add(mm[1] ?? "buildOptimalLineup");
    }
  }
  return [...names];
}
export const importsLineupModule = (src: string): boolean => lineupCallNames(stripComments(src)).length > 0;

/** number of optimizer calls whose argument text never mentions `forecasts` (i.e. built on the SOURCE basis) */
export function lineupCallsWithoutForecasts(src: string): number {
  const s = stripComments(src);
  let n = 0;
  for (const name of lineupCallNames(s)) {
    for (const m of s.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
      const open = m.index! + m[0].length - 1;
      const args = s.slice(open, matchClose(s, open, "(", ")") + 1);
      if (!/\bforecasts\b/.test(args)) n++;
    }
  }
  return n;
}

/* ------------------------------------------------------------------------------------------------------------------- bye */

/** `projection_status` compared with a quoted "bye" in ANY quote style / operator / `.includes` / `case`, with the literal on either side */
export function byeStatusPredicate(src: string): boolean {
  const s = stripComments(src);
  return (
    /projection_status[^;\n]{0,60}(?:===?|!==?)\s*["'`]bye["'`]/.test(s) ||
    /["'`]bye["'`]\s*(?:===?|!==?)[^;\n]{0,60}projection_status/.test(s) ||
    /\[[^\]]*["'`]bye["'`][^\]]*\]\.includes\([^)]*projection_status/.test(s) ||
    /projection_status[^;\n]{0,40}\.(?:startsWith|endsWith|includes)\(\s*["'`]bye["'`]/.test(s) ||
    /switch\s*\([^)]*projection_status[^)]*\)\s*\{[^}]*case\s+["'`]bye["'`]\s*:/.test(s)
  );
}
/** the literal hoisted into a variable/constant (defeats a literal-comparison ratchet) */
export const byeLiteralHoisted = (src: string): boolean => /\b(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*["'`]bye["'`]/.test(stripComments(src));
/** a `bye` status literal written into an object/assignment (a hand-built bye row) */
export const byeStatusWritten = (src: string): boolean => /\bprojection_status\s*[:=]\s*["'`]bye["'`]/.test(stripComments(src));
/** `is_bye` set to anything other than the literal false (a flag producer; carrying a stale flag is the audited failure) */
export const isByeWritten = (src: string): boolean => /\bis_bye\s*[:=](?!=)(?!\s*false\b)(?!\s*boolean\b)\s*[^,}\n;\s]/.test(stripComments(src));
/** a bye-zero ternary under ANY variable name that contains "bye" */
export const byeZeroTernary = (src: string): boolean => /\b\w*[bB]ye\w*\s*\?\s*0\s*:/.test(stripComments(src));
/** object literal that spreads an existing row AND rewrites its value/status without deciding `is_bye` (stale-flag carrier) */
export function spreadRewriteWithoutByeDecision(src: string): number {
  const s = stripComments(src);
  let n = 0;
  for (const m of s.matchAll(/\{\s*\.\.\.(\w+(?:\.\w+)*)\s*,/g)) {
    const end = matchClose(s, m.index!, "{", "}");
    const block = s.slice(m.index!, end + 1);
    if (/\b(?:projected_points|projection_status)\s*:/.test(block) && !/\bis_bye\b|deriveForwardRow|verifiedByeRow/.test(block)) n++;
  }
  return n;
}

/* ------------------------------------------------------------------------------------------------------------- freshness */

const FRESHNESS_REF = /source_observed_at|\bage_ms\b|canonical_snapshot|\bfetched_at\b/;
const MINUTE_ARITHMETIC = /\b\d+\s*\*\s*60\s*\*\s*1000\b|\b\d+\s*\*\s*60_000\b|\b3_?600_?000\b|\b1_?800_?000\b|\b5_?400_?000\b|\b\d+\s*\*\s*(?:MIN|HOUR)\b|\b\d+\s*\*\s*3_?600_?000\b/;
/** a file that handles freshness inputs AND does its own minute/hour arithmetic (a candidate private TTL), any variable name */
export const privateFreshnessArithmetic = (src: string): boolean => {
  const s = stripComments(src);
  return FRESHNESS_REF.test(s) && MINUTE_ARITHMETIC.test(s);
};

export const WAVE1_RATCHET_LIMITS = [
  "Regex/paren matching over source text, not a type-aware analyzer: a call through a computed property, dynamic import, re-export chain or generated code is not seen.",
  "Lineup guard: only calls to the optimizer (and its `as` aliases) and importers of the lineup module are seen; a NEW engine that builds its own ranking without the optimizer is not.",
  "Bye guards: a bye encoded through a different representation (a numeric code, a status enum added later, a team-bye lookup) is not a `projection_status`/`is_bye` read and is not seen.",
  "Spread guard: an object spread through a helper function, or a row mutated in place (`row.is_bye = ...` after construction is only caught for non-false RHS), is not seen.",
  "Freshness guard: a TTL expressed with no literal arithmetic (a value read from config/env) or in a file that never mentions a freshness field is not seen.",
] as const;
