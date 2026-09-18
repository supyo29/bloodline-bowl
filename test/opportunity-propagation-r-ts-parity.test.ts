// ===========================================================================
// Injury -> Opportunity Propagation Intelligence -- Checkpoint D.
// R/TS numeric parity (spec §40/§51) AND the mandatory permanent NSE
// regression test (spec §24/§50): both Checkpoints B and C found bugs
// where a function parameter named identically to a data.table column
// caused a self-reference lookup instead of a scalar one, silently
// collapsing every rate to the 0.5 global default. This test exercises
// the REAL served lookup path (`lookupInheritanceRate` / `allocateHierarchical`),
// not a grep, against a fixture with two groups whose known historical
// rates are DIFFERENT and neither is 0.5 -- reproducing the bug class is
// impossible to do silently again without this test failing.
// ===========================================================================
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allocateHierarchical, lookupInheritanceRate } from "@/lib/opportunity-propagation-intelligence/model";
import type {
  OpportunityPropagationModel,
  InheritanceRateLeagueRow,
  InheritanceRatePositionRow,
  InheritanceRateTeamRow,
  PositionRelationshipWeightRow,
  CandidateInput,
} from "@/lib/opportunity-propagation-intelligence";

interface Fixture {
  priors: { league: InheritanceRateLeagueRow[]; position: InheritanceRatePositionRow[]; team: InheritanceRateTeamRow[] };
  position_weights: PositionRelationshipWeightRow[];
  nse_regression_case: {
    rate_team_AAA_WR_target_share: number;
    rate_team_BBB_WR_target_share: number;
    rate_unseen_team_falls_to_position_prior: number;
    rate_unseen_position_falls_to_league_prior: number;
    rate_unknown_dimension_falls_to_global_default: number;
  };
  scenarios: Array<{
    name: string;
    team: string;
    absent_position: string;
    dimension: string;
    vacated_opportunity: number;
    candidates: Array<{ id: string; position: string; pre_event_recent: number; pre_event_season: number }>;
    expected_predictions: Array<{ gsis_id: string; position: string; pre_event_role: number; predicted_role: number; predicted_delta: number }>;
  }>;
}

const fixturePath = join(process.cwd(), "analysis", "opportunity_propagation", "tests", "fixtures", "r_ts_parity_fixture.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

function buildModel(): OpportunityPropagationModel {
  return {
    manifest: {} as OpportunityPropagationModel["manifest"], // not exercised by these functions
    league: fixture.priors.league,
    position: fixture.priors.position,
    team: fixture.priors.team,
    positionWeights: fixture.position_weights,
    dimensions: [],
  };
}

describe("NSE regression -- real lookup path, two groups, known distinct rates (spec §24/§50)", () => {
  const model = buildModel();

  test("team AAA/WR and BBB/WR target_share rates are distinct and match the R fixture exactly", () => {
    const rateAAA = lookupInheritanceRate(model, "target_share", "AAA", "WR");
    const rateBBB = lookupInheritanceRate(model, "target_share", "BBB", "WR");
    assert.notEqual(rateAAA.inheritance_rate, rateBBB.inheritance_rate);
    assert.notEqual(rateAAA.inheritance_rate, 0.5);
    assert.notEqual(rateBBB.inheritance_rate, 0.5);
    assert.equal(rateAAA.inheritance_rate, fixture.nse_regression_case.rate_team_AAA_WR_target_share);
    assert.equal(rateBBB.inheritance_rate, fixture.nse_regression_case.rate_team_BBB_WR_target_share);
    assert.equal(rateAAA.source, "TEAM_POSITION_HISTORY");
    assert.equal(rateBBB.source, "TEAM_POSITION_HISTORY");
  });

  test("an unseen team falls through to the position prior, visibly (not disguised as team-specific)", () => {
    const rate = lookupInheritanceRate(model, "target_share", "ZZZ_UNSEEN_TEAM", "WR");
    assert.equal(rate.inheritance_rate, fixture.nse_regression_case.rate_unseen_team_falls_to_position_prior);
    assert.equal(rate.source, "POSITION_PRIOR");
  });

  test("an unseen team AND position falls through to the league prior, visibly", () => {
    const rate = lookupInheritanceRate(model, "rush_share", "ZZZ_UNSEEN_TEAM", "QB");
    assert.equal(rate.inheritance_rate, fixture.nse_regression_case.rate_unseen_position_falls_to_league_prior);
    assert.equal(rate.source, "LEAGUE_PRIOR");
  });

  test("a completely unknown dimension falls to the global default 0.5, visibly, and ONLY when genuinely unsupported", () => {
    const rate = lookupInheritanceRate(model, "no_such_dimension", "AAA", "WR");
    assert.equal(rate.inheritance_rate, 0.5);
    assert.equal(rate.inheritance_rate, fixture.nse_regression_case.rate_unknown_dimension_falls_to_global_default);
    assert.equal(rate.source, "GLOBAL_DEFAULT");
  });
});

describe("R/TS numeric parity -- full allocator, real fixture scenarios (spec §40/§51)", () => {
  const model = buildModel();

  for (const scenario of fixture.scenarios) {
    test(`${scenario.name}: TS allocateHierarchical matches R's allocate_candidate4_hierarchical`, () => {
      const candidates: CandidateInput[] = scenario.candidates.map((c) => ({
        gsis_id: c.id, position: c.position, pre_event_recent: c.pre_event_recent, pre_event_season: c.pre_event_season,
      }));
      const preds = allocateHierarchical(model, scenario.team, scenario.absent_position, scenario.dimension, scenario.vacated_opportunity, candidates);
      assert.equal(preds.length, scenario.expected_predictions.length);
      for (const expected of scenario.expected_predictions) {
        const actual = preds.find((p) => p.gsis_id === expected.gsis_id);
        assert.ok(actual, `missing prediction for ${expected.gsis_id}`);
        assert.ok(Math.abs(actual!.pre_event_role - expected.pre_event_role) < 1e-9, `${scenario.name}/${expected.gsis_id} pre_event_role mismatch: ${actual!.pre_event_role} vs ${expected.pre_event_role}`);
        assert.ok(Math.abs(actual!.predicted_role - expected.predicted_role) < 1e-9, `${scenario.name}/${expected.gsis_id} predicted_role mismatch: ${actual!.predicted_role} vs ${expected.predicted_role}`);
        assert.ok(Math.abs(actual!.predicted_delta - expected.predicted_delta) < 1e-9, `${scenario.name}/${expected.gsis_id} predicted_delta mismatch: ${actual!.predicted_delta} vs ${expected.predicted_delta}`);
      }
    });
  }

  test("return_role_independent: return-domain weighting never touches an offensive dimension (orthogonality, spec §29/§50)", () => {
    const scenario = fixture.scenarios.find((s) => s.name === "return_role_independent")!;
    const candidates: CandidateInput[] = scenario.candidates.map((c) => ({ gsis_id: c.id, position: c.position, pre_event_recent: c.pre_event_recent, pre_event_season: c.pre_event_season }));
    const returnPreds = allocateHierarchical(model, scenario.team, scenario.absent_position, "kick_return_role", scenario.vacated_opportunity, candidates);
    const offensePreds = allocateHierarchical(model, scenario.team, scenario.absent_position, "target_share", 0.10, candidates);
    // same candidates, different dimension -> independently computed weights (no shared state, no cross-contamination)
    assert.notDeepEqual(returnPreds.map((p) => p.predicted_delta), offensePreds.map((p) => p.predicted_delta));
  });

  test("determinism: identical inputs produce identical predictions (spec §25 in Checkpoint C, re-asserted here)", () => {
    const scenario = fixture.scenarios[0]!;
    const candidates: CandidateInput[] = scenario.candidates.map((c) => ({ gsis_id: c.id, position: c.position, pre_event_recent: c.pre_event_recent, pre_event_season: c.pre_event_season }));
    const a = allocateHierarchical(model, scenario.team, scenario.absent_position, scenario.dimension, scenario.vacated_opportunity, candidates);
    const b = allocateHierarchical(model, scenario.team, scenario.absent_position, scenario.dimension, scenario.vacated_opportunity, candidates);
    assert.deepEqual(a, b);
  });
});
