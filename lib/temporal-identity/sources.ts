/**
 * Phase 7 — evidence adapters. Each turns one real source into `TeamObservation`s and states its own granularity and vintage; none decides precedence
 * (that is `SOURCE_PRIORITY` in membership.ts). Pure except the file reader.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { observation, type TeamObservation } from "./membership";

/** Minimal RFC-4180-ish CSV parser (quoted fields, doubled quotes) — a private copy, like every other reader in the repo (Book-Ready may not be imported from outside). */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []; let cur: string[] = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i]!;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { cur.push(f); f = ""; } else if (c === "\n") { cur.push(f); rows.push(cur); cur = []; f = ""; } else if (c !== "\r") f += c; }
  if (f || cur.length) { cur.push(f); rows.push(cur); }
  const head = rows[0] ?? []; return rows.slice(1).filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

export interface GameLogRow { gsis_id: string; season: number; week: number; team: string | null; opponent_team: string | null }
/** Supabase `player_lab_game_logs` (2019–2025, weeks 1–22, one row per player-game; real audit: 129,657 rows, 32 teams, 0 null team/opponent, 484 multi-team player-seasons). */
export const fromGameLogRows = (rows: readonly GameLogRow[], vintage = "player_lab_game_logs"): TeamObservation[] =>
  rows.map((r) => observation({ gsis_id: r.gsis_id, season: r.season, week: r.week, raw_team: r.team, opponent: r.opponent_team, source: "GAME_LOG", granularity: "GAME_OBSERVED", source_record_id: `lab:${r.gsis_id}:${r.season}:${r.week}:${r.team ?? ""}`, source_vintage: vintage }));

/** Role & Opportunity participation (`player_game_role.csv`): a row exists per player-game with offensive snaps or a return role. Current season only (2026 week 1 today). */
export function fromRoleParticipationCsv(text: string, vintage = "player_game_role.csv"): TeamObservation[] {
  const out: TeamObservation[] = [];
  for (const r of parseCsv(text)) {
    if (!r.gsis_id || !r.team || !r.season || !r.week) continue;
    const played = Number(r.offensive_snaps) > 0 || r.return_domain_active === "TRUE"; if (!played) continue;
    out.push(observation({ gsis_id: r.gsis_id, season: Number(r.season), week: Number(r.week), raw_team: r.team, opponent: r.opponent || null, source: "ROLE_PARTICIPATION", granularity: "GAME_OBSERVED", source_record_id: `role:${r.game_id}:${r.gsis_id}`, source_vintage: vintage }));
  }
  return out;
}
export function loadRoleParticipation(root = process.cwd()): TeamObservation[] {
  const p = join(root, "lib", "player-role-intelligence", "data", "player_game_role.csv"); return existsSync(p) ? fromRoleParticipationCsv(readFileSync(p, "utf8")) : [];
}

/** A provider's statement about NOW (e.g. Sleeper's player index). CURRENT_ONLY: never returned for a past time. */
export const providerCurrent = (gsis_id: string, season: number, raw_team: string | null, vintage: string): TeamObservation =>
  observation({ gsis_id, season, week: null, raw_team, source: "PROVIDER_CURRENT", granularity: "CURRENT_ONLY", source_record_id: `provider:${gsis_id}:${vintage}`, source_vintage: vintage });
/** The identity table's single `latest_team` snapshot (stale-risk; a different code vocabulary). Lowest priority; current-only. */
export const crosswalkSnapshot = (gsis_id: string, season: number, raw_team: string | null, vintage: string): TeamObservation =>
  observation({ gsis_id, season, week: null, raw_team, source: "CROSSWALK_LATEST_TEAM", granularity: "CURRENT_ONLY", source_record_id: `crosswalk:${gsis_id}:${vintage}`, source_vintage: vintage });

/** Player-Scheme's `current_team` window is "career rows on the player's AS-OF team": the team of his last PBP game at the data cutoff (2025 week 18), NOT his current club.
 *  This flag makes that vintage difference explicit without changing the Player-Scheme build. */
export type SchemeVintageFlag = "SAME_TEAM_AS_SCHEME_VINTAGE" | "TEAM_CHANGED_SINCE_SCHEME_VINTAGE" | "SCHEME_TEAM_UNKNOWN_AT_VINTAGE" | "CURRENT_TEAM_UNKNOWN";
export function schemeVintageFlag(schemeAsOfTeamRaw: string | null | undefined, resolvedNow: string | null | undefined): SchemeVintageFlag {
  const a = normalize(schemeAsOfTeamRaw), b = normalize(resolvedNow); if (!b) return "CURRENT_TEAM_UNKNOWN"; if (!a) return "SCHEME_TEAM_UNKNOWN_AT_VINTAGE"; return a === b ? "SAME_TEAM_AS_SCHEME_VINTAGE" : "TEAM_CHANGED_SINCE_SCHEME_VINTAGE";
}
import { normalizeTeamCode as normalize } from "@/lib/canonical/team-codes";
