/**
 * Phase 7 — evidence adapters. Each turns one real source into `TeamObservation`s and states its own granularity and vintage; none decides precedence
 * (that is `SOURCE_PRIORITY` in membership.ts). Pure except the file reader.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { observation, type TeamObservation } from "./membership";
import { parseCsv } from "@/lib/book-ready/common";

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
