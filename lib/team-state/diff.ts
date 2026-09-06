/**
 * Phase 2 — factual change detection between two canonical snapshots.
 *
 * "What changed?" — never "was it good or bad?". Deterministic and pure.
 * Works from two `CanonicalLeagueSnapshot`s directly (no Team-State build
 * required) so it can run in a lightweight refresh pipeline.
 */

import type { CanonicalLeagueSnapshot } from "@/lib/canonical/schema";
import { snapshotLineage } from "@/lib/canonical/snapshot-lineage";
import { scoringFingerprint } from "@/lib/canonical/scoring-fingerprint";
import type { TeamStateChange, TeamStateDiff } from "./schema";

type Loc = "starter" | "bench" | "ir" | "taxi" | null;

function locOf(snap: CanonicalLeagueSnapshot, teamId: string, playerId: string): Loc {
  const r = snap.rosters.find((x) => x.canonical_team_id === teamId);
  if (!r) return null;
  if (r.starters.includes(playerId)) return "starter";
  if (r.ir.includes(playerId)) return "ir";
  if (r.taxi.includes(playerId)) return "taxi";
  if (r.bench.includes(playerId) || r.all_players.includes(playerId)) return "bench";
  return null;
}

export function diffCanonicalSnapshots(
  from: CanonicalLeagueSnapshot,
  to: CanonicalLeagueSnapshot,
): TeamStateDiff {
  const fromId = snapshotLineage(from).league_snapshot_id;
  const toId = snapshotLineage(to).league_snapshot_id;
  const changes: TeamStateChange[] = [];
  const base = { from_snapshot_id: fromId, to_snapshot_id: toId };

  const nameOf = (snap: CanonicalLeagueSnapshot, pid: string) =>
    snap.players.find((p) => p.canonical_player_id === pid)?.full_name ?? null;
  const rosterId = (snap: CanonicalLeagueSnapshot, teamId: string) =>
    Number(snap.teams.find((t) => t.canonical_team_id === teamId)?.provider_team_id ?? NaN);

  /* ---- league-level ---- */
  const week_changed = from.week !== to.week;
  if (week_changed) {
    changes.push({ type: "WEEK_ADVANCED", roster_id: null, canonical_team_id: null, player_id: null, player_name: null, before: from.week, after: to.week, ...base });
  }
  if (from.league.status !== to.league.status) {
    changes.push({ type: "LEAGUE_STATUS_CHANGED", roster_id: null, canonical_team_id: null, player_id: null, player_name: null, before: from.league.status, after: to.league.status, ...base });
  }
  const scoring_changed = scoringFingerprint(from.league.raw_scoring) !== scoringFingerprint(to.league.raw_scoring);
  if (scoring_changed) {
    changes.push({ type: "SCORING_CHANGED", roster_id: null, canonical_team_id: null, player_id: null, player_name: null, before: scoringFingerprint(from.league.raw_scoring), after: scoringFingerprint(to.league.raw_scoring), ...base });
  }
  const roster_config_changed =
    (from.league.roster_fingerprint ?? "") !== (to.league.roster_fingerprint ?? "");
  if (roster_config_changed) {
    changes.push({ type: "ROSTER_CONFIG_CHANGED", roster_id: null, canonical_team_id: null, player_id: null, player_name: null, before: from.league.roster_fingerprint ?? null, after: to.league.roster_fingerprint ?? null, ...base });
  }

  /* ---- team identity ---- */
  const toTeamById = new Map(to.teams.map((t) => [t.canonical_team_id, t]));
  for (const ft of from.teams) {
    const tt = toTeamById.get(ft.canonical_team_id);
    if (!tt) continue;
    const rid = Number(ft.provider_team_id);
    if ((ft.team_name ?? null) !== (tt.team_name ?? null)) {
      changes.push({ type: "TEAM_NAME_CHANGED", roster_id: rid, canonical_team_id: ft.canonical_team_id, player_id: null, player_name: null, before: ft.team_name, after: tt.team_name, ...base });
    }
  }
  const fromMgr = new Map(from.managers.map((m) => [m.canonical_manager_id, m]));
  for (const tm of to.managers) {
    const fm = fromMgr.get(tm.canonical_manager_id);
    if (fm && (fm.display_name ?? null) !== (tm.display_name ?? null)) {
      changes.push({ type: "MANAGER_NAME_CHANGED", roster_id: null, canonical_team_id: null, player_id: null, player_name: null, before: fm.display_name, after: tm.display_name, ...base });
    }
  }

  /* ---- ownership + roster-slot moves ---- */
  const ownerFrom = new Map<string, string>();
  for (const r of from.rosters) for (const id of r.all_players) ownerFrom.set(id, r.canonical_team_id);
  const ownerTo = new Map<string, string>();
  for (const r of to.rosters) for (const id of r.all_players) ownerTo.set(id, r.canonical_team_id);

  const allIds = new Set([...ownerFrom.keys(), ...ownerTo.keys()]);
  for (const pid of allIds) {
    const a = ownerFrom.get(pid);
    const b = ownerTo.get(pid);
    if (a && !b) {
      changes.push({ type: "PLAYER_DROPPED", roster_id: rosterId(from, a), canonical_team_id: a, player_id: pid, player_name: nameOf(from, pid), before: "rostered", after: null, ...base });
    } else if (!a && b) {
      changes.push({ type: "PLAYER_ADDED", roster_id: rosterId(to, b), canonical_team_id: b, player_id: pid, player_name: nameOf(to, pid), before: null, after: "rostered", ...base });
    } else if (a && b && a !== b) {
      changes.push({ type: "PLAYER_OWNERSHIP_CHANGED", roster_id: rosterId(to, b), canonical_team_id: b, player_id: pid, player_name: nameOf(to, pid), before: rosterId(from, a), after: rosterId(to, b), ...base });
    } else if (a && b && a === b) {
      const la = locOf(from, a, pid);
      const lb = locOf(to, b, pid);
      if (la !== lb) {
        const type: TeamStateChange["type"] =
          lb === "starter" ? "PLAYER_MOVED_TO_STARTER"
            : lb === "ir" ? "PLAYER_MOVED_TO_IR"
              : la === "ir" ? "PLAYER_RETURNED_FROM_IR"
                : "PLAYER_MOVED_TO_BENCH";
        changes.push({ type, roster_id: rosterId(to, b), canonical_team_id: b, player_id: pid, player_name: nameOf(to, pid), before: la, after: lb, ...base });
      }
    }
  }

  /* ---- player metadata (injury / NFL team) ---- */
  const fromP = new Map(from.players.map((p) => [p.canonical_player_id, p]));
  for (const tp of to.players) {
    const fp = fromP.get(tp.canonical_player_id);
    if (!fp) continue;
    if ((fp.injury_status ?? null) !== (tp.injury_status ?? null)) {
      changes.push({ type: "PLAYER_INJURY_STATUS_CHANGED", roster_id: null, canonical_team_id: ownerTo.get(tp.canonical_player_id) ?? null, player_id: tp.canonical_player_id, player_name: tp.full_name, before: fp.injury_status, after: tp.injury_status, ...base });
    }
    if ((fp.nfl_team ?? null) !== (tp.nfl_team ?? null)) {
      changes.push({ type: "PLAYER_NFL_TEAM_CHANGED", roster_id: null, canonical_team_id: ownerTo.get(tp.canonical_player_id) ?? null, player_id: tp.canonical_player_id, player_name: tp.full_name, before: fp.nfl_team, after: tp.nfl_team, ...base });
    }
  }

  /* ---- matchup ---- */
  const oppFrom = matchupOpponents(from);
  const oppTo = matchupOpponents(to);
  for (const [teamId, oppA] of oppFrom) {
    const oppB = oppTo.get(teamId);
    if (oppB !== undefined && oppA !== oppB) {
      changes.push({ type: "MATCHUP_CHANGED", roster_id: rosterId(to, teamId), canonical_team_id: teamId, player_id: null, player_name: null, before: oppA, after: oppB, ...base });
    }
  }

  return { from_snapshot_id: fromId, to_snapshot_id: toId, week_changed, scoring_changed, roster_config_changed, changes };
}

function matchupOpponents(snap: CanonicalLeagueSnapshot): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const ridByTeam = new Map(snap.teams.map((t) => [t.canonical_team_id, Number(t.provider_team_id)]));
  for (const m of snap.matchups) {
    for (const s of m.sides) {
      const opp = m.sides.find((o) => o.canonical_team_id !== s.canonical_team_id);
      out.set(s.canonical_team_id, opp ? (ridByTeam.get(opp.canonical_team_id) ?? null) : null);
    }
  }
  return out;
}
