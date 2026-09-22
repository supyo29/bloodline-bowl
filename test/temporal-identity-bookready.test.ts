/** Phase 7 — Book-Ready evidence for player team membership, the Matchup 2.0 historical-week guard, and the Player-Scheme vintage flag. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { teamMembershipEvidence } from "@/lib/book-ready/families/team-membership";
import { validateEvidenceBlock } from "@/lib/book-ready/validate";
import { TOPICS, getEvidence } from "@/lib/book-ready/query";
import { observation, resolvePlayerTeamAt, resolveOpponentAt, scheduleFromObservations, type TeamObservation, type TemporalQuery } from "@/lib/temporal-identity/membership";
import { fromGameLogRows, providerCurrent, crosswalkSnapshot, schemeVintageFlag, fromRoleParticipationCsv, type GameLogRow } from "@/lib/temporal-identity/sources";
import { getNflState } from "@/lib/sleeper/client";
import { CHAPTER_LIBRARY } from "@/lib/analysis-book/library";

const fx = JSON.parse(readFileSync("test/fixtures/temporal-real-movers.json", "utf8")) as { rows: GameLogRow[] }; const OBS = fromGameLogRows(fx.rows);
const G = (season: number, week: number): TemporalQuery => ({ kind: "GAME", season, week }); const CMC = "00-0033280", BELL = "00-0030496";
const metric = (bs: ReturnType<typeof teamMembershipEvidence>, m: string) => bs.find((b) => b.metric === m);
const allValid = (bs: ReturnType<typeof teamMembershipEvidence>) => { for (const b of bs) assert.deepEqual(validateEvidenceBlock(b), [], b.metric); };

test("resolved game membership: valid block with team, granularity, evidence class, policy and lineage; opponent from the EFFECTIVE team", () => {
  const r = resolvePlayerTeamAt(CMC, OBS, G(2022, 7)); const o = resolveOpponentAt(CMC, OBS, scheduleFromObservations(OBS), G(2022, 7)); const bs = teamMembershipEvidence(r, { opponent: o }); allValid(bs);
  const t = metric(bs, "membership.team")!; assert.equal(t.value, "SF"); assert.equal(t.availability.state, "AVAILABLE"); assert.equal(t.components!.find((c) => c.key === "granularity")!.value, "GAME_OBSERVED"); assert.match(String(t.lineage.content_identity), /^tm:[0-9a-f]{16}$/);
  assert.equal(metric(bs, "membership.opponent")!.value, "KC"); assert.equal(t.deployment.may_influence_production, false);
});
test("ambiguous transition: the team block is UNAVAILABLE with reasons and both candidates in order; a candidates block exposes them", () => {
  const bs = teamMembershipEvidence(resolvePlayerTeamAt(BELL, OBS, G(2020, 6))); allValid(bs); const t = metric(bs, "membership.team")!;
  assert.equal(t.availability.state, "UNAVAILABLE"); assert.equal(t.value, undefined); assert.match(t.availability.reason!, /AMBIGUOUS_TRANSITION/); assert.match(t.limitations.join(" "), /NYJ.*KC/); assert.equal(metric(bs, "membership.candidates")!.value, 2);
});
test("bracket gap too long: unavailable, states the limit; conflict: unavailable, both candidates and the policy name (for lineage only)", () => {
  const long = teamMembershipEvidence(resolvePlayerTeamAt("00-0035140", OBS, G(2023, 14))); allValid(long); assert.match(metric(long, "membership.team")!.availability.reason!, /BRACKET_GAP_TOO_LONG/);
  const extra = observation({ gsis_id: CMC, season: 2022, week: 7, raw_team: "CAR", source: "ROLE_PARTICIPATION", granularity: "GAME_OBSERVED", source_record_id: "role:x" });
  const c = teamMembershipEvidence(resolvePlayerTeamAt(CMC, [...OBS, extra], G(2022, 7))); allValid(c); assert.match(metric(c, "membership.team")!.limitations.join(" "), /policy names CAR for lineage only/); assert.equal(metric(c, "membership.candidates")!.value, 2);
});
test("current-only evidence for a PAST time yields an unavailable block — today's team is not offered", () => {
  const r = resolvePlayerTeamAt("p", [providerCurrent("p", 2026, "LAR", "v"), crosswalkSnapshot("p", 2026, "LA", "s")], G(2025, 7)); const bs = teamMembershipEvidence(r); allValid(bs);
  assert.equal(metric(bs, "membership.team")!.availability.state, "UNAVAILABLE"); assert.match(metric(bs, "membership.team")!.availability.reason!, /CURRENT_ONLY_OUT_OF_SCOPE/);
});
test("current membership: provider observation is AVAILABLE; the stale snapshot alone is labelled SNAPSHOT_STALE_RISK on the block", () => {
  const C: TemporalQuery = { kind: "CURRENT", season: 2026, week: 2 };
  const a = teamMembershipEvidence(resolvePlayerTeamAt("p", [providerCurrent("p", 2026, "LAR", "v")], C)); allValid(a); assert.equal(metric(a, "membership.team")!.value, "LAR");
  const b = teamMembershipEvidence(resolvePlayerTeamAt("p", [crosswalkSnapshot("p", 2026, "LA", "s")], C)); allValid(b); assert.equal(metric(b, "membership.team")!.components!.find((c) => c.key === "evidence_class")!.value, "SNAPSHOT_STALE_RISK"); assert.match(metric(b, "membership.team")!.limitations.join(" "), /may be stale/);
});
test("Player-Scheme vintage flag: the current_team window is the AS-OF team; a mover is flagged, an unchanged player is not", () => {
  assert.equal(schemeVintageFlag("PHI", "NE"), "TEAM_CHANGED_SINCE_SCHEME_VINTAGE"); assert.equal(schemeVintageFlag("SFO", "SF"), "SAME_TEAM_AS_SCHEME_VINTAGE", "directory vocabulary normalized");
  assert.equal(schemeVintageFlag("FA", "BAL"), "SCHEME_TEAM_UNKNOWN_AT_VINTAGE"); assert.equal(schemeVintageFlag("PHI", null), "CURRENT_TEAM_UNKNOWN");
  const bs = teamMembershipEvidence(resolvePlayerTeamAt("p", [providerCurrent("p", 2026, "NE", "v")], { kind: "CURRENT", season: 2026, week: 2 }), { scheme_as_of_team: "PHI" }); allValid(bs);
  assert.equal(metric(bs, "membership.scheme_window_vintage")!.value, "TEAM_CHANGED_SINCE_SCHEME_VINTAGE"); assert.match(metric(bs, "membership.scheme_window_vintage")!.limitations.join(" "), /AS-OF team/);
});
test("topic is registered on the one query layer with its surface", () => { assert.equal(TOPICS["player.team_membership"]!.surface, "temporal-team-membership"); assert.deepEqual(TOPICS["player.team_membership"]!.required, ["gsis_id"]); });

test("MATCHUP 2.0 HISTORICAL GUARD (live): a past week requires game-level team evidence; without it the block is UNAVAILABLE and the directory team is NOT substituted; with it the effective team/opponent are used", async (t) => {
  const st = await getNflState().catch(() => null); const now = Number(st?.week ?? 1); if (now <= 1) { t.skip("no historical week exists yet"); return; }
  const role = fromRoleParticipationCsv(readFileSync("lib/player-role-intelligence/data/player_game_role.csv", "utf8")); const withWk1 = new Map<string, TeamObservation>(); for (const o of role) if (o.week === 1) withWk1.set(o.gsis_id, o);
  const dir = readFileSync("lib/player-scheme-intelligence/data/player_directory.csv", "utf8").split("\n").slice(1).map((l) => l.split(",")[0]!.replace(/"/g, "")).filter(Boolean);
  const has = dir.find((g) => withWk1.has(g) && withWk1.get(g)!.opponent); const without = dir.find((g) => !withWk1.has(g));
  assert.ok(has && without);
  const no = await getEvidence({ topic: "matchup2.player.summary", params: { gsis_id: without!, week: 1, opponent: "DAL" } }); assert.equal(no.blocks[0]!.availability.state, "UNAVAILABLE"); assert.match(no.blocks[0]!.availability.reason!, /not established by game-level evidence/); assert.ok(no.validation.ok);
  const yes = await getEvidence({ topic: "matchup2.player.summary", params: { gsis_id: has!, week: 1 } }); assert.ok(yes.blocks.some((b) => b.availability.state === "AVAILABLE"), "resolved historical week evaluates"); assert.ok(yes.validation.ok);
  const bad = await getEvidence({ topic: "matchup2.player.summary", params: { gsis_id: has!, week: 1, opponent: withWk1.get(has!)!.opponent === "DAL" ? "KC" : "DAL" } }); assert.match(bad.blocks[0]!.availability.reason!, /conflicts with the schedule opponent/);
});

test("Analysis Book (audited): NO chapter is limited by team identity, so no chapter state changes; the temporal topic is registered but required by no chapter", () => {
  const needs = Object.values(CHAPTER_LIBRARY).filter((c) => c.needs.some((n) => n.topic === "player.team_membership")); assert.equal(needs.length, 0); assert.equal(Object.keys(CHAPTER_LIBRARY).length, 106); // reflects Phase 10's lifecycle additions; Phase 7 itself added none
});
test("Role participation is parsed once per file identity (mtime-keyed): repeated loads return the identical array", async () => { const { loadRoleParticipation } = await import("@/lib/temporal-identity/sources"); assert.equal(loadRoleParticipation(), loadRoleParticipation()); });
