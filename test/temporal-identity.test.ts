/**
 * Phase 7 — Temporal Identity / Team Membership. IDENTITY IS NOT MEMBERSHIP.
 * Real-data cases come from test/fixtures/temporal-real-movers.json (verbatim Supabase player_lab_game_logs rows around real transactions); nothing is hard-coded per player.
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeTeamCode, isNoTeamMarker, CANONICAL_TEAMS } from "@/lib/canonical/team-codes";
import { normalizeTeam } from "@/lib/matchup2/stats";
import { observation, resolvePlayerTeamAt, resolveOpponentAt, scheduleFromObservations, gameRowConsistency, isResolved, SOURCE_PRIORITY, type TeamObservation, type TemporalQuery } from "@/lib/temporal-identity/membership";
import { fromGameLogRows, fromRoleParticipationCsv, providerCurrent, crosswalkSnapshot, type GameLogRow } from "@/lib/temporal-identity/sources";
import { identityAliases, relateIdentities, identityLinks } from "@/lib/temporal-identity/identity-links";
import { PlayerCrosswalk, NoCrosswalk, type CrosswalkSource } from "@/lib/canonical/players";

const fx = JSON.parse(readFileSync("test/fixtures/temporal-real-movers.json", "utf8")) as { rows: Array<GameLogRow & { name: string }> };
const OBS = fromGameLogRows(fx.rows);
const G = (season: number, week: number): TemporalQuery => ({ kind: "GAME", season, week });
const ID = { cmc: "00-0033280", ertz: "00-0030061", sanders: "00-0027685", bell: "00-0030496", carter: "00-0031763", hopkins: "00-0030564", meyers: "00-0034960", hardman: "00-0035140", dobbs: "00-0033949", cooper: "00-0031544" };
const at = (id: string, s: number, w: number, obs: readonly TeamObservation[] = OBS) => resolvePlayerTeamAt(id, obs, G(s, w));

describe("team codes: one normalizer for four vocabularies", () => {
  it("aliases Rams LA/STL, directory codes, and treats FA markers as no-team (not a team)", () => {
    assert.equal(normalizeTeamCode("LA"), "LAR"); assert.equal(normalizeTeamCode("lvr"), "LV"); assert.equal(normalizeTeamCode("SFO"), "SF"); assert.equal(normalizeTeamCode("JAC"), "JAX");
    assert.equal(normalizeTeamCode("FA"), null); assert.equal(normalizeTeamCode("FA*"), null); assert.equal(normalizeTeamCode(""), null); assert.equal(normalizeTeamCode(null), null); assert.ok(isNoTeamMarker("FA*")); assert.ok(!isNoTeamMarker(null));
    assert.equal(normalizeTeamCode("ZZZ"), "ZZZ", "an unknown code is passed through, never guessed into a team"); assert.equal(CANONICAL_TEAMS.length, 32);
  });
  it("Matchup 2.0's normalizer is now the same function (behavior-preserving consolidation)", () => { for (const t of ["LA", "LVR", "SFO", "FA", "KC", null, "wsh"]) assert.equal(normalizeTeam(t as string | null), normalizeTeamCode(t as string | null)); });
  it("every raw team code in the real fixture normalizes into the 32 canonical teams", () => { for (const r of fx.rows) { assert.ok(CANONICAL_TEAMS.includes(normalizeTeamCode(r.team) as never), String(r.team)); assert.ok(CANONICAL_TEAMS.includes(normalizeTeamCode(r.opponent_team) as never), String(r.opponent_team)); } });
});

describe("mid-season transactions (real): resolution follows the player's team at that time", () => {
  it("McCaffrey 2022 CAR -> SF: before, at, and after the trade; opponent follows the EFFECTIVE team", () => {
    const g = (w: number) => at(ID.cmc, 2022, w); assert.equal(g(5).team, "CAR"); assert.equal(g(6).team, "CAR"); assert.equal(g(7).team, "SF"); assert.equal(g(8).team, "SF");
    assert.equal(g(9).status, "SUPPORTED_BRACKETED", "no game in week 9 (SF bye): same team both sides"); assert.equal(g(9).team, "SF"); assert.equal(g(9).gap_weeks, 1);
    const sched = scheduleFromObservations(OBS); const opp = (w: number) => resolveOpponentAt(ID.cmc, OBS, sched, G(2022, w));
    assert.equal(opp(6).opponent, "LAR", "week 6: CAR vs LA (raw 'LA' normalized)"); assert.equal(opp(7).opponent, "KC", "week 7: SF vs KC — NOT the pre-trade club's opponent"); assert.equal(opp(9).status, "UNAVAILABLE", "bye/no row: schedule cannot name an opponent");
  });
  it("Ertz 2021 PHI -> ARI (week 6/7), bye gap bracketed inside ARI", () => { assert.equal(at(ID.ertz, 2021, 6).team, "PHI"); assert.equal(at(ID.ertz, 2021, 7).team, "ARI"); const r = at(ID.ertz, 2021, 12); assert.equal(r.status, "SUPPORTED_BRACKETED"); assert.equal(r.team, "ARI"); });
  it("Sanders 2019 DEN -> SF and Hopkins 2024 TEN -> KC and Meyers 2025 LV -> JAX and Dobbs 2023 ARI -> MIN and Hardman 2023 NYJ -> KC", () => {
    for (const [id, s, wOld, tOld, wNew, tNew] of [[ID.sanders, 2019, 7, "DEN", 8, "SF"], [ID.hopkins, 2024, 7, "TEN", 8, "KC"], [ID.meyers, 2025, 9, "LV", 10, "JAX"], [ID.dobbs, 2023, 8, "ARI", 9, "MIN"], [ID.hardman, 2023, 6, "NYJ", 7, "KC"]] as const) { assert.equal(at(id, s, wOld).team, tOld, `${s} w${wOld}`); assert.equal(at(id, s, wNew).team, tNew, `${s} w${wNew}`); }
  });
  it("an UNLOCATED transition is AMBIGUOUS, never bridged: Bell 2020 (NYJ w5 / KC w7), Carter 2020 (HOU w10 / CHI w12), Bell 2021 (BAL w10 / TB w16, 5-week gap)", () => {
    for (const [id, s, w, a, b, gap] of [[ID.bell, 2020, 6, "NYJ", "KC", 1], [ID.carter, 2020, 11, "HOU", "CHI", 1], [ID.bell, 2021, 12, "BAL", "TB", 5]] as const) {
      const r = at(id, s, w); assert.equal(r.status, "AMBIGUOUS_TRANSITION", `${s} w${w}`); assert.equal(r.team, null); assert.deepEqual(r.candidates.map((c) => c.team), [a, b]); assert.equal(r.gap_weeks, gap);
      const o = resolveOpponentAt(id, OBS, scheduleFromObservations(OBS), G(s, w)); assert.equal(o.status, "UNAVAILABLE"); assert.equal(o.opponent, null, "no opponent is derived from an unlocated membership");
    }
  });
  it("same-team gaps are bracketed but the gap is exposed (Bell 2020 weeks 2-4: 3 weeks)", () => { const r = at(ID.bell, 2020, 3); assert.equal(r.status, "SUPPORTED_BRACKETED"); assert.equal(r.team, "NYJ"); assert.equal(r.gap_weeks, 3); assert.equal(r.evidence_class, "INFERRED_BETWEEN_OBSERVATIONS"); });
});

describe("offseason changes and season boundaries: no cross-season inference", () => {
  it("Cooper DAL (2021) -> CLE (2022) -> BUF (2024 wk7): each season stands on its own evidence", () => {
    assert.equal(at(ID.cooper, 2021, 19).team, "DAL"); assert.equal(at(ID.cooper, 2022, 1).team, "CLE"); assert.equal(at(ID.cooper, 2024, 6).team, "CLE"); assert.equal(at(ID.cooper, 2024, 7).team, "BUF");
  });
  it("before the first observed game of a season (or after the last) is NO_EVIDENCE — last season's team is never carried over", () => {
    const r = at(ID.hopkins, 2022, 3); assert.equal(r.status, "NO_EVIDENCE"); assert.equal(r.team, null); assert.ok(r.reasons.join(" ").includes("one side only"));
    assert.equal(at(ID.cooper, 2022, 20).status, "NO_EVIDENCE", "after his last 2022 game"); assert.equal(at(ID.cooper, 2023, 5).status, "NO_EVIDENCE", "a season with no rows is not inferred from 2022 or 2024");
  });
  it("a 2025 team never contaminates 2026 (the current-season Player-Scheme / Role vintage distinction)", () => {
    assert.equal(at(ID.hopkins, 2025 as number, 3).status, "NO_EVIDENCE"); assert.equal(at(ID.meyers, 2026, 1).status, "NO_EVIDENCE");
  });
});

describe("conflicts are structured, never hidden", () => {
  const extra = observation({ gsis_id: ID.cmc, season: 2022, week: 7, raw_team: "CAR", opponent: "KC", source: "ROLE_PARTICIPATION", granularity: "GAME_OBSERVED", source_record_id: "role:2022_07:cmc" });
  it("two sources disagree on the same game: CONFLICT, both candidates listed with sources, policy names one for lineage but no team is returned to join on", () => {
    const r = at(ID.cmc, 2022, 7, [...OBS, extra]); assert.equal(r.status, "CONFLICT"); assert.equal(r.team, null); assert.equal(r.candidates.length, 2);
    assert.deepEqual(r.candidates.map((c) => c.team).sort(), ["CAR", "SF"]); assert.equal(r.selected_by_policy, "CAR", "ROLE_PARTICIPATION outranks GAME_LOG in the single policy"); assert.equal(SOURCE_PRIORITY[0], "ROLE_PARTICIPATION");
    assert.equal(resolveOpponentAt(ID.cmc, [...OBS, extra], scheduleFromObservations(OBS), G(2022, 7)).status, "UNAVAILABLE");
  });
  it("agreeing sources are one supported fact with both sources cited", () => { const agree = { ...extra, raw_team: "SF", team: "SF" }; const r = at(ID.cmc, 2022, 7, [...OBS, agree]); assert.equal(r.status, "SUPPORTED_GAME"); assert.deepEqual(r.candidates[0]!.sources.sort(), ["GAME_LOG", "ROLE_PARTICIPATION"]); });
  it("a schedule with disagreeing opponent rows for a team-week is UNKNOWN, not silently one of them", () => {
    const bad = observation({ gsis_id: "x", season: 2022, week: 7, raw_team: "SF", opponent: "DEN", source: "GAME_LOG", granularity: "GAME_OBSERVED", source_record_id: "bad" }); const s = scheduleFromObservations([...OBS, bad]).opponentOf("SF", 2022, 7); assert.equal(s.kind, "UNKNOWN");
  });
});

describe("current-only evidence is never returned for a past time", () => {
  const nacuaProv = providerCurrent("00-0036322x", 2026, "LAR", "sleeper-players@2026-09-21"); const nacuaXw = crosswalkSnapshot("00-0036322x", 2026, "LA", "nfl_players@2026-03-18");
  const C: TemporalQuery = { kind: "CURRENT", season: 2026, week: 2 };
  it("CURRENT: live provider wins over the identity-table snapshot; the snapshot's raw 'LA' would not even join", () => {
    const r = resolvePlayerTeamAt("00-0036322x", [nacuaProv, nacuaXw], C); assert.equal(r.status, "SUPPORTED_CURRENT"); assert.equal(r.team, "LAR"); assert.equal(r.granularity, "CURRENT_ONLY"); assert.deepEqual(r.candidates.map((c) => c.sources[0]), ["PROVIDER_CURRENT"]);
  });
  it("CURRENT with only the crosswalk snapshot: usable but labelled SNAPSHOT_STALE_RISK and normalized", () => { const r = resolvePlayerTeamAt("00-0036322x", [nacuaXw], C); assert.equal(r.status, "SUPPORTED_CURRENT"); assert.equal(r.team, "LAR"); assert.equal(r.evidence_class, "SNAPSHOT_STALE_RISK"); });
  it("a provider reporting NO team now is NO_TEAM_OBSERVED (a free agent), not the snapshot's old team", () => { const fa = providerCurrent("y", 2026, null, "v"); const r = resolvePlayerTeamAt("y", [fa, crosswalkSnapshot("y", 2026, "WAS", "s")], C); assert.equal(r.status, "NO_TEAM_OBSERVED"); assert.equal(r.team, null); });
  it("a trade AFTER the last observed game is consistent, not a conflict: last game KC, provider now SF", () => {
    const wk1 = observation({ gsis_id: "z", season: 2026, week: 1, raw_team: "KC", source: "ROLE_PARTICIPATION", granularity: "GAME_OBSERVED", source_record_id: "r1" }); const r = resolvePlayerTeamAt("z", [wk1, providerCurrent("z", 2026, "SF", "v")], { kind: "CURRENT", season: 2026, week: 2 });
    assert.equal(r.status, "SUPPORTED_CURRENT"); assert.equal(r.team, "SF"); assert.match(r.reasons.join(" "), /consistent with a transition after that game — NOT a conflict/);
  });
  it("PAST time with only current-only evidence: CURRENT_ONLY_OUT_OF_SCOPE and NO team — never today's team for a historical week", () => {
    for (const q of [G(2025, 7), G(2026, 1)]) { const r = resolvePlayerTeamAt("00-0036322x", [nacuaProv, nacuaXw], q); assert.equal(r.status, "CURRENT_ONLY_OUT_OF_SCOPE"); assert.equal(r.team, null); assert.equal(isResolved(r.status), false); }
    assert.equal(resolveOpponentAt("00-0036322x", [nacuaProv, nacuaXw], scheduleFromObservations([]), G(2025, 7)).opponent, null);
  });
});

describe("determinism and Role participation adapter", () => {
  it("input order never changes a resolution", () => { const shuffled = [...OBS].reverse(); for (const [id, s, w] of [[ID.cmc, 2022, 7], [ID.bell, 2020, 6], [ID.ertz, 2021, 12]] as const) assert.deepEqual(at(id, s, w, shuffled), at(id, s, w, OBS)); });
  it("Role participation CSV: only rows with snaps/returns count; team normalized; record identity kept", () => {
    const csv = ["season,week,game_id,gsis_id,team,opponent,offensive_snaps,return_domain_active", "2026,1,2026_01_ATL_PIT,g1,PIT,ATL,67,FALSE", "2026,1,2026_01_ATL_PIT,g2,PIT,ATL,0,FALSE", "2026,1,2026_01_LA_SF,g3,LAR,SF,0,TRUE"].join("\n");
    const o = fromRoleParticipationCsv(csv); assert.deepEqual(o.map((x) => x.gsis_id), ["g1", "g3"]); assert.equal(o[0]!.source_record_id, "role:2026_01_ATL_PIT:g1"); assert.equal(o[0]!.granularity, "GAME_OBSERVED");
  });
});

describe("real-data validators", () => {
  it("LEAVE-ONE-OUT on 252 real rows: hide each interior game, resolve it from its neighbours — never a WRONG team (it is either correct or honestly AMBIGUOUS)", () => {
    let correct = 0, ambiguous = 0, wrong = 0, oneSided = 0;
    for (const r of fx.rows) {
      const rest = OBS.filter((o) => !(o.gsis_id === r.gsis_id && o.season === r.season && o.week === r.week)); const res = resolvePlayerTeamAt(r.gsis_id, rest, G(r.season, r.week));
      if (res.status === "SUPPORTED_BRACKETED") (res.team === normalizeTeamCode(r.team) ? correct++ : wrong++); else if (res.status === "AMBIGUOUS_TRANSITION") ambiguous++; else if (res.status === "NO_EVIDENCE") oneSided++; else wrong++;
    }
    assert.equal(wrong, 0, `bracket inference produced ${wrong} wrong teams`); assert.ok(correct > 150, `correct=${correct}`); assert.ok(ambiguous >= 1, "true transitions surface as AMBIGUOUS"); assert.equal(correct + ambiguous + oneSided, fx.rows.length);
  });
  it("row/schedule consistency: every real game row agrees with the schedule derived from all rows", () => { const s = scheduleFromObservations(OBS); for (const o of OBS) assert.equal(gameRowConsistency(o, s), "CONSISTENT"); });
});

describe("identity is stable across team changes; membership is separate", () => {
  const row = { gsis_id: "00-0033280", sleeper_id: "4034", full_name: "Christian McCaffrey", position: "RB", nfl_team: "CAR" };
  const src: CrosswalkSource = { name: "test", load: async () => [row] };
  it("same GSIS person, team A -> team B: canonical_player_id unchanged; only membership evidence differs", async () => {
    const cw = await PlayerCrosswalk.create(src); const obs = (team: string) => cw.resolve({ provider: "sleeper", provider_player_id: "4034", full_name: "Christian McCaffrey", position: "RB", nfl_team: team }).player;
    const a = obs("CAR"), b = obs("SF"); assert.equal(a.canonical_player_id, b.canonical_player_id); assert.equal(a.canonical_player_id, "player:gsis:00-0033280"); assert.equal(a.nfl_team, "CAR"); assert.equal(b.nfl_team, "SF");
  });
  it("no crosswalk: a provider-id identity is also team-independent", () => { const cw = new PlayerCrosswalk(NoCrosswalk); const f = (t: string) => cw.resolve({ provider: "sleeper", provider_player_id: "4034", full_name: "Christian McCaffrey", position: "RB", nfl_team: t }).player.canonical_player_id; assert.equal(f("CAR"), f("SF")); });
  it("name-only fallback ids DO change with team (documented) — so a deterministic alias set relates them WITHOUT mutating stored ids", () => {
    const cw = new PlayerCrosswalk(NoCrosswalk); const f = (t: string) => cw.resolve({ provider: "sleeper", provider_player_id: null, full_name: "Christian McCaffrey", position: "RB", nfl_team: t }).player.canonical_player_id;
    assert.notEqual(f("CAR"), f("SF")); assert.equal(relateIdentities({ full_name: "Christian McCaffrey", position: "RB" }, { full_name: "Christian McCaffrey", position: "RB" }), "POSSIBLE_SAME_PERSON_WEAK_ONLY");
  });
  it("alias set links the sleeper-id and gsis-id forms of one person (the real production split); a weak name match alone is never a link", () => {
    assert.deepEqual(identityAliases({ gsis_id: "00-0035719", sleeper_id: "5872" }).strong, ["player:gsis:00-0035719", "player:sleeper:5872"]);
    assert.equal(relateIdentities({ sleeper_id: "5872" }, { gsis_id: "00-0035719", sleeper_id: "5872" }), "SAME_PERSON"); assert.equal(relateIdentities({ sleeper_id: "5872" }, { sleeper_id: "5859" }), "DIFFERENT_OR_UNKNOWN");
    assert.equal(identityLinks({ gsis_id: "g", sleeper_id: "s" }).length, 2);
  });
});

describe("crosswalk precedence: the crosswalk answers WHO, the provider answers WHICH TEAM NOW", () => {
  const mk = (latest: string | null): CrosswalkSource => ({ name: "t", load: async () => [{ gsis_id: "00-0036322", sleeper_id: "9221", full_name: "Puka Nacua", position: "WR", nfl_team: latest }] });
  const res = async (latest: string | null, observed: string | null) => (await PlayerCrosswalk.create(mk(latest))).resolve({ provider: "sleeper", provider_player_id: "9221", full_name: "Puka Nacua", position: "WR", nfl_team: observed }).player.nfl_team;
  it("stale/other-vocabulary crosswalk team never overwrites the live observation (the real Nacua 'LA' vs 'LAR' defect, and the ~10% stale-snapshot class)", async () => {
    assert.equal(await res("LA", "LAR"), "LAR"); assert.equal(await res("PHI", "NE"), "NE"); assert.equal(await res("WAS", "SF"), "SF");
  });
  it("crosswalk team is only a NORMALIZED fallback when the provider supplied none; a provider value is used as observed", async () => { assert.equal(await res("LA", null), "LAR"); assert.equal(await res(null, null), null); assert.equal(await res("LA", "LAR"), "LAR"); });
});
