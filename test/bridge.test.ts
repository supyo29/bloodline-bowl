/**
 * Draft Bridge — deterministic unit tests (no network).
 *
 * Covers the multi-league guarantees the addendum makes mandatory:
 *   - profile resolution never falls back across leagues
 *   - per-league draft state cannot contaminate another league
 *   - a wrong-model or wrong-draft-id export fails CLOSED
 *   - every ChatGPT snapshot is self-identifying enough to answer
 *     "which league is this?" with no prior conversation history
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findBridgeProfile,
  knownBridgeSelectors,
  listBridgeProfiles,
} from "../lib/bridge/profiles";
import { computeDraftGeometry, overallPickNumber } from "../lib/bridge/geometry";
import { scoringIdentityHash } from "../lib/bridge/hash";
import {
  assertStateBelongsToLeague,
  BridgeIsolationError,
  clearPlayer,
  emptyDraftState,
  hydrateDraftState,
  markPlayer,
  minePlayerIds,
  reconcileDraftSource,
  type BridgeDraftState,
} from "../lib/bridge/state";
import {
  applyCustomRankingsToPool,
  matchCustomRankings,
  parseCustomRankings,
} from "../lib/bridge/rankings";
import {
  loadRankingPack,
  rankPoolByPack,
  validateRankingPack,
} from "../lib/bridge/ranking-packs";
import type { NormalizedPlayer } from "../lib/sleeper/types";
import {
  buildBridgeSnapshot,
  crossCheckExport,
  renderSnapshotText,
  BridgeExportError,
} from "../lib/bridge/snapshot";
import type { BridgeBoardResponse, BoardPlayer } from "../lib/bridge/board";
import type { BridgeLeagueProfile } from "../lib/bridge/profiles";

/* ------------------------------------------------------------------ setup -- */

const BLOODLINE = findBridgeProfile("bloodline_bowl") as BridgeLeagueProfile;
const DEVOTED = findBridgeProfile("devoted_to_the_game") as BridgeLeagueProfile;

function poolPlayer(over: Partial<BoardPlayer> & { player_id: string }): BoardPlayer {
  return {
    player_id: over.player_id,
    name: over.name ?? `Player ${over.player_id}`,
    position: over.position ?? "WR",
    fantasy_positions: over.fantasy_positions ?? [over.position ?? "WR"],
    team: over.team ?? "FA",
    injury_status: over.injury_status ?? null,
    bye_week: null,
    rank: over.rank ?? null,
    tier: over.tier ?? null,
    sleeper_search_rank: over.sleeper_search_rank ?? null,
    model_rank: over.model_rank ?? null,
    model_pos_rank: over.model_pos_rank ?? null,
    model_tier: over.model_tier ?? null,
    model_value: over.model_value ?? null,
    market_adp: over.market_adp ?? null,
    model_action: over.model_action ?? null,
    model_note: over.model_note ?? null,
  };
}

function fakeBoard(
  profile: BridgeLeagueProfile,
  over: Partial<BridgeBoardResponse> = {},
): BridgeBoardResponse {
  const modelLeague = profile.league_key === "devoted_to_the_game";
  const scoringSha = scoringIdentityHash(
    { rec: profile.league_key === "devoted_to_the_game" ? 1 : 0.5, pass_td: 4 },
    profile.roster_rules.roster_positions,
  );
  const pool: BoardPlayer[] =
    over.pool ??
    [
      poolPlayer({ player_id: "qb1", name: "Top QB", position: "QB", rank: 1, sleeper_search_rank: 1 }),
      poolPlayer({ player_id: "rb1", name: "Top RB", position: "RB", rank: 2, sleeper_search_rank: 2 }),
      poolPlayer({ player_id: "wr1", name: "Top WR", position: "WR", rank: 3, sleeper_search_rank: 3 }),
      poolPlayer({ player_id: "te1", name: "Top TE", position: "TE", rank: 4, sleeper_search_rank: 4 }),
      poolPlayer({ player_id: "rb2", name: "RB Two", position: "RB", rank: 5, sleeper_search_rank: 5 }),
      poolPlayer({ player_id: "k1", name: "Top K", position: "K", rank: 6, sleeper_search_rank: 6 }),
      poolPlayer({ player_id: "def1", name: "Top DEF", position: "DEF", rank: 7, sleeper_search_rank: 7 }),
    ];

  return {
    generated_at: "2026-08-30T18:00:00.000Z",
    schema: "bridge.board.v1",
    league_identity: {
      league_key: profile.league_key,
      league_name: profile.league_name,
      display_label: profile.display_label,
      short_label: profile.short_label,
      season: profile.season,
      platform: "sleeper",
      platform_league_id: profile.platform_league_id,
      platform_draft_id: profile.platform_draft_id,
      manager_key: profile.manager.manager_key,
      manager_display_name: profile.manager.display_name,
      manager_sleeper_user_id: profile.manager.sleeper_user_id,
      draft_slot: profile.manager.draft_slot,
      draft_slot_source: "sleeper_draft_order",
      team_count: profile.draft.team_count,
      draft_type: profile.draft.type,
      ...over.league_identity,
    },
    model_profile: {
      ...profile.model,
      live_scoring_sha256: scoringSha,
      ranking_source: modelLeague ? "model_pack" : "sleeper_search_rank",
      ranking_fallback_active: false,
      ...over.model_profile,
    },
    ranking_pack:
      over.ranking_pack !== undefined
        ? over.ranking_pack
        : modelLeague
          ? {
              pack_id: "darthmarker_2026",
              model_version: "v7",
              source: "rosterintel_mark_darthmarker_draft_model",
              source_artifact: "mark_overall_draft_board.csv",
              source_project: "rosterintel",
              source_board_sha256: "abc123",
              model_release_gate: "RELEASE_CANDIDATE_PENDING_REAL_EXCEL_CONNECTED_SESSION_TEST",
              model_release_note: "board table validated",
              generated_at: "2026-08-26T21:54:56.384Z",
              scoring_status: "MATCH" as const,
              roster_status: "MATCH" as const,
              status: "ACTIVE" as const,
              reasons: [],
              verified: true,
              verified_note: "scoring + roster match live",
              player_count: 240,
              matched_to_pool: 7,
              missing_from_sleeper: [],
              top_players_off_board: 0,
            }
          : null,
    ranking_quality:
      over.ranking_quality ??
      (modelLeague
        ? {
            status: "MODEL" as const,
            source_label: "DarthMarker 2026 Model (v7)",
            warning: null,
          }
        : {
            status: "MARKET" as const,
            source_label: "Sleeper search_rank (market baseline)",
            warning: null,
          }),
    rules: {
      roster_positions: profile.roster_rules.roster_positions,
      starters: profile.roster_rules.starters,
      bench: profile.roster_rules.bench,
      reserve: profile.roster_rules.reserve,
      flex_positions: profile.roster_rules.flex_positions,
      team_count: profile.draft.team_count,
      rounds: profile.draft.rounds,
      draft_type: profile.draft.type,
      matches_profile: true,
      ...over.rules,
    },
    scoring: {
      provider: "sleeper_live",
      scoring_sha256: scoringSha,
      captured_at: "2026-08-30T18:00:00.000Z",
      rec_points: profile.league_key === "devoted_to_the_game" ? 1 : 0.5,
      passing_td_points: 4,
      ppr_label: profile.league_key === "devoted_to_the_game" ? "full_ppr" : "half_ppr",
      ...over.scoring,
    },
    draft_feed: {
      draft_id: profile.platform_draft_id,
      status: "pre_draft",
      order: "snake",
      draft_order: {},
      slots: [],
      picks: [],
      overall_picks_made: 0,
      source_check: { ok: true },
      ...over.draft_feed,
    },
    pool,
    pool_truncated: false,
    opponent_modeling: profile.opponent_modeling,
    warnings: [],
    ...over,
  };
}

/* --------------------------------------------------------------- profiles -- */

describe("bridge profiles: resolution never crosses leagues", () => {
  it("resolves by league_key, registry_key, and alias", () => {
    assert.equal(findBridgeProfile("bloodline_bowl")?.league_key, "bloodline_bowl");
    assert.equal(findBridgeProfile("bloodline-bowl")?.league_key, "bloodline_bowl");
    assert.equal(
      findBridgeProfile("darthmarker")?.league_key,
      "devoted_to_the_game",
    );
    assert.equal(
      findBridgeProfile("DEVOTED-TO-THE-GAME")?.league_key,
      "devoted_to_the_game",
    );
  });

  it("returns null (never another league) for an unknown selector", () => {
    assert.equal(findBridgeProfile("nfl-redraft"), null);
    assert.equal(findBridgeProfile(""), null);
    assert.equal(findBridgeProfile(null), null);
  });

  it("keeps the two leagues on distinct keys and Sleeper ids", () => {
    const profiles = listBridgeProfiles();
    assert.equal(profiles.length, 2);
    assert.notEqual(profiles[0]!.league_key, profiles[1]!.league_key);
    assert.notEqual(
      profiles[0]!.platform_league_id,
      profiles[1]!.platform_league_id,
    );
    assert.notEqual(profiles[0]!.platform_draft_id, profiles[1]!.platform_draft_id);
    assert.deepEqual(knownBridgeSelectors(), [
      "bloodline_bowl",
      "devoted_to_the_game",
    ]);
  });

  it("points DarthMarker at its own ranking pack, never Bloodline's model", () => {
    assert.equal(DEVOTED.ranking_pack_id, "darthmarker_2026");
    assert.equal(DEVOTED.model.candidate_source, "rosterintel_ranking_pack");
    assert.equal(DEVOTED.model.survival_engine, null);
    assert.equal(BLOODLINE.ranking_pack_id, null);
    // Bloodline's declared identity must not appear anywhere on Devoted.
    assert.ok(
      !JSON.stringify(DEVOTED).includes("bloodline_production_20260827113702"),
    );
    assert.ok(!/bloodline/i.test(JSON.stringify(DEVOTED.model)));
  });

  it("keeps Bloodline's declared candidate id, explicitly unverified", () => {
    assert.equal(
      BLOODLINE.model.candidate_id,
      "bloodline_production_20260827113702",
    );
    assert.equal(BLOODLINE.model.candidate_verified, false);
    assert.equal(
      BLOODLINE.model.candidate_source,
      "league_owner_declared_unverified",
    );
  });

  it("preserves the DarthMarker 'exclude own history' design decision", () => {
    assert.equal(DEVOTED.opponent_modeling.exclude_own_historical_profile, true);
    assert.equal(
      BLOODLINE.opponent_modeling.exclude_own_historical_profile,
      false,
    );
  });
});

/* --------------------------------------------------------------- geometry -- */

describe("bridge geometry: derived from the active league only", () => {
  it("computes DarthMarker's slot-4 picks in a 12-team, 16-round snake", () => {
    const geo = computeDraftGeometry({
      slot: 4,
      teamCount: 12,
      rounds: 16,
      overallPicksMade: 0,
      order: "snake",
    });
    assert.deepEqual(
      geo.all_picks.slice(0, 5).map((p) => p.overall),
      [4, 21, 28, 45, 52],
    );
    assert.equal(geo.next_pick?.overall, 4);
    assert.equal(geo.following_pick?.overall, 21);
    assert.equal(geo.picks_until_next, 3);
    assert.equal(geo.wait_after_next, 16);
  });

  it("advances 'next pick' as the board fills", () => {
    const geo = computeDraftGeometry({
      slot: 4,
      teamCount: 12,
      rounds: 16,
      overallPicksMade: 10,
      order: "snake",
    });
    assert.equal(geo.next_pick?.overall, 21);
    assert.equal(geo.current_round, 2);
    assert.equal(geo.own_picks_made, 1);
  });

  it("uses Bloodline's own geometry (slot 7, 15 rounds) — not DarthMarker's", () => {
    const geo = computeDraftGeometry({
      slot: 7,
      teamCount: 12,
      rounds: 15,
      overallPicksMade: 0,
      order: "snake",
    });
    assert.equal(geo.all_picks.length, 15);
    assert.equal(geo.all_picks[0]!.overall, 7);
    assert.equal(geo.all_picks[1]!.overall, 18); // round 2: 24 - 7 + 1
  });

  it("linear order does not snake", () => {
    assert.equal(overallPickNumber(4, 2, 12, "linear"), 16);
    assert.equal(overallPickNumber(4, 2, 12, "snake"), 21);
  });

  it("rejects an impossible slot", () => {
    assert.throws(() =>
      computeDraftGeometry({
        slot: 15,
        teamCount: 12,
        rounds: 16,
        overallPicksMade: 0,
      }),
    );
  });
});

/* ----------------------------------------------------------- state guards -- */

describe("bridge state: isolation guards", () => {
  it("refuses a draft state that belongs to another league", () => {
    const foreign = emptyDraftState(DEVOTED);
    assert.throws(
      () => assertStateBelongsToLeague(BLOODLINE, foreign),
      (err: unknown) =>
        err instanceof BridgeIsolationError &&
        err.code === "LEAGUE_STATE_KEY_MISMATCH",
    );
  });

  it("discards a foreign stored blob and starts clean", () => {
    const foreign = markPlayer(emptyDraftState(DEVOTED), "wr1", "mine");
    const { state, warnings } = hydrateDraftState(BLOODLINE, foreign);
    assert.equal(state.league_key, "bloodline_bowl");
    assert.equal(Object.keys(state.entries).length, 0);
    assert.equal(warnings.length, 1);
  });

  it("rejects a Sleeper draft feed from the wrong league", () => {
    const result = reconcileDraftSource(DEVOTED, {
      league_id: BLOODLINE.platform_league_id,
      draft_id: BLOODLINE.platform_draft_id,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.code,
      "DRAFT_SOURCE_LEAGUE_MISMATCH",
    );
  });

  it("accepts a Sleeper draft feed for the right league", () => {
    const result = reconcileDraftSource(DEVOTED, {
      league_id: DEVOTED.platform_league_id,
      draft_id: DEVOTED.platform_draft_id,
    });
    assert.equal(result.ok, true);
  });
});

/* ---------------------------------------------- cross-league contamination -- */

describe("adversarial: cross-league contamination test (addendum §20)", () => {
  it("keeps each league's DRAFTED / MINE marks fully independent", () => {
    // Load Bloodline. Mark A = DRAFTED, B = MINE.
    let bloodline = emptyDraftState(BLOODLINE);
    bloodline = markPlayer(bloodline, "playerA", "drafted", {
      player: { name: "A", position: "RB", team: "X", fantasy_positions: ["RB"] },
    });
    bloodline = markPlayer(bloodline, "playerB", "mine", {
      player: { name: "B", position: "WR", team: "Y", fantasy_positions: ["WR"] },
    });

    // Switch to DarthMarker — its own (empty) stored state.
    let devoted = hydrateDraftState(DEVOTED, null).state;
    assert.equal(devoted.entries["playerA"], undefined);
    assert.equal(devoted.entries["playerB"], undefined);

    // Mark C = MINE in DarthMarker.
    devoted = markPlayer(devoted, "playerC", "mine", {
      player: { name: "C", position: "RB", team: "Z", fantasy_positions: ["RB"] },
    });

    // Switch back to Bloodline — roster unchanged, C absent.
    const bloodlineReloaded = hydrateDraftState(
      BLOODLINE,
      JSON.parse(JSON.stringify(bloodline)),
    ).state;
    assert.deepEqual(minePlayerIds(bloodlineReloaded), ["playerB"]);
    assert.equal(bloodlineReloaded.entries["playerC"], undefined);
    assert.equal(bloodlineReloaded.entries["playerA"]?.status, "drafted");

    // And DarthMarker still only has C.
    assert.deepEqual(minePlayerIds(devoted), ["playerC"]);
    assert.equal(devoted.entries["playerA"], undefined);
  });

  it("clearing a player in one league does not touch the other", () => {
    let devoted = markPlayer(emptyDraftState(DEVOTED), "shared1", "mine");
    const bloodline = markPlayer(emptyDraftState(BLOODLINE), "shared1", "drafted");
    devoted = clearPlayer(devoted, "shared1");
    assert.equal(devoted.entries["shared1"], undefined);
    assert.equal(bloodline.entries["shared1"]?.status, "drafted");
  });
});

/* -------------------------------------------------------- snapshot export -- */

describe("bridge snapshot: fail-closed cross-checks (addendum §21–23)", () => {
  it("PASSes when active league, board, and state all agree", () => {
    const board = fakeBoard(DEVOTED);
    const state = {
      ...emptyDraftState(DEVOTED),
      scoring_sha: board.scoring.scoring_sha256,
    };
    const check = crossCheckExport({
      activeLeagueKey: "devoted_to_the_game",
      board,
      state,
    });
    assert.equal(check.verdict, "PASS");
    const snap = buildBridgeSnapshot({
      activeLeagueKey: "devoted_to_the_game",
      board,
      state,
    });
    assert.equal(snap.integrity.verdict, "PASS");
  });

  it("BLOCKS when the active league differs from the board league", () => {
    const board = fakeBoard(DEVOTED);
    assert.throws(
      () =>
        buildBridgeSnapshot({
          activeLeagueKey: "bloodline_bowl",
          board,
          state: emptyDraftState(DEVOTED),
        }),
      (err: unknown) =>
        err instanceof BridgeExportError &&
        err.detail.includes("ACTIVE_LEAGUE_MISMATCH"),
    );
  });

  it("BLOCKS when the draft state key differs from the board league", () => {
    const board = fakeBoard(DEVOTED);
    assert.throws(
      () =>
        buildBridgeSnapshot({
          activeLeagueKey: "devoted_to_the_game",
          board,
          state: { ...emptyDraftState(BLOODLINE), league_key: "bloodline_bowl" },
        }),
      (err: unknown) =>
        err instanceof BridgeExportError &&
        err.detail.includes("LEAGUE_STATE_KEY_MISMATCH"),
    );
  });

  it("BLOCKS a wrong-model export (addendum §21)", () => {
    const board = fakeBoard(DEVOTED);
    const state = emptyDraftState(DEVOTED);
    // Attach Bloodline's model identity to a DarthMarker export.
    const check = crossCheckExport({
      activeLeagueKey: "devoted_to_the_game",
      board,
      state,
      expectedModel: {
        league_key: "bloodline_bowl",
        candidate_id: "bloodline_production_20260827113702",
      },
    });
    assert.equal(check.verdict, "BLOCKED");
    assert.equal(check.model_identity_check, "LEAGUE_MODEL_IDENTITY_MISMATCH");
    assert.throws(() =>
      buildBridgeSnapshot({
        activeLeagueKey: "devoted_to_the_game",
        board,
        state,
        expectedModel: { league_key: "bloodline_bowl" },
      }),
    );
  });

  it("BLOCKS a wrong-draft-id feed (addendum §22)", () => {
    const board = fakeBoard(DEVOTED, {
      draft_feed: {
        draft_id: BLOODLINE.platform_draft_id,
        status: "drafting",
        order: "snake",
        draft_order: {},
        slots: [],
        picks: [],
        overall_picks_made: 3,
        source_check: {
          ok: false,
          code: "DRAFT_SOURCE_LEAGUE_MISMATCH",
          detail: "feed is for another league",
        },
      },
    });
    assert.throws(
      () =>
        buildBridgeSnapshot({
          activeLeagueKey: "devoted_to_the_game",
          board,
          state: emptyDraftState(DEVOTED),
        }),
      (err: unknown) =>
        err instanceof BridgeExportError &&
        err.detail.includes("DRAFT_SOURCE_LEAGUE_MISMATCH"),
    );
  });

  it("BLOCKS when live scoring has drifted from what the state was built against", () => {
    const board = fakeBoard(DEVOTED);
    assert.throws(
      () =>
        buildBridgeSnapshot({
          activeLeagueKey: "devoted_to_the_game",
          board,
          state: {
            ...emptyDraftState(DEVOTED),
            scoring_sha: "0000stale0000",
          },
        }),
      (err: unknown) =>
        err instanceof BridgeExportError &&
        err.detail.includes("LEAGUE_SCORING_PROFILE_MISMATCH"),
    );
  });
});

/* --------------------------------------------- snapshot self-identification -- */

describe("bridge snapshot: self-identifying with no prior history", () => {
  function darthmarkerSnapshot() {
    const board = fakeBoard(DEVOTED);
    let state: BridgeDraftState = {
      ...emptyDraftState(DEVOTED),
      scoring_sha: board.scoring.scoring_sha256,
    };
    state = markPlayer(state, "rb1", "mine", {
      player: { name: "Top RB", position: "RB", team: "FA", fantasy_positions: ["RB"] },
      pick_no: 4,
      round: 1,
    });
    return buildBridgeSnapshot({
      activeLeagueKey: "devoted_to_the_game",
      board,
      state,
    });
  }

  it("identifies DarthMarker unambiguously (addendum §24)", () => {
    const snap = darthmarkerSnapshot();
    const text = JSON.stringify(snap);
    assert.match(snap.snapshot_title, /DARTHMARKER/);
    assert.equal(snap.league_identity.league_key, "devoted_to_the_game");
    assert.equal(snap.league_identity.league_name, "Devoted to the Game");
    assert.equal(snap.league_identity.platform_league_id, "1389735763649761280");
    assert.equal(snap.league_identity.draft_slot, 4);
    assert.equal(snap.league_identity.draft_type, "snake");
    assert.ok(text.includes("full_ppr"));
    assert.equal(
      (snap.ranking_quality as Record<string, unknown>).status,
      "MODEL",
    );
    assert.equal(
      (snap.ranking_pack as Record<string, unknown>).pack_id,
      "darthmarker_2026",
    );
  });

  it("a DarthMarker snapshot contains NO Bloodline identity (addendum §29)", () => {
    const text = JSON.stringify(darthmarkerSnapshot());
    assert.ok(!text.includes("bloodline_production_20260827113702"));
    assert.ok(!text.includes("canonical_stateful_survival_v1"));
    assert.ok(!/bloodline/i.test(text));
    assert.ok(!text.includes("1395549281678532608"));
  });

  it("a Bloodline snapshot carries its declared candidate and NO DarthMarker identity (addendum §30)", () => {
    const board = fakeBoard(BLOODLINE);
    const state = { ...emptyDraftState(BLOODLINE), scoring_sha: board.scoring.scoring_sha256 };
    const snap = buildBridgeSnapshot({
      activeLeagueKey: "bloodline_bowl",
      board,
      state,
    });
    const text = JSON.stringify(snap);
    assert.equal(
      (snap.model as Record<string, unknown>).candidate_id,
      "bloodline_production_20260827113702",
    );
    assert.equal((snap.model as Record<string, unknown>).candidate_verified, false);
    assert.ok(!text.includes("DarthMarker"));
    assert.ok(!text.includes("devoted_to_the_game"));
    assert.ok(!text.includes("1389735763649761280"));
    assert.match(snap.snapshot_title, /BLOODLINE BOWL/);
  });

  it("embeds analysis instructions that forbid cross-league scoring", () => {
    const snap = darthmarkerSnapshot();
    const rules = (snap.analysis_instructions as { rules: string[] }).rules.join(" ");
    assert.match(rules, /Analyze only the Devoted to the Game league/);
    assert.match(rules, /Do not apply any other league/i);
    assert.match(rules, /PRIMARY model evidence/);
    assert.match(rules, /SECONDARY market context/);
  });

  it("falls back loudly when the ranking pack is not active (addendum §11)", () => {
    const board = fakeBoard(DEVOTED, {
      model_profile: {
        ...fakeBoard(DEVOTED).model_profile,
        ranking_source: "sleeper_fallback",
      },
      ranking_quality: {
        status: "FALLBACK",
        source_label: "Sleeper search_rank — FALLBACK",
        warning: "DarthMarker canonical ranking pack is not active: scoring mismatch.",
      },
      ranking_pack: null,
    });
    const state = { ...emptyDraftState(DEVOTED), scoring_sha: board.scoring.scoring_sha256 };
    const snap = buildBridgeSnapshot({
      activeLeagueKey: "devoted_to_the_game",
      board,
      state,
    });
    assert.equal((snap.ranking_quality as Record<string, unknown>).status, "FALLBACK");
    assert.match(
      String((snap.ranking_quality as Record<string, unknown>).warning),
      /not active/,
    );
    const rules = (snap.analysis_instructions as { rules: string[] }).rules.join(" ");
    assert.match(rules, /model ranking pack is NOT active/i);
    // Still fully self-identifying and PASS on integrity.
    assert.equal(snap.integrity.verdict, "PASS");
  });

  it("renders a plain-text companion that names the league first", () => {
    const txt = renderSnapshotText(darthmarkerSnapshot());
    assert.match(txt.split("\n")[0]!, /LEAGUE: DEVOTED TO THE GAME/);
    assert.match(txt, /SLOT: 4/);
    assert.match(txt, /NEXT PICK:/);
  });
});

/* --------------------------------------------------------------- rankings -- */

describe("bridge rankings: league-specific, swappable", () => {
  it("parses a CSV rankings file with a header row", () => {
    const { rankings, errors } = parseCustomRankings(
      "rank,name,position,tier\n1,Ja'Marr Chase,WR,1\n2,Bijan Robinson,RB,1\n3,CeeDee Lamb,WR,2",
    );
    assert.equal(errors.length, 0);
    assert.equal(rankings.length, 3);
    assert.equal(rankings[0]!.name, "Ja'Marr Chase");
    assert.equal(rankings[0]!.rank, 1);
    assert.equal(rankings[1]!.tier, 1);
  });

  it("parses a JSON rankings array", () => {
    const { rankings } = parseCustomRankings(
      JSON.stringify([
        { name: "Player One", pos: "RB", rank: 2 },
        { name: "Player Two", pos: "WR", rank: 1 },
      ]),
    );
    assert.equal(rankings[0]!.name, "Player Two");
    assert.equal(rankings[0]!.rank, 1);
  });

  it("matches rankings to players by name and position", () => {
    const players = [
      { player_id: "1", full_name: "Bijan Robinson", position: "RB", fantasy_positions: ["RB"], search_rank: 5 },
      { player_id: "2", full_name: "Justin Jefferson", position: "WR", fantasy_positions: ["WR"], search_rank: 1 },
    ];
    const { rankings } = parseCustomRankings("1,Justin Jefferson,WR\n2,Bijan Robinson,RB");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { matched, unmatched } = matchCustomRankings(rankings, players as any);
    assert.equal(unmatched.length, 0);
    assert.equal(matched.find((m) => m.name === "Justin Jefferson")?.player_id, "2");
  });

  it("reorders a board pool by a matched custom file, unranked players last", () => {
    const pool: BoardPlayer[] = [
      poolPlayer({ player_id: "a", sleeper_search_rank: 1 }),
      poolPlayer({ player_id: "b", sleeper_search_rank: 2 }),
      poolPlayer({ player_id: "c", sleeper_search_rank: 3 }),
    ];
    const reordered = applyCustomRankingsToPool(pool, [
      { player_id: "c", name: "c", position: null, rank: 1, tier: 1 },
      { player_id: "a", name: "a", position: null, rank: 2, tier: 1 },
    ]);
    assert.deepEqual(reordered.map((p) => p.player_id), ["c", "a", "b"]);
    assert.equal(reordered[0]!.rank, 1);
    assert.equal(reordered[2]!.rank, null);
  });
});

/* --------------------------------------------------- darthmarker ranking pack -- */

describe("bridge ranking pack: DarthMarker 2026 (Roster Intel v7)", () => {
  const pack = loadRankingPack("darthmarker_2026")!;
  const roster = DEVOTED.roster_rules.roster_positions;
  const liveSha = scoringIdentityHash(pack.ranking_identity.scoring_settings, roster);

  it("is vendored and shaped correctly", () => {
    assert.ok(pack);
    assert.equal(pack.league_identity.league_key, "devoted_to_the_game");
    assert.equal(pack.league_identity.draft_slot, 4);
    assert.equal(pack.players.length, 240);
    assert.equal(pack.players[0]!.overall_rank, 1);
    // Every row carries a direct Sleeper id and a dense rank.
    pack.players.forEach((p, i) => {
      assert.equal(p.overall_rank, i + 1);
      assert.ok(p.sleeper_id && p.sleeper_id.length > 0);
    });
    assert.equal(pack.ranking_identity.model_version, "v7");
    assert.equal(pack.ranking_identity.pick_path?.[0], 4);
    assert.deepEqual(pack.ranking_identity.pick_path?.slice(0, 4), [4, 21, 28, 45]);
  });

  it("carries no Bloodline league identity anywhere", () => {
    assert.ok(!/bloodline/i.test(JSON.stringify(pack)));
    assert.ok(!JSON.stringify(pack).includes("1395549281678532608"));
  });

  it("validates ACTIVE against the live DarthMarker league config", () => {
    const v = validateRankingPack(pack, {
      leagueKey: "devoted_to_the_game",
      rosterPositions: roster,
      teamCount: 12,
      rounds: 16,
      draftType: "snake",
      flexPositions: ["RB", "WR", "TE"],
      liveScoringSha256: liveSha,
    });
    assert.equal(v.status, "ACTIVE");
    assert.equal(v.scoring_status, "MATCH");
    assert.equal(v.roster_status, "MATCH");
    assert.deepEqual(v.reasons, []);
  });

  it("BLOCKS on a scoring mismatch (fails closed)", () => {
    const v = validateRankingPack(pack, {
      leagueKey: "devoted_to_the_game",
      rosterPositions: roster,
      teamCount: 12,
      rounds: 16,
      draftType: "snake",
      flexPositions: ["RB", "WR", "TE"],
      liveScoringSha256: "different-hash",
    });
    assert.equal(v.status, "BLOCKED");
    assert.equal(v.scoring_status, "UNVERIFIED");
  });

  it("BLOCKS on a roster mismatch (e.g. wrong team count / rounds / flex)", () => {
    const v = validateRankingPack(pack, {
      leagueKey: "devoted_to_the_game",
      rosterPositions: ["QB", "RB", "WR", "FLEX", "K", "DEF", "BN"],
      teamCount: 10,
      rounds: 15,
      draftType: "snake",
      flexPositions: ["RB", "WR", "TE"],
      liveScoringSha256: liveSha,
    });
    assert.equal(v.status, "BLOCKED");
    assert.equal(v.roster_status, "MISMATCH");
  });

  it("BLOCKS if pointed at the wrong league", () => {
    const v = validateRankingPack(pack, {
      leagueKey: "bloodline_bowl",
      rosterPositions: roster,
      teamCount: 12,
      rounds: 16,
      draftType: "snake",
      flexPositions: ["RB", "WR", "TE"],
      liveScoringSha256: liveSha,
    });
    assert.equal(v.status, "BLOCKED");
    assert.ok(v.reasons.some((r) => r.includes("league")));
  });

  it("ranks a pool by pack overall_rank, unknown players trailing", () => {
    const mk = (id: string, name: string, search: number): NormalizedPlayer => ({
      player_id: id,
      full_name: name,
      first_name: null,
      last_name: null,
      position: "RB",
      fantasy_positions: ["RB"],
      team: "X",
      age: null,
      years_exp: null,
      status: null,
      injury_status: null,
      number: null,
      active: true,
      search_rank: search,
      resolved: true,
    });
    // "9509" = Bijan (pack rank 2), "9221" = Gibbs (pack rank 1) per the v7 board.
    const available = [
      mk("9509", "Bijan Robinson", 1),
      mk("nobody", "Some Guy", 2),
      mk("9221", "Jahmyr Gibbs", 3),
    ];
    // A full index: every pack player exists in Sleeper's DB.
    const index = new Map<string, NormalizedPlayer>(
      available.map((p) => [p.player_id, p]),
    );
    for (const pp of pack.players) {
      if (!index.has(pp.sleeper_id)) index.set(pp.sleeper_id, mk(pp.sleeper_id, pp.player, 999));
    }
    const { ranked, diagnostics } = rankPoolByPack(available, pack, index);
    assert.equal(ranked[0]!.player.player_id, "9221"); // Gibbs, pack #1
    assert.equal(ranked[1]!.player.player_id, "9509"); // Bijan, pack #2
    assert.equal(ranked[2]!.player.player_id, "nobody"); // not in pack -> last
    assert.equal(ranked[2]!.overall_rank, null);
    assert.equal(diagnostics.matched, 2);
    assert.equal(diagnostics.missing_from_sleeper.length, 0);
    // The other ~70 top-72 pack players are "off board" (not in the 3-player pool).
    assert.ok(diagnostics.top_players_off_board > 60);
  });
});
