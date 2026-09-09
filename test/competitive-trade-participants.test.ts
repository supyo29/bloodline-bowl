/**
 * Competitive Trade Intelligence — pre-merge certification fix, Part A:
 * league participant-set integrity for opponent-threat calculations.
 *
 * The authoritative participant set is the roster identities (canonical_team_id)
 * present in the CURRENT snapshot — NOT the manager list. Bloodline Bowl is a
 * 12-team league with 14 managers (two co-managed teams); the manager list would
 * double-count those two rosters and contaminate every z-score standardization.
 *
 * Deterministic. Covers spec Part A §3–§12.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import type { CanonicalPosition, CanonicalRoster } from "../lib/canonical/schema";
import { buildLeagueThreat, resolveThreatParticipants } from "../lib/trades/competitive/threat";
import { resolveCompetitiveDConfig } from "../lib/trades/competitive/config";
import { evaluateCompetitiveTradeRequest } from "../lib/trades/competitive/api";
import type { TradeAnalysisContext } from "../lib/trades/context";

const D = resolveCompetitiveDConfig();
const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) => [0, 1, 2].map((i) => proj(`fa_${p}_${i}`, p, 6 - i, { rest_of_season_points: (6 - i) * ROS_WEEKS })));
const MID = (slug: string) => `manager:test-league:${slug}`;
const TID = (slug: string) => `team:test-league:${slug}`;

function ctxOf(slugs: string[]): TradeAnalysisContext {
  // vary team strength by index so the z-distribution is non-degenerate
  const built = slugs.map((s, i) =>
    stdTeam({
      slug: s,
      flex: { id: `${s}_flex`, pos: "WR", pts: 8 + i * 2 },
      bench: [{ id: `${s}_b`, pos: "RB", pts: 3 + i }],
      lockPts: { RB1: 14 + i * 2, WR1: 13 + i * 2 },
    } as StdTeamSpec),
  );
  const fix = tradeFixture({
    teams: built.map((b) => b.team),
    players: built.flatMap((b) => b.players),
    projections: built.flatMap((b) => b.projections),
    freeAgents: FA,
    faProjections: FA_PROJ,
    transfers: [],
    rosFlatHorizon: ROS_WEEKS,
    teamCount: 12,
  });
  return fix.context({ rosWeeks: ROS_WEEKS });
}

describe("Competitive Trade — participant-set integrity (Part A)", () => {
  it("Test A — exact match ⇒ READY, no mismatch", () => {
    const ctx = ctxOf(["A", "B", "C", "D"]);
    const lt = buildLeagueThreat(ctx, D, MID("A"));
    assert.equal(lt.participant_set_mismatch, false);
    assert.equal(lt.participant_set.exact_match, true);
    assert.equal(lt.participant_set.canonical_participant_count, 4);
    assert.equal(lt.participant_set.threat_participant_count, 4);
    assert.deepEqual(lt.participant_set.missing_participant_ids, []);
    assert.deepEqual(lt.participant_set.unexpected_participant_ids, []);
    for (const t of lt.by_manager.values()) assert.notEqual(t.readiness, "NO_THREAT_CONTEXT");
  });

  it("Test B — a stale/extra roster owner in the threat source ⇒ LEAGUE_PARTICIPANT_SET_MISMATCH (unexpected)", () => {
    const ctx = ctxOf(["A", "B", "C", "D"]);
    // an extra manager pointing at a team NOT in snapshot.rosters
    const ghost: CanonicalRoster = { ...[...ctx.rosters_by_manager.values()][0]!, canonical_team_id: TID("E") };
    ctx.rosters_by_manager.set(MID("E"), ghost);
    const lt = buildLeagueThreat(ctx, D, MID("A"));
    assert.equal(lt.participant_set_mismatch, true);
    assert.deepEqual(lt.participant_set.unexpected_participant_ids, [TID("E")]);
    for (const t of lt.by_manager.values()) {
      assert.equal(t.readiness, "NO_THREAT_CONTEXT");
      assert.ok((t.reasons[0] ?? "").includes("LEAGUE_PARTICIPANT_SET_MISMATCH"));
    }
  });

  it("Test C — a missing roster owner ⇒ mismatch (missing)", () => {
    const ctx = ctxOf(["A", "B", "C", "D"]);
    ctx.rosters_by_manager.delete(MID("D"));
    const lt = buildLeagueThreat(ctx, D, MID("A"));
    assert.equal(lt.participant_set_mismatch, true);
    assert.deepEqual(lt.participant_set.missing_participant_ids, [TID("D")]);
  });

  it("Test D — same count, wrong identity ⇒ mismatch (proves identity equality, not count equality)", () => {
    const ctx = ctxOf(["A", "B", "C", "D"]);
    const dRoster = ctx.rosters_by_manager.get(MID("D"))!;
    ctx.rosters_by_manager.delete(MID("D"));
    ctx.rosters_by_manager.set(MID("E"), { ...dRoster, canonical_team_id: TID("E") });
    const lt = buildLeagueThreat(ctx, D, MID("A"));
    assert.equal(lt.participant_set.threat_participant_count, 4);
    assert.equal(lt.participant_set.canonical_participant_count, 4);
    assert.equal(lt.participant_set_mismatch, true);
    assert.deepEqual(lt.participant_set.missing_participant_ids, [TID("D")]);
    assert.deepEqual(lt.participant_set.unexpected_participant_ids, [TID("E")]);
  });

  it("Test E — a co-manager (duplicate alias) does NOT become a second threat participant", () => {
    const ctx = ctxOf(["A", "B", "C", "D"]);
    // a second manager id resolving to team A's existing roster
    ctx.rosters_by_manager.set(MID("A2"), ctx.rosters_by_manager.get(MID("A"))!);
    ctx.snapshot.teams.find((t) => t.canonical_team_id === TID("A"))!.canonical_manager_ids.push(MID("A2"));
    ctx.snapshot.managers.push({ ...ctx.snapshot.managers.find((m) => m.canonical_manager_id === MID("A"))!, canonical_manager_id: MID("A2"), manager_slug: "a2" });

    const lt = buildLeagueThreat(ctx, D, MID("A"));
    assert.equal(lt.participant_set_mismatch, false);
    assert.equal(lt.participant_set.threat_participant_count, 4, "still 4 teams, not 5");
    assert.equal(lt.by_manager.size, 5, "both co-manager ids resolve");
    const a = lt.by_manager.get(MID("A"))!;
    const a2 = lt.by_manager.get(MID("A2"))!;
    assert.equal(a.components.blended_strength_z, a2.components.blended_strength_z);
    assert.equal(a.band, a2.band);
    // distinct team-level z's
    const zs = new Set([...lt.by_manager.values()].map((t) => t.components.blended_strength_z));
    assert.equal(zs.size, 4);
  });

  it("Test F — a cross-league roster owner is rejected before scoring", () => {
    const ctx = ctxOf(["A", "B", "C", "D"]);
    const foreign: CanonicalRoster = { ...ctx.rosters_by_manager.get(MID("A"))!, canonical_team_id: "team:other-league:X" };
    ctx.rosters_by_manager.set("manager:other-league:X", foreign);
    const lt = buildLeagueThreat(ctx, D, MID("A"));
    assert.equal(lt.participant_set_mismatch, true);
    assert.ok(lt.participant_set.unexpected_participant_ids.includes("team:other-league:X"));
  });

  it("Test G — a snapshot membership change is not reusable: a new context reflects the new set", () => {
    const a = ctxOf(["A", "B", "C", "D"]);
    const b = ctxOf(["A", "B", "C", "E"]);
    const lta = buildLeagueThreat(a, D, MID("A"));
    const ltb = buildLeagueThreat(b, D, MID("A"));
    // both are valid 4-team sets, but their membership differs — snapshot A's
    // participant/threat state cannot stand in for snapshot B's.
    assert.equal(lta.participant_set.exact_match, true);
    assert.equal(ltb.participant_set.exact_match, true);
    assert.notDeepEqual(lta.participant_set.canonical_participant_ids, ltb.participant_set.canonical_participant_ids);
    assert.ok(lta.by_manager.has(MID("D")) && !lta.by_manager.has(MID("E")));
    assert.ok(ltb.by_manager.has(MID("E")) && !ltb.by_manager.has(MID("D")));
  });

  it("a participant-set mismatch fails the competitive recommendation closed but keeps threat-independent components (§6, §7)", async () => {
    const ctx = ctxOf(["A", "B", "C", "D"]);
    const ghost: CanonicalRoster = { ...ctx.rosters_by_manager.get(MID("A"))!, canonical_team_id: TID("Z") };
    ctx.rosters_by_manager.set(MID("Z"), ghost);

    const r = await evaluateCompetitiveTradeRequest(
      { league: "test-league", manager: "A", mode: "evaluate", counterparty: "B", give_assets: ["A_b"], receive_assets: ["B_b"] },
      { contextOverride: ctx },
    );
    // the competitive recommendation fails closed
    assert.equal(r.evaluation?.result.actionable, false);
    assert.equal(r.evaluation?.result.readiness, "UNAVAILABLE");
    // threat-independent components are still populated (§7 compositional)
    assert.ok(r.evaluation?.private_trade);
    assert.ok(r.evaluation?.market);
    assert.ok(r.snapshot && r.snapshot.league_snapshot_id);
  });

  it("resolveThreatParticipants returns the canonical (team) set, not the manager set", () => {
    const ctx = ctxOf(["A", "B", "C", "D"]);
    ctx.rosters_by_manager.set(MID("A2"), ctx.rosters_by_manager.get(MID("A"))!);
    const parts = resolveThreatParticipants(ctx);
    assert.equal(parts.canonical_team_ids.length, 4);
    assert.equal(parts.threat_team_ids.length, 4);
    assert.equal(parts.team_by_manager.size, 5);
  });
});
