/**
 * Phase 7 — adversarial certification: chronology (no lookahead), latest_team leakage, conflicts, identity collisions/stability, determinism, versioning, boundaries.
 * Real data: three verbatim fixtures recorded from Supabase player_lab_game_logs (252 + 585 + 64 rows) and the real Role / FI files. Nothing is hard-coded per player.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { observation, resolvePlayerTeamAt, resolveOpponentAt, scheduleFromObservations, temporalDataVersion, failureCodeFor, TeamMembershipIndex, DEPTH_CHART_HISTORY, DEFAULT_MAX_BRACKET_GAP_WEEKS, type TeamObservation, type TemporalQuery, type ResolveOptions } from "@/lib/temporal-identity/membership";
import { fromGameLogRows, fromRoleParticipationCsv, providerCurrent, crosswalkSnapshot, type GameLogRow } from "@/lib/temporal-identity/sources";
import { historicalEvidenceContext } from "@/lib/temporal-identity/context";
import { identityAliases, relateIdentities } from "@/lib/temporal-identity/identity-links";
import { teamMembershipEvidence } from "@/lib/book-ready/families/team-membership";
import { validateEvidenceBlock } from "@/lib/book-ready/validate";
import { PlayerCrosswalk, type CrosswalkSource } from "@/lib/canonical/players";
import { playerDataVersion } from "@/lib/canonical/player-data-version";
import { scoringFingerprint } from "@/lib/canonical/scoring-fingerprint";
import { normalizeTeamCode } from "@/lib/canonical/team-codes";

const load = (f: string) => (JSON.parse(readFileSync(`test/fixtures/${f}`, "utf8")) as { rows: Array<GameLogRow & { group?: string; name?: string }> }).rows;
const R1 = load("temporal-real-movers.json"), R2 = load("temporal-real-sample.json"), R3 = load("temporal-live-movers-2025.json");
const ALL_ROWS = [...R1, ...R2, ...R3]; const OBS = fromGameLogRows(ALL_ROWS); const G = (season: number, week: number): TemporalQuery => ({ kind: "GAME", season, week });
const playerSeasons = [...new Set(OBS.map((o) => `${o.gsis_id}|${o.season}`))].map((k) => { const [g, s] = k.split("|"); return { g: g!, s: Number(s) }; });
const j = (x: unknown) => JSON.stringify(x);

describe("chronology: FUTURE MUTATION INVARIANCE (no lookahead)", () => {
  const mutateFuture = (obs: readonly TeamObservation[], after: { season: number; week: number }): TeamObservation[] => {
    const out: TeamObservation[] = [];
    for (const o of obs) { const future = o.season > after.season || (o.season === after.season && (o.week ?? 0) > after.week); out.push(future ? observation({ gsis_id: o.gsis_id, season: o.season, week: o.week, raw_team: "ZZZ", opponent: "YYY", source: o.source, granularity: o.granularity, source_record_id: `${o.source_record_id}#mut` }) : o); }
    for (const [g, s] of Array.from(new Set(obs.map((o) => `${o.gsis_id}|${after.season}`))).map((k) => k.split("|") as [string, string])) for (let w = after.week + 1; w <= after.week + 3; w++) out.push(observation({ gsis_id: g, season: Number(s), week: w, raw_team: "QQQ", source: "GAME_LOG", granularity: "GAME_OBSERVED", source_record_id: `future:${g}:${w}` }));
    for (const g of new Set(obs.map((o) => o.gsis_id))) out.push(providerCurrent(g, 2026, "WWW", "future"), crosswalkSnapshot(g, 2026, "VVV", "future"), observation({ gsis_id: g, season: 2027, week: 1, raw_team: "UUU", source: "GAME_LOG", granularity: "GAME_OBSERVED", source_record_id: `f27:${g}` }));
    return out;
  };
  it("STRICT as-of mode: for every real player-season and EVERY cutoff week T, adding/mutating any evidence after T cannot change any result at or before T (results AND evidence versions identical)", () => {
    let checked = 0;
    for (const { g, s } of playerSeasons) for (let T = 1; T <= 22; T += 3) {
      const cut: ResolveOptions = { knownThrough: { season: s, week: T } }; const base = OBS.filter((o) => o.season < s || (o.season === s && (o.week ?? 0) <= T)); const mutated = mutateFuture(OBS, { season: s, week: T });
      for (let w = 1; w <= T; w++) { assert.equal(j(resolvePlayerTeamAt(g, mutated, G(s, w), cut)), j(resolvePlayerTeamAt(g, base, G(s, w), cut)), `${g} ${s} w${w} T${T}`); checked++; }
    }
    assert.ok(checked > 5000, `checked ${checked}`);
  });
  it("RETROSPECTIVE mode is not lookahead-free within a season (a bye bracket uses the next game) — which is exactly why knownThrough exists: same query, cutoff before the next game => NO_EVIDENCE", () => {
    const ps = playerSeasons.find(({ g, s }) => { const w = OBS.filter((o) => o.gsis_id === g && o.season === s).map((o) => o.week!).sort((a, b) => a - b); return w.some((x, i) => i > 0 && x - w[i - 1]! === 2); })!; const ws = OBS.filter((o) => o.gsis_id === ps.g && o.season === ps.s).map((o) => o.week!).sort((a, b) => a - b); const gapWeek = ws.find((x, i) => i > 0 && x - ws[i - 1]! === 2)! - 1;
    assert.equal(resolvePlayerTeamAt(ps.g, OBS, G(ps.s, gapWeek)).status, "SUPPORTED_BRACKETED"); const strict = resolvePlayerTeamAt(ps.g, OBS, G(ps.s, gapWeek), { knownThrough: { season: ps.s, week: gapWeek } }); assert.equal(strict.status, "NO_EVIDENCE"); assert.equal(strict.basis, "KNOWN_THROUGH");
  });
  it("CROSS-SEASON: MODIFYING any 2026+ assignment (game, provider-now, identity snapshot) changes NO 2019-2025 result, byte-for-byte — retrospective mode, every real query", () => {
    const withOld = (t: string) => [...OBS.filter((o) => o.season <= 2025), ...Array.from(new Set(OBS.map((o) => o.gsis_id))).flatMap((g) => [providerCurrent(g, 2026, t, "v"), crosswalkSnapshot(g, 2026, t, "s")])];
    const gs = Array.from(new Set(OBS.map((o) => o.gsis_id))); const before = [...withOld("AAA"), ...gs.map((g) => observation({ gsis_id: g, season: 2026, week: 1, raw_team: "AAA", source: "ROLE_PARTICIPATION", granularity: "GAME_OBSERVED", source_record_id: `r26:${g}` }))];
    const mutated = [...withOld("WWW"), ...gs.map((g) => observation({ gsis_id: g, season: 2026, week: 1, raw_team: "ZZZ", source: "ROLE_PARTICIPATION", granularity: "GAME_OBSERVED", source_record_id: `r26:${g}` })), ...gs.map((g) => observation({ gsis_id: g, season: 2027, week: 3, raw_team: "QQQ", source: "GAME_LOG", granularity: "GAME_OBSERVED", source_record_id: `f27:${g}` }))]; let n = 0;
    for (const { g, s } of playerSeasons) for (let w = 1; w <= 22; w++) { assert.equal(j(resolvePlayerTeamAt(g, mutated, G(s, w))), j(resolvePlayerTeamAt(g, before, G(s, w))), `${g} ${s} w${w}`); n++; }
    assert.ok(n > 1400);
  });
  it("the mere PRESENCE of current-only evidence never changes a resolved historical answer (team and status identical); it can only turn an unresolved NO_EVIDENCE into the more informative CURRENT_ONLY_OUT_OF_SCOPE, without echoing any team", () => {
    const past = OBS.filter((o) => o.season <= 2025); const withNow = [...past, ...Array.from(new Set(OBS.map((o) => o.gsis_id))).map((g) => providerCurrent(g, 2026, "WWW", "v"))]; let flips = 0;
    for (const { g, s } of playerSeasons) for (let w = 1; w <= 22; w++) { const a = resolvePlayerTeamAt(g, past, G(s, w)), b = resolvePlayerTeamAt(g, withNow, G(s, w)); if (a.team != null) assert.equal(j(a), j(b)); else { assert.equal(b.team, null); if (a.status !== b.status) { assert.equal(a.status, "NO_EVIDENCE"); assert.equal(b.status, "CURRENT_ONLY_OUT_OF_SCOPE"); assert.deepEqual(b.candidates, []); assert.doesNotMatch(j(b), /WWW/); flips++; } } }
    assert.ok(flips > 0, "the informative status is exercised");
  });
});

describe("no lookahead through latest_team", () => {
  it("an identity-table `latest_team` snapshot (even listed FIRST and naming a different club) never alters a historical result — zero leaks across every real game row", () => {
    let leaks = 0, rows = 0;
    for (const r of ALL_ROWS) { const snap = crosswalkSnapshot(r.gsis_id, 2026, "ZZZ", "nfl_players@2026-03-18"); const res = resolvePlayerTeamAt(r.gsis_id, [snap, providerCurrent(r.gsis_id, 2026, "YYY", "now"), ...OBS], G(r.season, r.week)); rows++; if (res.team !== normalizeTeamCode(r.team)) leaks++; }
    assert.equal(leaks, 0, `${leaks} of ${rows} historical resolutions leaked a current-only team`); assert.ok(rows > 800);
  });
  it("where no game evidence exists, the snapshot/provider team is NOT offered for a past week (CURRENT_ONLY_OUT_OF_SCOPE / NO_EVIDENCE), across every real player-season", () => {
    for (const { g, s } of playerSeasons) { const gap = [1, 2, 3, 21, 22].find((w) => !OBS.some((o) => o.gsis_id === g && o.season === s && o.week === w)); if (gap == null) continue; const r = resolvePlayerTeamAt(g, [crosswalkSnapshot(g, 2026, "ZZZ", "s"), ...OBS.filter((o) => o.season !== s)], G(s, gap)); assert.equal(r.team, null); assert.ok(["CURRENT_ONLY_OUT_OF_SCOPE", "NO_EVIDENCE"].includes(r.status), r.status); }
  });
  it("offseason movers (real, both seasons): the prior-season club and the new-season club never contaminate each other", () => {
    const by = (grp: string) => R2.filter((r) => r.group === grp); const prior = new Map<string, string>(); for (const r of by("OFF_PRIOR")) prior.set(r.gsis_id, normalizeTeamCode(r.team)!);
    let compared = 0; for (const r of by("OFF_NEW")) { const p = prior.get(r.gsis_id); if (!p) continue; const a = resolvePlayerTeamAt(r.gsis_id, OBS, G(r.season - 1, [...R2].find((x) => x.gsis_id === r.gsis_id && x.season === r.season - 1)!.week)); const b = resolvePlayerTeamAt(r.gsis_id, OBS, G(r.season, r.week)); assert.equal(a.team, p); assert.equal(b.team, normalizeTeamCode(r.team)); assert.notEqual(a.team, b.team); compared++; }
    assert.ok(compared >= 10, `compared ${compared}`);
  });
});

describe("real-data validation: accuracy, conflicts, unknowns, leakage (report, not filter)", () => {
  const idx = new TeamMembershipIndex(OBS);
  it("EVERY real game row resolves to exactly its own team (exact matches), with zero conflicts among the real rows", () => {
    let exact = 0, conflict = 0, mismatch = 0; for (const r of ALL_ROWS) { const res = idx.resolve(r.gsis_id, G(r.season, r.week)); if (res.status === "CONFLICT") conflict++; else if (res.status === "SUPPORTED_GAME" && res.team === normalizeTeamCode(r.team)) exact++; else mismatch++; }
    assert.equal(mismatch, 0); assert.equal(conflict, 0); assert.equal(exact, ALL_ROWS.length);
  });
  it("LEAVE-ONE-OUT over all ~900 real rows: never a wrong team (correct, ambiguous, gap-too-long or one-sided only); reports the mix", () => {
    const tally = { correct: 0, ambiguous: 0, tooLong: 0, oneSided: 0, wrong: 0 };
    for (const r of ALL_ROWS) { const rest = OBS.filter((o) => !(o.gsis_id === r.gsis_id && o.season === r.season && o.week === r.week)); const res = resolvePlayerTeamAt(r.gsis_id, rest, G(r.season, r.week));
      if (res.status === "SUPPORTED_BRACKETED") { if (res.team === normalizeTeamCode(r.team)) tally.correct++; else tally.wrong++; } else if (res.status === "AMBIGUOUS_TRANSITION") tally.ambiguous++; else if (res.status === "BRACKET_GAP_TOO_LONG") tally.tooLong++; else if (res.status === "NO_EVIDENCE") tally.oneSided++; else tally.wrong++; }
    assert.equal(tally.wrong, 0, j(tally)); assert.ok(tally.correct > 300 && tally.ambiguous > 5, j(tally));
  });
  it("chronology-safe opponents: every real game row's recorded opponent equals the opponent derived from (effective team, schedule) — no row disagrees", () => {
    const sched = scheduleFromObservations(OBS); let ok = 0, bad = 0; for (const r of ALL_ROWS) { const o = resolveOpponentAt(r.gsis_id, idx, sched, G(r.season, r.week)); if (o.status === "RESOLVED" && o.opponent === normalizeTeamCode(r.opponent_team)) ok++; else bad++; }
    assert.equal(bad, 0); assert.equal(ok, ALL_ROWS.length);
  });
  it("mid-season movers: the derived opponent flips with the team at the transaction game and never uses the other club (30 real MID player-seasons)", () => {
    const sched = scheduleFromObservations(OBS); let flips = 0;
    for (const { g, s } of playerSeasons.filter((p) => R2.some((r) => r.group === "MID" && r.gsis_id === p.g && r.season === p.s))) { const rows = R2.filter((r) => r.gsis_id === g && r.season === s).sort((a, b) => a.week - b.week); for (let i = 1; i < rows.length; i++) if (normalizeTeamCode(rows[i]!.team) !== normalizeTeamCode(rows[i - 1]!.team)) { const before = resolveOpponentAt(g, idx, sched, G(s, rows[i - 1]!.week)), after = resolveOpponentAt(g, idx, sched, G(s, rows[i]!.week)); assert.equal(before.team, normalizeTeamCode(rows[i - 1]!.team)); assert.equal(after.team, normalizeTeamCode(rows[i]!.team)); assert.equal(after.opponent, normalizeTeamCode(rows[i]!.opponent_team)); flips++; } }
    assert.ok(flips >= 30, `flips ${flips}`);
  });
});

describe("conflicts: deterministic, visible, raw sources retained; normalization-only differences are not conflicts", () => {
  const g = "00-0033280"; const base = OBS.filter((o) => o.gsis_id === g);
  const rival = observation({ gsis_id: g, season: 2022, week: 7, raw_team: "CAR", source: "ROLE_PARTICIPATION", granularity: "GAME_OBSERVED", source_record_id: "role:rival" });
  it("two sources disagree: CONFLICT, no team returned, both raw records retained, policy pick visible, failure code SOURCE_CONFLICT; stable under input order", () => {
    const a = resolvePlayerTeamAt(g, [...base, rival], G(2022, 7)); const b = resolvePlayerTeamAt(g, [rival, ...[...base].reverse()], G(2022, 7)); assert.equal(j(a), j(b));
    assert.equal(a.status, "CONFLICT"); assert.equal(a.team, null); assert.equal(a.failure_code, "SOURCE_CONFLICT"); assert.deepEqual(a.candidates.map((c) => c.team).sort(), ["CAR", "SF"]); assert.equal(a.selected_by_policy, "CAR"); assert.ok(a.evidence_ids.includes("role:rival"));
    assert.deepEqual([...new Set([...base, rival].filter((o) => o.week === 7 && o.season === 2022).map((o) => o.raw_team))].sort(), ["CAR", "SF"]);
  });
  it("normalization-only difference (raw 'LA' from one source, 'LAR' from another) is ONE supported fact, not a conflict; raw codes are preserved on the observations", () => {
    const a = observation({ gsis_id: "x", season: 2024, week: 4, raw_team: "LA", source: "GAME_LOG", granularity: "GAME_OBSERVED", source_record_id: "a" }), b = observation({ gsis_id: "x", season: 2024, week: 4, raw_team: "LAR", source: "ROLE_PARTICIPATION", granularity: "GAME_OBSERVED", source_record_id: "b" });
    const r = resolvePlayerTeamAt("x", [a, b], G(2024, 4)); assert.equal(r.status, "SUPPORTED_GAME"); assert.equal(r.team, "LAR"); assert.deepEqual([a.raw_team, b.raw_team], ["LA", "LAR"]);
  });
  it("a conflict block is UNAVAILABLE with SOURCE_CONFLICT and lists the candidates — no consumer receives a team as if undisputed", () => {
    const bs = teamMembershipEvidence(resolvePlayerTeamAt(g, [...base, rival], G(2022, 7))); for (const x of bs) assert.deepEqual(validateEvidenceBlock(x), []); const t = bs.find((x) => x.metric === "membership.team")!; assert.equal(t.availability.state, "UNAVAILABLE"); assert.match(t.availability.reason!, /SOURCE_CONFLICT/); assert.match(t.limitations.join(" "), /CAR .*SF|SF .*CAR/);
  });
});

describe("identity: stable across team changes; never guessed on collisions", () => {
  const src = (rows: Parameters<CrosswalkSource["load"]> extends [] ? Awaited<ReturnType<CrosswalkSource["load"]>> : never): CrosswalkSource => ({ name: "t", load: async () => rows });
  it("same GSIS person across offseason change, midseason trade, release (no team), signing and a historical snapshot: ONE canonical id; only the observed team varies", async () => {
    const cw = await PlayerCrosswalk.create(src([{ gsis_id: "00-0035676", sleeper_id: "5859", full_name: "A.J. Brown", position: "WR", nfl_team: "PHI" }]));
    const ids = new Set(["PHI", "PHI", "NE", null, "NE", "LAR"].map((t) => cw.resolve({ provider: "sleeper", provider_player_id: "5859", full_name: "A.J. Brown", position: "WR", nfl_team: t }).player.canonical_player_id)); assert.equal(ids.size, 1); assert.equal([...ids][0], "player:gsis:00-0035676");
  });
  it("IDENTITY COLLISION: two 'Mike Williams' WRs (NYJ / PIT) with no strong ids — a team-qualified name resolves ONLY to the matching one; without a matching team it is UNRESOLVED, never guessed", async () => {
    const cw = await PlayerCrosswalk.create(src([{ gsis_id: "00-A", full_name: "Mike Williams", position: "WR", nfl_team: "NYJ" }, { gsis_id: "00-B", full_name: "Mike Williams", position: "WR", nfl_team: "PIT" }]));
    const at = (team: string | null) => cw.resolve({ provider: "sleeper", provider_player_id: null, full_name: "Mike Williams", position: "WR", nfl_team: team });
    assert.equal(at("NYJ").player.identifiers.gsis_id, "00-A"); assert.equal(at("PIT").player.identifiers.gsis_id, "00-B");
    for (const t of [null, "SEA"]) { const r = at(t); assert.equal(r.player.resolution.method, "unresolved", String(t)); assert.ok(r.unresolved); assert.equal(r.player.identifiers.gsis_id, undefined); }
  });
  it("similar names never merge histories: weak name alias alone is reported as possible-same-person, never a link; strong ids decide", () => {
    assert.equal(relateIdentities({ full_name: "Mike Williams", position: "WR" }, { full_name: "Mike Williams", position: "WR" }), "POSSIBLE_SAME_PERSON_WEAK_ONLY"); assert.equal(relateIdentities({ gsis_id: "00-A", full_name: "Mike Williams", position: "WR" }, { gsis_id: "00-B", full_name: "Mike Williams", position: "WR" }), "POSSIBLE_SAME_PERSON_WEAK_ONLY", "different strong ids + same name is still NOT a same-person link");
    assert.deepEqual(identityAliases({ gsis_id: "00-A" }).weak, []);
  });
});

describe("determinism, as-of reconstruction, versioning, index", () => {
  it("byte-equivalent output: repeated, shuffled, and via the index; a historical result is independent of live provider state (adding/removing PROVIDER_CURRENT changes nothing)", () => {
    const shuffled = [...OBS].sort(() => 0.5 - Math.sin(OBS.length)).reverse(); const idx = new TeamMembershipIndex(OBS); const live = [...OBS, providerCurrent("00-0033280", 2026, "SF", "v"), crosswalkSnapshot("00-0033280", 2026, "SF", "s")];
    for (const [g, s, w] of [["00-0033280", 2022, 7], ["00-0030496", 2020, 6], ["00-0027685", 2019, 8], ["00-0035676", 2025, 9]] as const) { const a = j(resolvePlayerTeamAt(g, OBS, G(s, w))); assert.equal(j(resolvePlayerTeamAt(g, OBS, G(s, w))), a); assert.equal(j(resolvePlayerTeamAt(g, shuffled, G(s, w))), a); assert.equal(j(idx.resolve(g, G(s, w))), a); assert.equal(j(resolvePlayerTeamAt(g, live, G(s, w))), a, "historical result must not depend on current provider state"); }
  });
  it("temporal_data_version: order/raw-spelling/vintage independent; changes when a membership fact changes; distinct format from player_data_version and the scoring fingerprint", () => {
    const v = temporalDataVersion(OBS); assert.equal(temporalDataVersion([...OBS].reverse()), v);
    const respelled = OBS.map((o) => (o.raw_team === "LA" ? { ...o, raw_team: "LAR", source_vintage: "renamed" } : { ...o, source_vintage: "renamed" })); assert.equal(temporalDataVersion(respelled), v, "raw spelling of a code and vintage labels are irrelevant metadata");
    assert.notEqual(temporalDataVersion(OBS.slice(1)), v); assert.notEqual(temporalDataVersion(OBS.map((o, i) => (i === 0 ? { ...o, team: "ZZZ" } : o))), v);
    assert.match(v, /^tm:v1:[0-9a-f]{16}$/); assert.match(playerDataVersion([]), /^players:v1:/); assert.match(scoringFingerprint({ rec: 1 }), /^scoring:v1:/);
  });
  it("index memo is keyed by evidence version + FULL effective time: one player, different weeks => different answers (no 'current player' caching)", () => {
    const idx = new TeamMembershipIndex(OBS); const a = idx.resolve("00-0033280", G(2022, 6)), b = idx.resolve("00-0033280", G(2022, 7)); assert.equal(a.team, "CAR"); assert.equal(b.team, "SF"); assert.equal(idx.resolve("00-0033280", G(2022, 6)), a, "memo hit returns the identical object");
    assert.notEqual(new TeamMembershipIndex(OBS.slice(2)).version, idx.version); assert.equal(resolvePlayerTeamAt("00-0033280", idx, G(2022, 7)).team, "SF");
  });
  it("failure codes follow the unresolved status; resolved statuses carry none", () => {
    assert.equal(failureCodeFor("NO_EVIDENCE"), "MEMBERSHIP_UNKNOWN"); assert.equal(failureCodeFor("CONFLICT"), "SOURCE_CONFLICT"); for (const s of ["AMBIGUOUS_TRANSITION", "BRACKET_GAP_TOO_LONG", "CURRENT_ONLY_OUT_OF_SCOPE"] as const) assert.equal(failureCodeFor(s), "GRANULARITY_INSUFFICIENT"); assert.equal(failureCodeFor("SUPPORTED_GAME"), null);
    assert.equal(resolvePlayerTeamAt("00-0030496", OBS, G(2020, 6)).failure_code, "GRANULARITY_INSUFFICIENT"); assert.equal(resolvePlayerTeamAt("nobody", OBS, G(2020, 6)).failure_code, "MEMBERSHIP_UNKNOWN");
  });
  it("an unavailable temporal SOURCE is reported as TEMPORAL_SOURCE_UNAVAILABLE (absence of a source is not absence of evidence)", () => {
    const r = resolvePlayerTeamAt("nobody", [], G(2024, 3)); const bs = teamMembershipEvidence(r, { sources: [{ source: "game_logs", state: "NOT_CONFIGURED", detail: "Supabase is not configured" }, { source: "role_participation", state: "OK" }] }); for (const x of bs) assert.deepEqual(validateEvidenceBlock(x), []);
    const t = bs.find((x) => x.metric === "membership.team")!; assert.match(t.availability.reason!, /TEMPORAL_SOURCE_UNAVAILABLE/); assert.match(t.limitations.join(" "), /absence of evidence|different from evidence of absence/); assert.equal(t.lineage.canonical && (t.lineage.canonical as Record<string, unknown>).temporal_data_version, r.evidence_version);
  });
});

describe("historical evidence context (Role / FI / Player-Scheme join) — chronology-safe, no numeric adjustment", () => {
  const idx = new TeamMembershipIndex(OBS); const sched = scheduleFromObservations(OBS);
  it("traded player: the FI join keys (offense team, actual opponent's defense) follow the effective team at that game; Role team is that club; scheme window flagged when the club differs", () => {
    const wk7 = historicalEvidenceContext({ gsis_id: "00-0033280", season: 2022, week: 7, observations: idx, schedule: sched, scheme_as_of_team: "CAR" }); assert.equal(wk7.status, "READY"); assert.deepEqual(wk7.fi_join, { offense_team: "SF", defense_team: "KC", season: 2022, week: 7 }); assert.equal(wk7.role_team, "SF"); assert.equal(wk7.scheme_window_vintage, "TEAM_CHANGED_SINCE_SCHEME_VINTAGE");
    const wk6 = historicalEvidenceContext({ gsis_id: "00-0033280", season: 2022, week: 6, observations: idx, schedule: sched, scheme_as_of_team: "CAR" }); assert.equal(wk6.fi_join!.offense_team, "CAR"); assert.equal(wk6.scheme_window_vintage, "SAME_TEAM_AS_SCHEME_VINTAGE");
  });
  it("unlocated transition: UNAVAILABLE with GRANULARITY_INSUFFICIENT and no join keys (evidence limited, not guessed)", () => { const c = historicalEvidenceContext({ gsis_id: "00-0030496", season: 2020, week: 6, observations: idx, schedule: sched }); assert.equal(c.status, "UNAVAILABLE"); assert.equal(c.fi_join, null); assert.equal(c.failure_code, "GRANULARITY_INSUFFICIENT"); assert.equal(c.role_team, null); });
  it("REAL Role + FI files agree with temporal resolution wherever it has an answer (0 contradictions): Role profile 2026 wk1 and FI usage 2026", () => {
    const rolePart = new TeamMembershipIndex(fromRoleParticipationCsv(readFileSync("lib/player-role-intelligence/data/player_game_role.csv", "utf8")));
    const rows = (f: string) => { const L = readFileSync(f, "utf8").split("\n"); const h = L[0]!.split(",").map((x) => x.replace(/"/g, "")); return L.slice(1).filter(Boolean).map((l) => { const c: string[] = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { c.push(cur); cur = ""; } else cur += ch; } c.push(cur); return Object.fromEntries(h.map((k, i) => [k, c[i] ?? ""])); }); };
    for (const [file, wk] of [["lib/player-role-intelligence/data/player_role_profile.csv", "through_week"], ["lib/football-intel/data/player_usage_profile.csv", null]] as const) { let agree = 0, dis = 0; for (const r of rows(file)) { const res = rolePart.resolve(r.gsis_id!, G(Number(r.season), wk ? Number(r[wk]) : 1)); if (!res.team) continue; if (res.team === normalizeTeamCode(r.team)) agree++; else dis++; } assert.equal(dis, 0, file); assert.ok(agree >= 400, `${file} agree ${agree}`); }
  });
  it("LIVE example: current 2026 club differs from 2025 club for real movers; identity constant; each season resolves to its own club and opponent", () => {
    const role = fromRoleParticipationCsv(readFileSync("lib/player-role-intelligence/data/player_game_role.csv", "utf8")); const both = new TeamMembershipIndex([...OBS, ...role]); const s2 = scheduleFromObservations([...OBS, ...role]); let shown = 0;
    for (const g of ["00-0035676", "00-0035719", "00-0036613", "00-0036945"]) { const wk1 = both.resolve(g, G(2026, 1)); if (!wk1.team) continue; const y25 = both.resolve(g, G(2025, 1)); assert.notEqual(y25.team, wk1.team, g); assert.equal(both.resolve(g, G(2025, 9)).team === y25.team || both.resolve(g, G(2025, 9)).status.startsWith("SUPPORTED"), true);
      const o25 = resolveOpponentAt(g, both, s2, G(2025, 1)), o26 = resolveOpponentAt(g, both, s2, G(2026, 1)); assert.equal(o25.status, "RESOLVED"); assert.equal(o26.status, "RESOLVED"); assert.notEqual(o25.team, o26.team); shown++; }
    assert.ok(shown >= 3, `shown ${shown}`);
  });
});

describe("boundaries: weekly context, imports, depth chart, versions, Phase 5/6 isolation", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
  it("NON_CURRENT_WEEK_UNSUPPORTED is untouched: the historical weekly-context guard still refuses non-current weeks and does not import the temporal layer", () => {
    const s = readFileSync("lib/weekly/context.ts", "utf8"); assert.match(s, /NON_CURRENT_WEEK_UNSUPPORTED/); assert.doesNotMatch(s, /temporal-identity/);
  });
  it("import boundary: current-time decision engines never import the temporal layer; only Book-Ready (topic + family), the persistence adapter and the layer itself do", () => {
    const importers = walk("lib").concat(walk("app")).filter((f) => !f.startsWith("lib/temporal-identity/") && /from\s+["']@\/lib\/temporal-identity|import\(\s*["']@\/lib\/temporal-identity/.test(readFileSync(f, "utf8"))).sort();
    assert.deepEqual(importers, ["lib/book-ready/families/team-membership.ts", "lib/book-ready/query.ts", "lib/persistence/supabase/team-membership-source.ts"]);
    for (const dir of ["lib/weekly", "lib/waiver2", "lib/trades", "lib/orchestrator", "lib/canonical", "lib/matchup2", "lib/scoring"]) for (const f of walk(dir)) assert.doesNotMatch(readFileSync(f, "utf8"), /from\s+["']@\/lib\/temporal-identity/, f);
  });
  it("depth-chart history is explicitly UNSUPPORTED and nothing in the layer infers slots from membership", () => {
    assert.equal(DEPTH_CHART_HISTORY.status, "UNSUPPORTED"); for (const f of walk("lib/temporal-identity")) assert.doesNotMatch(readFileSync(f, "utf8").replace(/DEPTH_CHART_HISTORY[\s\S]*?\};/, "").replace(/\/\*[\s\S]*?\*\//g, ""), /\b(WR1|WR2|RB1|RB2|QB1|starter_slot|depth_order)\b/);
  });
  it("Phase 5/6 isolation: the layer never touches capture stores, scoring, or fingerprints (no import of matchup2 capture/scoring code)", () => {
    for (const f of walk("lib/temporal-identity")) { const s = readFileSync(f, "utf8"); assert.doesNotMatch(s, /matchup2-capture|persistMatchup2Capture|calculateFantasyPoints|scoring-fingerprint/, f); }
    assert.equal(DEFAULT_MAX_BRACKET_GAP_WEEKS, 3);
  });
});
