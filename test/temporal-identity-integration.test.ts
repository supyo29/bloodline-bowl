/** Phase 7 — integration with Player-Scheme, Role, Football Intelligence and the historical Matchup 2.0 join; failure codes; season-level evidence; boundaries. Real data throughout. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { observation, resolvePlayerTeamAt, scheduleFromObservations, failureCodeFor, TeamMembershipIndex, type TemporalQuery } from "@/lib/temporal-identity/membership";
import { fromGameLogRows, fromRoleParticipationCsv, schemeAsOfTeam, schemeVintageFlag, type GameLogRow } from "@/lib/temporal-identity/sources";
import { historicalEvidenceContext, historicalEvidenceAvailability } from "@/lib/temporal-identity/context";
import { teamMembershipEvidence } from "@/lib/book-ready/families/team-membership";
import { validateEvidenceBlock } from "@/lib/book-ready/validate";
import { schemeQbSpatialEvidence } from "@/lib/book-ready/families/player-scheme";
import { defaultContext } from "@/lib/book-ready/common";

const load = (f: string) => (JSON.parse(readFileSync(`test/fixtures/${f}`, "utf8")) as { rows: GameLogRow[] }).rows;
const g25 = fromGameLogRows([...load("temporal-live-movers-2025.json"), ...load("temporal-controls-2025.json")]);
const role = fromRoleParticipationCsv(readFileSync("lib/player-role-intelligence/data/player_game_role.csv", "utf8"));
const idx = new TeamMembershipIndex([...g25, ...role]); const sched = scheduleFromObservations([...g25, ...role]);
const G = (season: number, week: number): TemporalQuery => ({ kind: "GAME", season, week });
const CUT = { season: 2025, week: 18 }; const dirCsv = readFileSync("lib/player-scheme-intelligence/data/player_directory.csv", "utf8").split("\n").slice(1).map((l) => l.replace(/"/g, "").split(","));
const dirTeam = (g: string) => dirCsv.find((c) => c[0] === g)?.[3] ?? null;
const P = { brown: "00-0035676", deebo: "00-0035719", waddle: "00-0036613", fields: "00-0036945", nacua: "00-0039075", nix: "00-0039732", jefferson: "00-0036322", chase: "00-0036900" };

describe("Player-Scheme `current_team`: the window's team is the AS-OF team, not the directory label and not today's team", () => {
  it("REAL: for 2026 offseason movers the directory carries the CURRENT team while the window belongs to the 2025 club — the two differ", () => {
    for (const [g, asOf, dir] of [[P.brown, "PHI", "NEP"], [P.deebo, "WAS", "SFO"], [P.waddle, "MIA", "DEN"], [P.fields, "NYJ", "KCC"]] as const) { assert.equal(schemeAsOfTeam([...g25, ...role], g, CUT), asOf, g); assert.equal(dirTeam(g), dir, `directory label for ${g}`); assert.notEqual(schemeAsOfTeam([...g25], g, CUT), dir.replace("NEP", "NE").replace("SFO", "SF").replace("KCC", "KC")); }
  });
  it("vintage flag from the WINDOW's team vs the resolved current team: movers flagged TEAM_CHANGED; same-team controls SAME (Nacua raw 'LA' vs 'LAR' normalization is not a change)", () => {
    const flag = (g: string) => schemeVintageFlag(schemeAsOfTeam([...g25], g, CUT), idx.resolve(g, G(2026, 1)).team);
    for (const g of [P.brown, P.deebo, P.waddle, P.fields]) assert.equal(flag(g), "TEAM_CHANGED_SINCE_SCHEME_VINTAGE", g); for (const g of [P.nacua, P.nix, P.jefferson, P.chase]) assert.equal(flag(g), "SAME_TEAM_AS_SCHEME_VINTAGE", g);
    assert.equal(schemeVintageFlag(dirTeam(P.brown), idx.resolve(P.brown, G(2026, 1)).team), "SAME_TEAM_AS_SCHEME_VINTAGE", "the OLD comparison (directory vs today) would have hidden the change — this is why the window team is derived from temporal evidence");
  });
  it("EVERY Player-Scheme evidence block now carries the window-semantics limitation (label cannot imply 'team today')", () => {
    const qb = dirCsv.find((c) => c[2] === "QB" && readFileSync("lib/player-scheme-intelligence/data/qb_spatial_matrix.csv", "utf8").includes(`"${c[0]}"`))![0]!;
    const bs = schemeQbSpatialEvidence({ gsis_id: qb, window: "current_team" }, defaultContext()); assert.ok(bs.length > 0);
    for (const b of bs) assert.match(b.limitations.join(" "), /window semantics: 'current_team' = career rows on the player's AS-OF team at the source cutoff/);
  });
  it("the Book-Ready membership block shows the flag and states the directory label is a different, current-season label", () => {
    const r = resolvePlayerTeamAt(P.brown, idx, G(2026, 1)); const bs = teamMembershipEvidence(r, { scheme_as_of_team: schemeAsOfTeam([...g25], P.brown, CUT) }); for (const b of bs) assert.deepEqual(validateEvidenceBlock(b), []);
    const f = bs.find((b) => b.metric === "membership.scheme_window_vintage")!; assert.equal(f.value, "TEAM_CHANGED_SINCE_SCHEME_VINTAGE"); assert.match(f.limitations.join(" "), /directory's `nfl_team` is a DIFFERENT, current-season label/);
  });
});

describe("Role: team context per effective week; offseason mover, same-team control, and explicit history limits", () => {
  it("offseason mover (A.J. Brown): 2025 club and 2026 club resolve separately; Role attribution follows the effective week, never today's team", () => {
    const c25 = historicalEvidenceContext({ gsis_id: P.brown, season: 2025, week: 9, observations: idx, schedule: sched }), c26 = historicalEvidenceContext({ gsis_id: P.brown, season: 2026, week: 1, observations: idx, schedule: sched });
    assert.equal(c25.role_team, "PHI"); assert.equal(c26.role_team, "NE"); assert.equal(c26.opponent, "SEA"); assert.equal(c25.evidence_availability.role.state, "UNAVAILABLE"); assert.equal(c26.evidence_availability.role.state, "AVAILABLE_AS_OF");
  });
  it("same-team control (Puka Nacua, raw 'LA' in 2025 game logs, 'LAR' in 2026 Role): SAME club both seasons, no false change", () => { assert.equal(idx.resolve(P.nacua, G(2025, 10)).team, "LAR"); assert.equal(idx.resolve(P.nacua, G(2026, 1)).team, "LAR"); assert.equal(idx.resolve(P.nacua, G(2025, 10)).candidates[0]!.sources[0], "GAME_LOG"); });
  it("mid-season 2026 Role history does not exist (one preserved week): a week-2 membership is NO_EVIDENCE and Role availability is SOURCE_LAG — explicitly history-limited, not guessed", () => {
    const c = historicalEvidenceContext({ gsis_id: P.brown, season: 2026, week: 2, observations: idx, schedule: sched }); assert.equal(c.status, "UNAVAILABLE"); assert.equal(c.membership.status, "NO_EVIDENCE"); assert.equal(c.failure_code, "MEMBERSHIP_UNKNOWN"); assert.equal(c.evidence_availability.role.state, "SOURCE_LAG");
  });
  it("the Role file carries no prior-game history (prior_game_team empty on all 1,200 rows), so offseason changes cannot be read from Role itself — team change is established only by the temporal layer", () => {
    const L = readFileSync("lib/player-role-intelligence/data/player_game_role.csv", "utf8").split("\n"); const h = L[0]!.replace(/"/g, "").split(","); const pi = h.indexOf("prior_game_team"), ci = h.indexOf("team_changed_since_prior_game");
    const nonEmpty = L.slice(1).filter((l) => l.split(",")[pi]?.replace(/"/g, "")).length; assert.equal(nonEmpty, 0); assert.ok(L.slice(1).filter(Boolean).every((l) => l.split(",")[ci]?.replace(/"/g, "") === "FALSE"));
  });
});

describe("Football Intelligence join + historical Matchup capability (identity/opponent safe; features honestly limited)", () => {
  it("traded real player: FI join keys follow the effective team and the game's actual opponent; nothing about FI ratings is touched", () => {
    const c = historicalEvidenceContext({ gsis_id: P.deebo, season: 2026, week: 1, observations: idx, schedule: sched }); assert.deepEqual(c.fi_join, { offense_team: "SF", defense_team: "LAR", season: 2026, week: 1 });
    const p = historicalEvidenceContext({ gsis_id: P.deebo, season: 2025, week: 1, observations: idx, schedule: sched }); assert.deepEqual(p.fi_join, { offense_team: "WAS", defense_team: "NYG", season: 2025, week: 1 });
  });
  it("Phase 7 makes the join safe but does NOT create historical feature snapshots: FI HISTORY_LIMITED / UNAVAILABLE, Player-Scheme HISTORY_LIMITED / SOURCE_LAG, Matchup 2.0 UNAVAILABLE for historical games", () => {
    const a25 = historicalEvidenceAvailability(2025, 9), a22 = historicalEvidenceAvailability(2022, 4), a26 = historicalEvidenceAvailability(2026, 1);
    assert.equal(a25.football_intelligence.state, "UNAVAILABLE"); assert.equal(a25.player_scheme.state, "HISTORY_LIMITED"); assert.equal(a25.matchup2.state, "UNAVAILABLE"); assert.equal(a22.role.state, "UNAVAILABLE");
    assert.equal(a26.football_intelligence.state, "HISTORY_LIMITED"); assert.equal(a26.player_scheme.state, "SOURCE_LAG"); assert.equal(a26.role.state, "AVAILABLE_AS_OF"); assert.equal(a26.matchup2.state, "UNAVAILABLE");
    for (const a of [a25, a22, a26]) assert.ok(Object.values(a).every((x) => x.reason.length > 10));
  });
  it("NON_CURRENT_WEEK_UNSUPPORTED still stands: a chronology-safe NFL team lookup is not a historical fantasy-league snapshot", () => { assert.match(readFileSync("lib/weekly/context.ts", "utf8"), /NON_CURRENT_WEEK_UNSUPPORTED/); });
});

describe("failure codes, identity, season-level evidence, boundaries, lineage", () => {
  it("failure codes name the actual limitation", () => {
    assert.equal(failureCodeFor("BRACKET_GAP_TOO_LONG"), "BRACKET_GAP_TOO_LONG"); assert.equal(failureCodeFor("CURRENT_ONLY_OUT_OF_SCOPE"), "CURRENT_ONLY_FOR_HISTORICAL_QUERY"); assert.equal(failureCodeFor("AMBIGUOUS_TRANSITION"), "GRANULARITY_INSUFFICIENT"); assert.equal(failureCodeFor("CONFLICT"), "SOURCE_CONFLICT"); assert.equal(failureCodeFor("NO_EVIDENCE"), "MEMBERSHIP_UNKNOWN");
  });
  it("IDENTITY_UNRESOLVED: an id unknown to the identity table with no evidence is reported as such, not as a mere missing membership", () => {
    const r = resolvePlayerTeamAt("00-9999999", [], G(2024, 3)); const bs = teamMembershipEvidence(r, { identity_unresolved: true }); for (const b of bs) assert.deepEqual(validateEvidenceBlock(b), []); assert.match(bs[0]!.availability.reason!, /IDENTITY_UNRESOLVED/);
  });
  it("SEASON-level evidence: single club => SUPPORTED_SEASON labelled 'exact interval unknown' (never an exact date); two clubs => AMBIGUOUS; exact game evidence outranks it", () => {
    const S = (t: string, id: string) => observation({ gsis_id: "s", season: 2018, raw_team: t, source: "GAME_LOG", granularity: "SEASON_MEMBERSHIP", source_record_id: id });
    const one = resolvePlayerTeamAt("s", [S("KC", "a")], G(2018, 7)); assert.equal(one.status, "SUPPORTED_SEASON"); assert.equal(one.granularity, "SEASON_MEMBERSHIP"); assert.match(one.reasons.join(" "), /exact interval is unknown/);
    const two = resolvePlayerTeamAt("s", [S("KC", "a"), S("DEN", "b")], G(2018, 7)); assert.equal(two.status, "AMBIGUOUS_TRANSITION"); assert.equal(two.team, null);
    const game = observation({ gsis_id: "s", season: 2018, week: 7, raw_team: "DEN", source: "GAME_LOG", granularity: "GAME_OBSERVED", source_record_id: "g" }); assert.equal(resolvePlayerTeamAt("s", [S("KC", "a"), game], G(2018, 7)).team, "DEN");
    assert.equal(resolvePlayerTeamAt("s", [S("KC", "a")], G(2019, 7)).status, "NO_EVIDENCE", "season-level evidence never crosses seasons");
  });
  it("beginning/end boundaries (real Nix 2025: first game wk1, last wk20): exact at both ends, unresolved outside, safe bracket in the wk12 gap, long bracket rejected", () => {
    assert.equal(idx.resolve(P.nix, G(2025, 1)).status, "SUPPORTED_GAME"); assert.equal(idx.resolve(P.nix, G(2025, 20)).status, "SUPPORTED_GAME"); assert.equal(idx.resolve(P.nix, G(2025, 21)).status, "NO_EVIDENCE"); assert.equal(idx.resolve(P.nix, G(2025, 12)).status, "SUPPORTED_BRACKETED"); assert.equal(idx.resolve(P.nix, G(2025, 19)).status, "SUPPORTED_BRACKETED");
    const wide = [1, 9].map((w) => observation({ gsis_id: "w", season: 2025, week: w, raw_team: "DEN", source: "GAME_LOG", granularity: "GAME_OBSERVED", source_record_id: `w${w}` })); assert.equal(resolvePlayerTeamAt("w", wide, G(2025, 5)).status, "BRACKET_GAP_TOO_LONG");
  });
  it("A→B→A (real Bausby 2020: DEN wk6, ARI wk9, DEN wk12): a sparse bracket over the middle would be WRONG, so the cap refuses it; once the middle game is known it resolves ARI", () => {
    const mk = (w: number, t: string) => observation({ gsis_id: "b", season: 2020, week: w, raw_team: t, source: "GAME_LOG", granularity: "GAME_OBSERVED", source_record_id: `b${w}` });
    assert.equal(resolvePlayerTeamAt("b", [mk(6, "DEN"), mk(12, "DEN")], G(2020, 9)).status, "BRACKET_GAP_TOO_LONG"); assert.equal(resolvePlayerTeamAt("b", [mk(6, "DEN"), mk(9, "ARI"), mk(12, "DEN")], G(2020, 9)).team, "ARI");
    assert.equal(resolvePlayerTeamAt("b", [mk(6, "DEN"), mk(9, "ARI"), mk(12, "DEN")], G(2020, 10)).status, "AMBIGUOUS_TRANSITION");
  });
  it("lineage names the source vintages/cutoffs of the cited evidence; the temporal data version is a different identity from FI / player-data / scoring versions", () => {
    const r = resolvePlayerTeamAt(P.brown, idx, G(2026, 1)); assert.deepEqual(r.source_vintages, ["ROLE_PARTICIPATION:player_game_role.csv"]); const g = resolvePlayerTeamAt(P.brown, idx, G(2025, 3)); assert.deepEqual(g.source_vintages, ["GAME_LOG:player_lab_game_logs"]);
    const bs = teamMembershipEvidence(g); assert.deepEqual((bs[0]!.lineage.canonical as Record<string, unknown>).source_vintages, ["GAME_LOG:player_lab_game_logs"]); const fiVersion = JSON.parse(readFileSync("lib/football-intel/data/football_intelligence_manifest.json", "utf8")).football_intelligence_version as string;
    assert.match(g.evidence_version, /^tm:v1:/); assert.match(fiVersion, /^fi:2026:/); assert.notEqual(g.evidence_version.split(":")[0], fiVersion.split(":")[0]);
  });
});
