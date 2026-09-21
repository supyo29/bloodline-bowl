/**
 * Phase 7 production certification — test-only regression grid (no production code change).
 * Pins the operational claims of Steps 13-15/29 in one place: exact bracket-gap boundary, the hidden-middle-team (A->B->A) refusal,
 * strict as-of future-mutation invariance on a synthetic case, and current-only evidence never answering a past time.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { observation, resolvePlayerTeamAt, DEFAULT_MAX_BRACKET_GAP_WEEKS, temporalDataVersion, type TeamObservation, type TemporalQuery } from "@/lib/temporal-identity/membership";

const P = "00-0000001";
const game = (season: number, week: number, raw: string, src: "GAME_LOG" | "ROLE_PARTICIPATION" = "GAME_LOG"): TeamObservation =>
  observation({ gsis_id: P, season, week, raw_team: raw, opponent: "XXX", source: src, granularity: "GAME_OBSERVED", source_record_id: `${src}:${season}:${week}:${raw}` });
const G = (season: number, week: number): TemporalQuery => ({ kind: "GAME", season, week });

describe("bracket gap boundary (default cap = 3 missing weeks)", () => {
  it("the cap is exactly 3", () => assert.equal(DEFAULT_MAX_BRACKET_GAP_WEEKS, 3));
  for (const gap of [1, 2, 3]) {
    it(`same team both sides, ${gap}-week gap: bracketed, gap exposed, labelled INFERRED`, () => {
      const obs = [game(2024, 2, "KC"), game(2024, 2 + gap + 1, "KC")];
      const r = resolvePlayerTeamAt(P, obs, G(2024, 3));
      assert.equal(r.status, "SUPPORTED_BRACKETED"); assert.equal(r.team, "KC"); assert.equal(r.gap_weeks, gap); assert.equal(r.evidence_class, "INFERRED_BETWEEN_OBSERVATIONS");
    });
  }
  for (const gap of [4, 5, 6]) {
    it(`same team both sides, ${gap}-week gap: BRACKET_GAP_TOO_LONG, no team`, () => {
      const obs = [game(2024, 2, "KC"), game(2024, 2 + gap + 1, "KC")];
      const r = resolvePlayerTeamAt(P, obs, G(2024, 3));
      assert.equal(r.status, "BRACKET_GAP_TOO_LONG"); assert.equal(r.team, null); assert.equal(r.failure_code, "BRACKET_GAP_TOO_LONG");
    });
  }
  it("A->B->A: the sparse A..A bracket over a hidden B is refused; once the middle game is observed it is answered exactly", () => {
    const sparse = [game(2020, 6, "DEN"), game(2020, 12, "DEN")];
    assert.equal(resolvePlayerTeamAt(P, sparse, G(2020, 9)).team, null, "must not bridge over the hidden intermediate team");
    assert.equal(resolvePlayerTeamAt(P, sparse, G(2020, 9)).status, "BRACKET_GAP_TOO_LONG");
    const full = [...sparse, game(2020, 9, "ARI")];
    const r = resolvePlayerTeamAt(P, full, G(2020, 9)); assert.equal(r.status, "SUPPORTED_GAME"); assert.equal(r.team, "ARI");
  });
});

describe("strict as-of: future evidence cannot change a past answer", () => {
  const base = [game(2023, 1, "DAL"), game(2023, 2, "DAL"), game(2023, 3, "DAL"), game(2023, 4, "DAL")];
  const future = [game(2023, 9, "NYG"), game(2024, 1, "MIA"), observation({ gsis_id: P, season: 2026, week: null, raw_team: "SF", source: "PROVIDER_CURRENT", granularity: "CURRENT_ONLY", source_record_id: "provider:now" }),
    observation({ gsis_id: P, season: 2026, week: null, raw_team: "LA", source: "CROSSWALK_LATEST_TEAM", granularity: "CURRENT_ONLY", source_record_id: "xwalk:latest" })];
  it("every cutoff/query at or before T returns a byte-identical resolution with and without later evidence", () => {
    const T = { season: 2023, week: 4 };
    for (let w = 1; w <= 4; w++) {
      const a = resolvePlayerTeamAt(P, base, G(2023, w), { knownThrough: T }); const b = resolvePlayerTeamAt(P, [...future, ...base], G(2023, w), { knownThrough: T });
      assert.equal(JSON.stringify(a), JSON.stringify(b), `week ${w}`);
    }
  });
  it("mutating an earlier-than-T-irrelevant later row changes nothing before T; changing a row at or before T does change the version", () => {
    const v0 = temporalDataVersion(base); const v1 = temporalDataVersion([...base, game(2023, 9, "NYG")]); const v2 = temporalDataVersion([game(2023, 1, "PHI"), ...base.slice(1)]);
    assert.notEqual(v0, v1, "new evidence is a different dataset version"); assert.notEqual(v0, v2); assert.equal(v0, temporalDataVersion([...base].reverse()), "order-independent");
  });
  it("the present-day team (provider now SF / crosswalk LA) never answers a past week", () => {
    const only = future.filter((o) => o.granularity === "CURRENT_ONLY");
    for (const w of [1, 9, 17]) { const r = resolvePlayerTeamAt(P, only, G(2023, w)); assert.equal(r.team, null); assert.equal(r.failure_code, "CURRENT_ONLY_FOR_HISTORICAL_QUERY"); assert.deepEqual(JSON.stringify(r).includes('"SF"') || JSON.stringify(r).includes('"LAR"'), false, "today's team is not even echoed"); }
  });
});
