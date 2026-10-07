/**
 * W1.R1 G1/G2/G3: the final-pregame record is calibration-grade (immutable, complete, reproducible), cannot be rewritten by hindsight, and the
 * calibration ledger can score the FINAL CANONICAL forecast users actually received — per league, provider-neutral.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scoringFingerprint } from "../lib/canonical/scoring-fingerprint";
import { SupabaseFinalPregameStore } from "../lib/persistence/supabase/projection-observations";
import { buildCanonicalForecastBatch } from "../lib/weekly/forecast";
import { buildFinalPregameRecord, MemoryFinalPregameStore, selectFinalRevision, type FinalPregameRecord } from "../lib/weekly/freshness/final-pregame";
import { buildWeekCases, type BuildWeekInput, type LeagueScoringInput } from "../lib/calibration/case-builder";
import { selectPregameEvidence } from "../lib/calibration/evidence-selection";
import { caseErrors } from "../lib/calibration/metrics";
import { candidateFromFinalPregame, identityFromFinalPregame } from "../lib/calibration/final-pregame-evidence";
import { candidateFromSnapshotRow } from "../lib/calibration/materialize";
import type { NflGame, ProjectionCandidate } from "../lib/calibration/types";
import type { CanonicalPlayer } from "../lib/canonical/schema";
import type { ForecastShadowSignals } from "../lib/weekly/forecast";
import type { WeeklyProjection, WeeklyProjectionBatch } from "../lib/weekly/schema";
import { FakeRest } from "./fixtures/fake-rest";
import { player, proj } from "./fixtures/weekly";

const MIN = 60_000;
const KICK = Date.parse("2026-10-11T17:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const PPR = { rec: 1, rec_yd: 0.1, rec_td: 6 };
const STD = { rec: 0, rec_yd: 0.1, rec_td: 6 };

interface Spec { id: string; pos?: "WR" | "K" | "DEF" | "RB"; pts: number | null; injury?: string | null; team?: string; ids?: Record<string, string>; extraWarnings?: string[]; shadow?: ForecastShadowSignals }
function forecastFor(spec: Spec, o: { observedMin?: number; composedMin?: number; league?: string; shadow?: ForecastShadowSignals; obsId?: string } = {}) {
  const row: WeeklyProjection = proj(spec.id, spec.pos ?? "WR", spec.pts, { injury_status: spec.injury ?? null, expected_availability: spec.injury ? 0.78 : 1, warnings: spec.extraWarnings ?? [] });
  const live: CanonicalPlayer = { ...player(spec.id, spec.pos ?? "WR", { team: spec.team ?? "KC", injury: spec.injury ?? null }), identifiers: spec.ids ?? { sleeper_id: spec.id } , is_team_defense: spec.pos === "DEF" };
  const observedAt = KICK + (o.observedMin ?? -30) * MIN;
  const batch: WeeklyProjectionBatch = {
    league_slug: o.league ?? "L1", season: 2026, week: 5, status: "READY", by_player: new Map([[spec.id, row]]), resolved_players: new Map([[spec.id, live]]),
    source: "sleeper_weekly", model_version: "sleeper-weekly-rotowire", missing: [], teams_with_games: ["KC"], warnings: [],
    canonical_snapshot: { read_path: "SUPABASE_HIT", artifact_id: "art-1", observed_at: iso(observedAt + MIN), age_ms: 0, durable: true, source_observed_at: iso(observedAt) },
    source_observation: { provider: "sleeper", observed_at: iso(observedAt), observation_id: o.obsId ?? "srcobs:abc", content_hash: "h", fetch_path: "LIVE_FETCH" },
  };
  const f = buildCanonicalForecastBatch({
    batch, requested_player_ids: [spec.id], players: new Map([[spec.id, live]]),
    shadow: o.shadow || spec.shadow ? new Map([[spec.id, (o.shadow ?? spec.shadow)!]]) : undefined,
    freshness: { now_ms: KICK + (o.composedMin ?? -20) * MIN, league_slug: o.league ?? "L1", provider: "sleeper", kickoffFor: () => ({ kickoff_at: iso(KICK), game_id: "g1" }) },
  }).by_player.get(spec.id)!;
  return f;
}
function recordFor(spec: Spec, o: Parameters<typeof forecastFor>[1] & { fp?: string } = {}): FinalPregameRecord {
  const f = forecastFor(spec, o);
  return buildFinalPregameRecord({ forecast: f, league_slug: o.league ?? "L1", provider: "sleeper", scoring_fingerprint: o.fp ?? "fp-ppr", source_observation_id: o.obsId ?? "srcobs:abc", recorded_at: f.freshness.forecast_composed_at! })!;
}
const QWR: Spec = { id: "wr1", pts: 14.6, injury: "Questionable" };
const ROLE: ForecastShadowSignals = { role: { mode: "SHADOW", signal: { state: { tier: "A" }, adjustment_points: 1.1, confidence: 0.6 }, reason: "role v1" } };

describe("W1.R1 G1: the final-pregame record is calibration-grade", () => {
  it("freezes the complete decision state: source, conditional, expected, injury semantics, ledger, bye state, shadow components, freshness identity, versions", () => {
    const r = recordFor({ ...QWR, shadow: ROLE });
    const s = r.forecast_snapshot!;
    assert.ok(s, "revision carries the full canonical forecast");
    assert.equal(s.projection.source_points, 14.6);
    assert.equal(s.projection.conditional_active_points, r.conditional_active_points);
    assert.equal(s.projection.expected_points, r.expected_points);
    assert.ok(r.expected_points! < 14.6, "injury-aware value is below the source value for a Questionable player");
    assert.match(s.projection.expected_points_basis, /INJURY/);
    // injury model state + availability probability + workload + semantics/λ basis
    assert.equal(s.injury_model.source_status, "Questionable");
    assert.ok(typeof s.injury_model.probability_active === "number");
    assert.ok(s.injury_model.workload_if_active.basis.length > 0);
    assert.equal(s.injury_model.source_projection_injury_semantics, "UNKNOWN");
    assert.equal(s.injury_model.embedded_fraction_assumed, 0.5);
    assert.ok(s.injury_model.model_version.length > 0);
    // contribution ledger: every PRODUCTION component, reconciling to expected_points
    const prod = s.contributions.filter((c) => c.mode === "PRODUCTION");
    assert.ok(prod.length >= 2, "BASE + injury components are in the ledger");
    assert.ok(Math.abs(prod.reduce((n, c) => n + c.points_delta, 0) - s.projection.expected_points!) < 0.01);
    // bye/current-week state, freshness + source-observation identity, versions
    assert.equal(s.weekly_value.current_week_state, "PLAYABLE");
    assert.equal(s.game_status.is_bye, false);
    assert.equal(s.freshness.source_observation_id, "srcobs:abc");
    assert.equal(r.source_observation_id, "srcobs:abc");
    assert.equal(r.forecast_model_version, s.model_version);
    assert.equal(r.injury_model_version, s.injury_model.model_version);
    // shadow components: value + mode preserved, NOT applied
    assert.equal(s.role.mode, "SHADOW");
    assert.equal(s.role.signal?.adjustment_points, 1.1);
    assert.equal(r.shadow.role_adjustment, 1.1);
    assert.ok(!prod.some((c) => c.component === "ROLE"), "shadow never enters the production sum");
  });

  it("K/DST: source method and certification are preserved (standard-points fallback is not presented as league-exact)", () => {
    const r = recordFor({ id: "k1", pos: "K", pts: 8, extraWarnings: ["k_dst_uses_sleeper_standard_points (league-specific weekly K/DST scoring not reconstructable)"] });
    const s = r.forecast_snapshot!;
    assert.equal(s.provenance.source_type, "K_DST_STANDARD_FALLBACK");
    assert.ok(s.certification.warnings.some((w) => /K_DST/.test(w)));
    const dst = recordFor({ id: "defense:nfl:bal", pos: "DEF", pts: 7, team: "BAL", ids: { yahoo_player_key: "nfl.p.100022" } });
    assert.equal(dst.forecast_snapshot!.injury_model.normalized_state, "NOT_APPLICABLE");
  });

  it("a verified bye: the bye state and the underlying value are frozen apart (utility zero, asset value kept)", () => {
    const row = { ...proj("bye1", "WR", 0, { projection_status: "bye", is_bye: true, expected_availability: 0, rest_of_season_points: 200 }) };
    const live = player("bye1", "WR", { team: "BUF" });
    const batch: WeeklyProjectionBatch = { league_slug: "L1", season: 2026, week: 5, status: "READY", by_player: new Map([["bye1", row]]), resolved_players: new Map([["bye1", live]]), source: "sleeper_weekly", model_version: "v", missing: [], teams_with_games: ["KC"], warnings: [], source_observation: { provider: "sleeper", observed_at: iso(KICK - 30 * MIN), observation_id: "srcobs:abc", content_hash: "h", fetch_path: "LIVE_FETCH" } };
    const f = buildCanonicalForecastBatch({ batch, requested_player_ids: ["bye1"], bye_source_points: new Map([["bye1", 15]]), freshness: { now_ms: KICK - 20 * MIN, kickoffFor: () => ({ kickoff_at: iso(KICK), game_id: "g" }) } }).by_player.get("bye1")!;
    const r = buildFinalPregameRecord({ forecast: f, league_slug: "L1", provider: "sleeper", scoring_fingerprint: "fp", source_observation_id: "srcobs:abc", recorded_at: iso(KICK - 20 * MIN) })!;
    assert.equal(r.forecast_snapshot!.weekly_value.current_week_state, "BYE");
    assert.equal(r.expected_points, 0);
    assert.equal(r.forecast_snapshot!.weekly_value.underlying_points_if_game_played, 15);
  });

  it("the snapshot is an independent deep copy: mutating the live forecast afterwards cannot alter frozen evidence", () => {
    const f = forecastFor(QWR);
    const r = buildFinalPregameRecord({ forecast: f, league_slug: "L1", provider: "sleeper", scoring_fingerprint: "fp", source_observation_id: "srcobs:abc", recorded_at: f.freshness.forecast_composed_at! })!;
    const before = JSON.stringify(r.forecast_snapshot);
    f.projection.expected_points = 999;
    f.contributions.length = 0;
    f.injury_model.probability_active = 0;
    assert.equal(JSON.stringify(r.forecast_snapshot), before);
  });

  it("identity is deterministic and content-addressed: same belief => same id and signature (composition time does not mint revisions); any change of belief => new id", () => {
    const a = recordFor(QWR, { composedMin: -20 });
    const b = recordFor(QWR, { composedMin: -5 });
    assert.equal(a.forecast_id, b.forecast_id);
    assert.equal(a.content_signature, b.content_signature);
    assert.match(a.forecast_id, /^fpf:[0-9a-f]{24}$/);
    assert.notEqual(recordFor({ ...QWR, shadow: ROLE }).content_signature, a.content_signature, "a shadow-only change is a new belief (the P4 signature missed it)");
    assert.notEqual(recordFor({ ...QWR, pts: 15.2 }).forecast_id, a.forecast_id);
    assert.notEqual(recordFor(QWR, { league: "L2" }).forecast_id, a.forecast_id, "league-scoped");
    assert.notEqual(recordFor(QWR, { fp: "fp-std" }).forecast_id, a.forecast_id, "scoring-scoped");
  });
});

describe("W1.R1 G2: no hindsight — a post-kickoff request cannot rewrite the frozen pregame forecast", () => {
  for (const [name, mk] of [["memory", () => new MemoryFinalPregameStore()], ["supabase (FakeRest)", () => new SupabaseFinalPregameStore(new FakeRest().asRest())]] as const) {
    describe(name, () => {
      it("the audit scenario: old pregame observation + newer live 'Out' status composed AFTER kickoff is rejected; the frozen value stays", async () => {
        const store = mk();
        const pre = recordFor({ id: "wr1", pts: 14, injury: null }, { composedMin: -20 });
        assert.equal(await store.upsertCandidate(pre), "RECORDED");
        const post = recordFor({ id: "wr1", pts: 14, injury: "Out" }, { composedMin: 10 }); // SAME observation (T-30m), live status now Out
        assert.equal(post.expected_points, 0, "a post-kickoff recomposition WOULD have produced 0");
        assert.equal(await store.upsertCandidate(post), "REJECTED_POST_KICKOFF");
        const frozen = await store.get("L1", 2026, 5, "wr1");
        assert.equal(frozen?.expected_points, 14);
        assert.equal(frozen?.forecast_id, pre.forecast_id);
      });

      it("composition exactly AT kickoff is not pregame; an observation after composition is incoherent; an observation after kickoff is rejected", async () => {
        const store = mk();
        assert.equal(await store.upsertCandidate(recordFor(QWR, { composedMin: 0 })), "REJECTED_POST_KICKOFF");
        const incoherent = { ...recordFor(QWR, { composedMin: -20 }), source_observed_at: iso(KICK - 10 * MIN) }; // observed after it was composed
        assert.equal(await store.upsertCandidate(incoherent), "REJECTED_INCONSISTENT_TIMES");
        assert.equal(await store.upsertCandidate(recordFor(QWR, { observedMin: 5, composedMin: 6 })), "REJECTED_POST_KICKOFF");
        assert.equal(await store.get("L1", 2026, 5, "wr1"), null);
      });

      it("pre-kickoff updates ARE allowed and advance the pointer; an older observation or an older composition can never regress it", async () => {
        const store = mk();
        const early = recordFor({ id: "wr1", pts: 14, injury: null }, { observedMin: -180, composedMin: -170 });
        const later = recordFor({ id: "wr1", pts: 14, injury: "Questionable" }, { observedMin: -45, composedMin: -40 });
        const latest = recordFor({ id: "wr1", pts: 14, injury: "Doubtful" }, { observedMin: -10, composedMin: -9 });
        assert.equal(await store.upsertCandidate(early), "RECORDED");
        assert.equal(await store.upsertCandidate(later), "RECORDED");
        assert.equal(await store.upsertCandidate(latest), "RECORDED");
        assert.equal(await store.upsertCandidate(early), "REJECTED_OLDER_OBSERVATION");
        assert.equal(await store.upsertCandidate(later), "REJECTED_OLDER_OBSERVATION");
        assert.equal((await store.get("L1", 2026, 5, "wr1"))?.forecast_id, latest.forecast_id);
        // same observation, an OLDER composition of it
        const sameObsOlder = recordFor({ id: "wr1", pts: 14, injury: "Out" }, { observedMin: -10, composedMin: -9.5 });
        assert.equal(await store.upsertCandidate(sameObsOlder), "REJECTED_OLDER_OBSERVATION");
      });
    });
  }

  it("arrival order cannot change the outcome (deterministic final selection across every permutation)", async () => {
    const recs = [
      recordFor({ id: "wr1", pts: 14, injury: null }, { observedMin: -180, composedMin: -170 }),
      recordFor({ id: "wr1", pts: 14, injury: "Questionable" }, { observedMin: -45, composedMin: -40 }),
      recordFor({ id: "wr1", pts: 14, injury: "Doubtful" }, { observedMin: -10, composedMin: -9 }),
      recordFor({ id: "wr1", pts: 14, injury: "Out" }, { observedMin: 3, composedMin: 5 }), // post-kickoff: never eligible
    ];
    const perms = (a: FinalPregameRecord[]): FinalPregameRecord[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
    const expected = selectFinalRevision(recs)!.forecast_id;
    assert.equal(expected, recs[2]!.forecast_id);
    for (const order of perms(recs)) {
      const s = new MemoryFinalPregameStore();
      for (const r of order) await s.upsertCandidate(r);
      assert.equal((await s.get("L1", 2026, 5, "wr1"))?.forecast_id, expected, order.map((r) => r.forecast_id.slice(4, 8)).join(","));
    }
  });
});

describe("W1.R1: immutable revisions + a thin pointer (the revision decision)", () => {
  for (const [name, mk] of [["memory", () => new MemoryFinalPregameStore()], ["supabase (FakeRest)", () => new SupabaseFinalPregameStore(new FakeRest().asRest())]] as const) {
    it(`${name}: every distinct belief is kept forever; the pointer is thin; a revision keeps the full evidence`, async () => {
      const store = mk();
      const a = recordFor({ id: "wr1", pts: 14, injury: null }, { observedMin: -180, composedMin: -170 });
      const b = recordFor({ id: "wr1", pts: 14, injury: "Questionable" }, { observedMin: -45, composedMin: -40 });
      await store.upsertCandidate(a);
      await store.upsertCandidate(b);
      const revs = await store.listRevisions("L1", 2026, 5, "wr1");
      assert.deepEqual(revs.map((r) => r.forecast_id), [a.forecast_id, b.forecast_id], "superseded belief is retained, oldest first");
      const first = await store.getRevision(a.forecast_id);
      assert.equal(first?.expected_points, 14);
      assert.ok(first?.forecast_snapshot, "full evidence on the revision");
      assert.equal(first?.forecast_snapshot?.contributions.length, a.forecast_snapshot!.contributions.length);
      const pointer = await store.get("L1", 2026, 5, "wr1");
      assert.equal(pointer?.forecast_id, b.forecast_id);
      assert.equal(pointer?.forecast_snapshot, null, "pointer references the revision; it does not duplicate it");
    });
  }

  it("identical content seen again CONFIRMS (observation advances) and never mints or rewrites a revision", async () => {
    const store = new MemoryFinalPregameStore();
    const a = recordFor(QWR, { observedMin: -90, composedMin: -80 });
    const same = recordFor(QWR, { observedMin: -20, composedMin: -15 });
    assert.equal(a.content_signature, same.content_signature);
    await store.upsertCandidate(a);
    assert.equal(await store.upsertCandidate(same), "CONFIRMED");
    assert.equal(store.revisionCount(), 1);
    const p = await store.get("L1", 2026, 5, "wr1");
    assert.equal(p?.source_observed_at, a.source_observed_at, "first-observed time is not rewritten");
    assert.equal(p?.confirmed_through, same.confirmed_through);
  });

  it("Supabase: a concurrent writer holding a STALE read cannot regress the pointer past newer evidence (DB-side guard)", async () => {
    const fake = new FakeRest();
    const A = new SupabaseFinalPregameStore(fake.asRest());
    const base = recordFor({ id: "wr1", pts: 14, injury: null }, { observedMin: -180, composedMin: -170 });
    const mid = recordFor({ id: "wr1", pts: 14, injury: "Questionable" }, { observedMin: -45, composedMin: -40 });
    const newest = recordFor({ id: "wr1", pts: 14, injury: "Doubtful" }, { observedMin: -10, composedMin: -9 });
    await A.upsertCandidate(base);
    // instance B reads the pointer (still `base`), then instance A advances it to `newest`, then B writes `mid` from its stale read
    const stale = structuredClone(fake.t("bridge_final_pregame_forecasts"));
    const realSelect = fake.select.bind(fake);
    let served = false;
    fake.select = (async (table: string, opts: never) => {
      if (table === "bridge_final_pregame_forecasts" && !served) {
        served = true;
        await A.upsertCandidate(newest); // the race: A wins while B is between its read and its write
        return stale as never;
      }
      return realSelect(table, opts);
    }) as never;
    const B = new SupabaseFinalPregameStore(fake.asRest());
    assert.equal(await B.upsertCandidate(mid), "RECORDED", "B's decision was made against the stale pointer");
    assert.equal((await A.get("L1", 2026, 5, "wr1"))?.forecast_id, newest.forecast_id, "the pointer did NOT regress");
    assert.equal((await A.listRevisions("L1", 2026, 5, "wr1")).length, 3, "B's belief is still retained as a revision");
  });
});

/* ------------------------------------------------------------------------------------------------------------------ G3 */

const GAME: NflGame = { nfl_game_id: "g1", season: 2026, week: 5, home_team: "KC", away_team: "LV", kickoff_at: iso(KICK), kickoff_source: "espn_scoreboard", status: "complete", provenance: {} };
const LEAGUES: LeagueScoringInput[] = [
  { league_slug: "L1", provider: "sleeper", scoring_fingerprint: scoringFingerprint(PPR), raw_scoring: PPR },
  { league_slug: "L2", provider: "yahoo", scoring_fingerprint: scoringFingerprint(STD), raw_scoring: STD },
];
const WR_STATS = { rec: 6, rec_yd: 80, rec_td: 1, gp: 1 };

function week(cands: Array<{ league: string; canonical: string; c: ProjectionCandidate }>, ids: ReturnType<typeof identityFromFinalPregame>[], actuals: Record<string, Record<string, number>>): BuildWeekInput {
  const candidates = new Map<string, ProjectionCandidate[]>();
  for (const { league, canonical, c } of cands) (candidates.get(`${league}|${canonical}`) ?? candidates.set(`${league}|${canonical}`, []).get(`${league}|${canonical}`)!).push(c);
  const m = new Map(Object.entries(actuals));
  return { season: 2026, week: 5, now: iso(KICK + 6 * 60 * MIN), stats_source: "test", games: [GAME], leagues: LEAGUES, identities: new Map(ids.map((i) => [i.canonical_player_id, i])), candidates, actuals: { clean: m, raw: m }, weather: [], existing: new Map() };
}

describe("W1.R1 G3: calibration scores the FINAL CANONICAL forecast users received", () => {
  const rec = (league: string, fp: string, spec: Spec = QWR, o: Parameters<typeof recordFor>[1] = {}) => recordFor(spec, { league, fp, ...o });

  it("the ledger evaluates the canonical decision value, and scores the SOURCE value of the same player-game beside it", () => {
    const r = rec("L1", scoringFingerprint(PPR));
    const c = candidateFromFinalPregame(r, PPR)!;
    assert.equal(c.kind, "FINAL_PREGAME_FORECAST");
    assert.equal(c.projected_points, r.expected_points);
    assert.equal(c.detail!.source_points, 14.6);
    const out = buildWeekCases(week([{ league: "L1", canonical: "wr1", c }], [identityFromFinalPregame(r)], { WR1: WR_STATS }));
    const cs = out.cases.find((x) => x.league_slug === "L1")!;
    assert.equal(cs.projection_artifact_kind, "FINAL_PREGAME_FORECAST");
    assert.equal(cs.projection_artifact_id, r.forecast_id);
    assert.equal(cs.projected_points, r.expected_points, "headline value is the canonical expected value, not the source");
    assert.equal(cs.actual_fantasy_points, 20);
        assert.equal(cs.error, caseErrors(r.expected_points!, 20).error, "error is measured on the canonical value");
    const sel = cs.projection_selection as Record<string, unknown>;
    assert.equal(sel.evaluation_basis, "CANONICAL_EXPECTED_POINTS");
    const sourceErr = sel.source_basis_error as { error: number };
    assert.equal(sourceErr.error, caseErrors(14.6, 20).error, "source basis scored against the SAME actual");
    // linkage: forecast id, injury adjustment, ledger digest, model versions, source observation, no player-name joins
    assert.equal(sel.final_pregame_forecast_id, r.forecast_id);
    assert.equal(sel.source_observation_id, "srcobs:abc");
    assert.equal(sel.injury_adjustment_points, r.forecast_snapshot!.injury_model.adjustment_points);
    assert.match(String(sel.contribution_ledger_digest), /^[0-9a-f]{16}$/);
    assert.equal(sel.forecast_model_version, r.forecast_model_version);
    assert.equal(cs.canonical_player_id, "wr1");
  });

  it("selection: the final canonical forecast outranks a source snapshot recorded LATER, and legacy weeks (no final record) fall back to the snapshot unchanged", () => {
    const r = rec("L1", scoringFingerprint(PPR), QWR, { composedMin: -40 });
    const fin = candidateFromFinalPregame(r, PPR)!;
    const snap: ProjectionCandidate = { kind: "PROJECTION_SNAPSHOT", artifact_id: "snap", content_hash: "h", request_fingerprint: "x", recorded_at: iso(KICK - 5 * MIN), league_slug: "L1", scoring_fingerprint: scoringFingerprint(PPR), source: "sleeper_weekly", model_version: "v", projected_points: 14.6, floor_points: 9, ceiling_points: 22, std_dev: 4, expected_availability: 0.78, injury_status: "Questionable", warnings: [], nfl_team: "KC", opponent: "LV", position: "WR", scoring_exactness: "LEAGUE_EXACT" };
    assert.equal(selectPregameEvidence([snap, fin], iso(KICK)).chosen?.kind, "FINAL_PREGAME_FORECAST");
    assert.equal(selectPregameEvidence([fin, snap], iso(KICK)).chosen?.kind, "FINAL_PREGAME_FORECAST", "input order irrelevant");
    assert.equal(selectPregameEvidence([snap], iso(KICK)).chosen?.kind, "PROJECTION_SNAPSHOT");
    const out = buildWeekCases(week([{ league: "L1", canonical: "wr1", c: snap }], [identityFromFinalPregame(r)], { WR1: WR_STATS }));
    assert.equal((out.cases[0]!.projection_selection as Record<string, unknown>).evaluation_basis, "SOURCE_PROJECTION");
    assert.equal(out.cases[0]!.projected_points, 14.6);
    // a forecast composed AT/AFTER kickoff is never evidence (the ledger's strict rule, also enforced upstream)
    const lateRec = { ...r, composed_at: iso(KICK) };
    assert.equal(selectPregameEvidence([candidateFromFinalPregame(lateRec, PPR)!], iso(KICK)).chosen, null);
  });

  it("multi-league: the SAME source observation yields SEPARATE league-scored calibration records (never collapsed), each graded under its own scoring", () => {
    const r1 = rec("L1", scoringFingerprint(PPR), { ...QWR, pts: 14.6 });
    const r2 = rec("L2", scoringFingerprint(STD), { ...QWR, pts: 9.4 }); // same observation id, different league scoring => different fantasy value
    assert.equal(r1.source_observation_id, r2.source_observation_id);
    const out = buildWeekCases(week(
      [{ league: "L1", canonical: "wr1", c: candidateFromFinalPregame(r1, PPR)! }, { league: "L2", canonical: "wr1", c: candidateFromFinalPregame(r2, STD)! }],
      [identityFromFinalPregame(r1)], { WR1: WR_STATS }));
    const a = out.cases.find((c) => c.league_slug === "L1")!;
    const b = out.cases.find((c) => c.league_slug === "L2")!;
    assert.notEqual(a.case_id, b.case_id);
    assert.notEqual(a.scoring_fingerprint, b.scoring_fingerprint);
    assert.equal(a.actual_fantasy_points, 20);
    assert.equal(b.actual_fantasy_points, 14, "standard scoring grades the same stat line differently");
    assert.equal(out.football_outcomes.length, 1, "the league-independent football outcome IS shared");
    assert.equal(a.football_outcome_id, b.football_outcome_id);
    assert.notEqual(a.projected_points, b.projected_points);
  });

  it("a scoring mismatch between the revision and the league is never graded (no cross-scoring contamination)", () => {
    const r = rec("L1", scoringFingerprint(STD)); // revision scored under STD, league L1 is PPR
    const out = buildWeekCases(week([{ league: "L1", canonical: "wr1", c: candidateFromFinalPregame(r, PPR)! }], [identityFromFinalPregame(r)], { WR1: WR_STATS }));
    assert.equal(out.cases[0]!.evidence_status, "SCORING_FINGERPRINT_MISMATCH");
    assert.equal(out.cases[0]!.error, null);
  });

  it("provider-neutral: a Yahoo league's canonical team defense is graded through the shared defense identity; a Yahoo-only individual is representable but not fabricated", () => {
    const def = rec("L2", scoringFingerprint(STD), { id: "defense:nfl:kc", pos: "DEF", pts: 7, team: "KC", ids: { yahoo_player_key: "nfl.p.100022" }, extraWarnings: ["k_dst_uses_sleeper_standard_points (x)"] });
    const idDef = identityFromFinalPregame(def);
    assert.equal(idDef.sleeper_id, "KC", "no Sleeper person id is required: the franchise code is the stats-join key");
    const cDef = candidateFromFinalPregame(def, STD)!;
    assert.equal(cDef.scoring_exactness, "PROVIDER_STANDARD_APPROXIMATION", "K/DST standard-points fallback is recorded as an approximation");
    const yo = rec("L2", scoringFingerprint(STD), { id: "player:yahoo:777", pts: 8, ids: { yahoo_player_key: "nfl.p.777" } });
    const idYo = identityFromFinalPregame(yo);
    assert.equal(idYo.sleeper_id, null);
    assert.equal(idYo.resolved, true);
    const out = buildWeekCases(week([{ league: "L2", canonical: "player:yahoo:777", c: candidateFromFinalPregame(yo, STD)! }], [idYo], { WR1: WR_STATS }));
    const c = out.cases[0];
    assert.equal(c?.actual_fantasy_points ?? null, null, "no stats join => no fabricated outcome");
    assert.ok(c ? c.evidence_status !== "CERTIFIED" : true);
  });

  it("evidence changes produce a new REVISION of the case (never an update), keyed by the immutable forecast id", () => {
    const r1 = rec("L1", scoringFingerprint(PPR), QWR, { composedMin: -40 });
    const c1 = candidateFromFinalPregame(r1, PPR)!;
    const first = buildWeekCases(week([{ league: "L1", canonical: "wr1", c: c1 }], [identityFromFinalPregame(r1)], { WR1: WR_STATS }));
    const head = first.cases.find((c) => c.league_slug === "L1")!;
    const heads = () => new Map(first.cases.map((c) => [c.case_id, { evidence_digest: c.evidence_digest, revision: c.revision, provider_player_ids: c.provider_player_ids }]));
    const again = buildWeekCases({ ...week([{ league: "L1", canonical: "wr1", c: c1 }], [identityFromFinalPregame(r1)], { WR1: WR_STATS }), existing: heads() });
    assert.equal(again.cases.length, 0);
    assert.equal(again.unchanged, first.cases.length);
    const r2 = rec("L1", scoringFingerprint(PPR), { ...QWR, injury: "Doubtful" }, { composedMin: -10 });
    const next = buildWeekCases({ ...week([{ league: "L1", canonical: "wr1", c: candidateFromFinalPregame(r2, PPR)! }], [identityFromFinalPregame(r2)], { WR1: WR_STATS }), existing: heads() });
    const l1 = next.cases.find((c) => c.league_slug === "L1")!;
    assert.equal(l1.revision, 2);
    assert.equal(l1.supersedes_evidence_digest, head.evidence_digest);
    assert.equal(l1.projection_artifact_id, r2.forecast_id);
  });

  it("a thin pointer / missing snapshot is not usable evidence (nothing to grade is never invented)", () => {
    const r = rec("L1", scoringFingerprint(PPR));
    assert.equal(candidateFromFinalPregame({ ...r, forecast_snapshot: null }, PPR), null);
    assert.equal(candidateFromFinalPregame({ ...r, expected_points: null }, PPR), null);
    void candidateFromSnapshotRow;
  });
});
