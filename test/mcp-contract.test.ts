/**
 * MCP connector — identity, envelope and compactor contracts (pure, offline).
 *
 *  - identity: exact-normalized matching only; ambiguity and absence are errors
 *    with candidates; no default manager, no fuzzy pick;
 *  - envelope: the connector never upgrades a bridge status; oversize results
 *    are withheld, never truncated;
 *  - compactors: numbers are copied from the route body, SHADOW_ONLY output is
 *    separated and labelled, unavailable waiver pools are stated.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDirectory, normalizeName, resolveLeagueInput, resolveManagerInput } from "../lib/mcp/identity";
import { bridgeStatus, deriveActionability, MAX_RESULT_BYTES, newEnvelope, routeFailure, toToolResult } from "../lib/mcp/envelope";
import { compactLineup, compactWaivers, compactWeekly, readinessSummary } from "../lib/mcp/compact";
import type { RouteResult } from "../lib/mcp/invoke";

/* --------------------------- fixture: a tiny league --------------------------- */

const STATE = {
  status: "READY",
  state: {
    league: { league_slug: "devoted-to-the-game", name: "Devoted to the Game", current_week: 6, scoring_fingerprint: "scoring:v1:abc" },
    week: 6,
    lineage: { league_snapshot_id: "snap:test" },
    managers: [
      { canonical_manager_id: "m:1", manager_slug: "darthmarker", provider_username: "DarthMarker", display_name: "DarthMarker" },
      { canonical_manager_id: "m:2", manager_slug: "shawnb555", provider_username: "ShawnB555", display_name: "ShawnB555" },
      { canonical_manager_id: "m:3", manager_slug: "lashespn", provider_username: "lashespn", display_name: "lashespn", is_co_manager: true },
      { canonical_manager_id: "m:4", manager_slug: "twin-a", provider_username: "twin-a", display_name: "Twin" },
      { canonical_manager_id: "m:5", manager_slug: "twin-b", provider_username: "twin-b", display_name: "Twin" },
    ],
    teams: [
      { canonical_team_id: "t:2", team_name: "The JSN Bourne Supremacy", canonical_manager_ids: ["m:1"] },
      { canonical_team_id: "t:10", team_name: "The Too Stooges", canonical_manager_ids: ["m:2", "m:3"] },
      { canonical_team_id: "t:4", team_name: "Team A", canonical_manager_ids: ["m:4"] },
      { canonical_team_id: "t:5", team_name: "Team B", canonical_manager_ids: ["m:5"] },
    ],
    standings: [],
    rosters: [{ canonical_team_id: "t:2", all_players: ["player:sleeper:11624", "player:gsis:00-0031492"] }],
    players: [
      { canonical_player_id: "player:sleeper:11624", full_name: "Xavier Worthy", position: "WR", nfl_team: "KC", identifiers: { sleeper_id: "11624" } },
      { canonical_player_id: "player:sleeper:8154", full_name: "Brian Robinson", position: "RB", nfl_team: "ATL", identifiers: { sleeper_id: "8154" } },
      { canonical_player_id: "player:gsis:00-0031492", full_name: "Jason Myers", position: "K", nfl_team: "SEA", identifiers: { sleeper_id: "2747", gsis_id: "00-0031492" } },
    ],
  },
};
const DIR = buildDirectory("devoted-to-the-game", STATE);

describe("MCP identity resolution", () => {
  it("normalizes case, punctuation and accents only", () => {
    assert.equal(normalizeName("The JSN Bourne Supremacy!"), "thejsnbournesupremacy");
    assert.equal(normalizeName("Chase(ng) Glory"), "chasengglory");
    assert.equal(normalizeName("Amon-Ra St. Brown"), "amonrastbrown");
  });

  it("resolves a league by slug or exact name, and lists candidates otherwise", () => {
    const a = resolveLeagueInput("Devoted to the Game");
    const b = resolveLeagueInput("devoted-to-the-game");
    assert.ok(a.ok && b.ok && a.league_slug === "devoted-to-the-game" && b.league_slug === a.league_slug);
    const miss = resolveLeagueInput("Devoted");
    assert.equal(miss.ok, false);
    assert.equal(!miss.ok && miss.code, "LEAGUE_NOT_FOUND");
    assert.ok(!miss.ok && (miss.candidates ?? []).length >= 2);
  });

  it("resolves a manager by slug, username, display name or exact team name", () => {
    for (const input of ["darthmarker", "DarthMarker", "the jsn bourne supremacy"]) {
      const r = resolveManagerInput(input, DIR);
      assert.ok(r.ok, input);
      assert.equal(r.ok && r.manager_slug, "darthmarker");
    }
  });

  it("a co-managed team name and a shared display name are AMBIGUOUS, never a pick", () => {
    const team = resolveManagerInput("The Too Stooges", DIR);
    assert.equal(!team.ok && team.code, "MANAGER_AMBIGUOUS");
    const twin = resolveManagerInput("Twin", DIR);
    assert.equal(!twin.ok && twin.code, "MANAGER_AMBIGUOUS");
    assert.deepEqual(!twin.ok && (twin.candidates as Array<{ manager_slug: string }>).map((c) => c.manager_slug).sort(), ["twin-a", "twin-b"]);
  });

  it("an unknown manager is NOT_FOUND with the league's real managers, and no substitute", () => {
    const r = resolveManagerInput("supyo29", DIR);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "MANAGER_NOT_FOUND");
    assert.equal(!r.ok && (r.candidates ?? []).length, 5);
  });

  it("partial names do not match (no fuzzy matching)", () => {
    assert.equal(resolveManagerInput("Darth", DIR).ok, false);
    assert.equal(resolveManagerInput("JSN", DIR).ok, false);
  });

  it("without a directory, only a slug-shaped value passes through, marked unverified", () => {
    const r = resolveManagerInput("darthmarker", null);
    assert.ok(r.ok && r.matched_on === "unverified_passthrough");
    assert.equal(resolveManagerInput("The JSN Bourne Supremacy", null).ok, false);
  });

  it("crosswalk: a gsis-keyed canonical id is still found from its sleeper id", () => {
    assert.equal(DIR.by_sleeper_id.get("2747"), "player:gsis:00-0031492");
    assert.equal(DIR.players.get("player:gsis:00-0031492")?.name, "Jason Myers");
  });
});

/* ---------------------------------- envelope ---------------------------------- */

const ok = (body: unknown, http = 200): RouteResult => ({ ok: true, route: "lineup", path: "/api/lineup/x/y/week/6", http_status: http, body, bytes: 10, ms: 1 });

describe("MCP envelope", () => {
  it("copies the bridge status verbatim, and maps {ok:false,error} to its code", () => {
    assert.equal(bridgeStatus(ok({ status: "PROJECTIONS_PARTIAL" })), "PROJECTIONS_PARTIAL");
    assert.equal(bridgeStatus(ok({ ok: false, error: "NON_CURRENT_WEEK_UNSUPPORTED", status: 400 }, 400)), "NON_CURRENT_WEEK_UNSUPPORTED");
    assert.equal(bridgeStatus(ok({ standings: [] })), "OK");
  });

  it("never upgrades: degraded/partial/unavailable statuses are never ACTIONABLE", () => {
    for (const s of ["PROJECTIONS_PARTIAL", "DEGRADED", "READY_WITH_LIMITATIONS", "SHADOW_ONLY", "STALE"]) assert.equal(deriveActionability(s), "LIMITED", s);
    for (const s of ["UNAVAILABLE", "BLOCKED", "NON_CURRENT_WEEK_UNSUPPORTED", "MANAGER_NOT_FOUND", "UPSTREAM_TIMEOUT", "HTTP_502"]) assert.equal(deriveActionability(s), "NOT_ACTIONABLE", s);
    assert.equal(deriveActionability("READY"), "ACTIONABLE");
    assert.equal(deriveActionability("READY", { limited: true }), "LIMITED");
    // "informational" can never lift a not-actionable status
    assert.equal(deriveActionability("UNAVAILABLE", { informational: true }), "NOT_ACTIONABLE");
  });

  it("a route failure keeps the bridge's code, detail and diagnostics", () => {
    const env = routeFailure(newEnvelope("bloodline_trade_evaluation", {}), ok({ status: "VALIDATION_FAILED", error_kind: "OWNERSHIP", diagnostics: [{ code: "INCOMING_NOT_OWNED", message: "Incoming player X is not on Y's roster." }] }, 409));
    assert.equal(env.status, "VALIDATION_FAILED");
    assert.equal(env.error?.detail, "Incoming player X is not on Y's roster.");
    assert.equal((env.error?.bridge as { error_kind: string }).error_kind, "OWNERSHIP");
  });

  it("an oversize result is withheld with OUTPUT_TOO_LARGE, never truncated", () => {
    const env = newEnvelope("bloodline_evidence", {});
    env.data = { blob: "x".repeat(MAX_RESULT_BYTES + 10) };
    const res = toToolResult(env);
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.status, "OUTPUT_TOO_LARGE");
    assert.equal(res.structuredContent.data, null);
  });
});

/* --------------------------------- compactors --------------------------------- */

const LINEUP_BODY = {
  status: "PROJECTIONS_PARTIAL",
  context: {
    week: 6,
    readiness: { weekly_projections: { status: "PARTIAL", usable: true, missing_roster_players: 0 }, live_provider: { status: "READY", usable: true } },
    lineage: { snapshot: { league_snapshot_id: "snap:test", scoring_fingerprint: "scoring:v1:abc", generated_at: "2026-10-13T00:00:00Z" }, projections: [{ role: "weekly_absolute", model_version: "sleeper-weekly-rotowire", status: "PARTIAL" }] },
    warnings: [{ code: "k_dst_weekly_approximated", severity: "warning", message: "K/D-ST approximated." }],
  },
  data: {
    lineup: {
      week: 6,
      optimal_total: 126.05,
      current_total: 121.83,
      slots: [{ slot: "WR", recommended_player_id: "player:sleeper:11624", recommended_projected: 13.37, recommended_floor: 9.1, recommended_ceiling: 17.6, current_player_id: "player:sleeper:8154", current_projected: 9.15, is_change: true, confidence: "MEDIUM", reason: "upgrade" }],
      changes_recommended: [{ slot: "WR", out: "player:sleeper:8154", in: "player:sleeper:11624", gain: 4.22 }],
    },
    start_sit: [{ slot: "WR", start_player_id: "player:sleeper:11624", over_player_id: "player:sleeper:8154", projection_edge: 4.2, confidence: "MEDIUM", recommendation: "START_A" }],
    roster_constraints: { starting_slots: ["QB", "RB", "WR"] },
  },
};

describe("MCP compactors", () => {
  it("lineup: numbers are copied exactly, ids keep names from the snapshot", () => {
    const c = compactLineup(LINEUP_BODY, DIR);
    const slot = (c.data.slots as Array<Record<string, Record<string, unknown>>>)[0]!;
    assert.equal(slot.recommended!.projected, 13.37);
    assert.equal(slot.recommended!.name, "Xavier Worthy");
    assert.equal(slot.current!.name, "Brian Robinson");
    assert.equal((c.data.lineup as { optimal_total: number }).optimal_total, 126.05);
    assert.equal(c.snapshot_id, "snap:test");
    assert.equal(c.limited, true, "PROJECTIONS_PARTIAL must be limited");
    assert.ok(c.limitations.some((l) => l.startsWith("weekly_projections: PARTIAL")));
    assert.equal(c.deployment.slots, "PRODUCTION");
  });

  it("weekly: SHADOW_ONLY blocks are excluded unless asked for, then separated and labelled", () => {
    const body = {
      status: "READY",
      readiness: {},
      intelligence: {
        week: 6,
        lineage: {},
        matchup: { win_probability: 0.225, win_probability_confidence: "LOW" },
        matchup_intelligence: { win_probability: 0.37, lineage: { deployment: "SHADOW_ONLY", matchup_model_version: "ri-matchup-2026.1" } },
        start_sit_shadow: { lineage: { deployment: "SHADOW_ONLY" }, lineup_differs: true },
      },
    };
    const plain = compactWeekly(body, null, DIR, false);
    assert.equal(plain.shadow, undefined);
    assert.equal(JSON.stringify(plain.data).includes("0.37"), false, "shadow win probability leaked into production data");
    assert.equal((plain.data.matchup as { win_probability: number }).win_probability, 0.225);

    const withShadow = compactWeekly(body, null, DIR, true);
    const sim = (withShadow.shadow as { matchup_simulation: { deployment: string; win_probability: number; banner: string } }).matchup_simulation;
    assert.equal(sim.deployment, "SHADOW_ONLY");
    assert.equal(sim.win_probability, 0.37);
    assert.match(sim.banner, /NOT the production/);
    assert.equal((withShadow.data.matchup as { win_probability: number }).win_probability, 0.225, "production block unchanged");
  });

  it("waivers: an unavailable free-agent pool is stated and never actionable", () => {
    const c = compactWaivers({ status: "READY", data: { availability_status: "UNAVAILABLE", unavailable_reason_code: "free_agent_pool_not_materialized", recommendations: [] } }, false);
    assert.equal(c.limited, true);
    assert.ok(c.limitations.some((l) => l.includes("no verified list of available players")));
  });

  it("readiness: reason prose is reduced to codes, statuses kept", () => {
    const r = readinessSummary({ market: { status: "READY", actionable: true, limitations: ["PENDING_CLAIMS_NOT_EXPOSED"] }, weekly_projections: { status: "PARTIAL", usable: true } });
    assert.deepEqual(r.summary.market, { status: "READY", actionable: true, limitations: ["PENDING_CLAIMS_NOT_EXPOSED"] });
    assert.equal(r.limited, true);
  });
});
