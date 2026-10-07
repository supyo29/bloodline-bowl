/** W1.P4 invalidation event contract: provider-neutral matching, targeted scopes, and the official-inactive seam. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InvalidationLedger, makeEvent, officialInactiveEvents, scopeBreadth, scopeCovers, type EventTarget, type InvalidationScope } from "../lib/weekly/freshness/events";
import { evaluateForecastFreshness } from "../lib/weekly/freshness/policy";

const MIN = 60_000;
const KICK = Date.parse("2026-10-11T17:00:00.000Z");
const at = (off: number) => new Date(KICK + off).toISOString();

const sleeperWr: EventTarget = { canonical_player_id: "cp:wr1", identifiers: { sleeper_id: "4046" }, nfl_team: "KC", game_id: "g1", season: 2026, week: 5, league_slug: "bloodline-bowl" };
const yahooWr: EventTarget = { canonical_player_id: "cp:wr1", identifiers: { yahoo_id: "30121" }, nfl_team: "KC", game_id: "g1", season: 2026, week: 5, league_slug: "rogers-park" };
/** a Yahoo-only player: no sleeper id at all */
const yahooOnly: EventTarget = { canonical_player_id: "cp:yonly", identifiers: { yahoo_player_key: "nfl.p.99" }, nfl_team: "DAL", game_id: "g2", season: 2026, week: 5 };
const unrelated: EventTarget = { canonical_player_id: "cp:other", identifiers: { sleeper_id: "999" }, nfl_team: "DAL", game_id: "g2", season: 2026, week: 5 };

describe("W1.P4 event scopes are TARGETED", () => {
  it("a PLAYER event covers only that player", () => {
    const s: InvalidationScope = { kind: "PLAYER", provider: "sleeper", provider_player_id: "4046" };
    assert.equal(scopeCovers(s, sleeperWr), true);
    assert.equal(scopeCovers(s, unrelated), false, "one player's injury news does not invalidate an unrelated forecast");
    assert.equal(scopeCovers(s, yahooOnly), false);
  });

  it("a TEAM event covers that team's players only; a GAME event covers the two teams", () => {
    assert.equal(scopeCovers({ kind: "TEAM", nfl_team: "kc" }, sleeperWr), true);
    assert.equal(scopeCovers({ kind: "TEAM", nfl_team: "KC" }, unrelated), false);
    assert.equal(scopeCovers({ kind: "GAME", game_id: "g1" }, sleeperWr), true);
    assert.equal(scopeCovers({ kind: "GAME", game_id: "g1" }, unrelated), false);
    assert.equal(scopeCovers({ kind: "GAME", teams: ["KC", "LV"] }, sleeperWr), true);
  });

  it("scope breadth is ordered narrow -> broad (a simple player event is never emitted as a broad scope)", () => {
    const order: InvalidationScope[] = [
      { kind: "PLAYER", canonical_player_id: "x" },
      { kind: "TEAM", nfl_team: "KC" },
      { kind: "GAME", game_id: "g" },
      { kind: "LEAGUE_DERIVATIVE", league_slug: "l" },
      { kind: "SOURCE_SNAPSHOT", provider: "sleeper", season: 2026, week: 5 },
    ];
    const b = order.map(scopeBreadth);
    assert.deepEqual(b, [...b].sort((x, y) => x - y));
  });

  it("LEAGUE_DERIVATIVE is orthogonal: it covers exactly one league", () => {
    const s: InvalidationScope = { kind: "LEAGUE_DERIVATIVE", league_slug: "rogers-park" };
    assert.equal(scopeCovers(s, yahooWr), true);
    assert.equal(scopeCovers(s, sleeperWr), false);
  });

  it("the ledger returns only events whose scope covers the target (one player event leaves 99 other forecasts untouched)", () => {
    const ledger = new InvalidationLedger();
    ledger.add([makeEvent({ type: "INJURY_STATUS_CHANGE", scope: { kind: "PLAYER", provider: "sleeper", provider_player_id: "4046" }, effective_at: null, known_at: at(-30 * MIN), source: "sleeper", authority: "PROVIDER_STATUS", detail: { to: "Out" } })]);
    assert.equal(ledger.affecting(sleeperWr).length, 1);
    const untouched = Array.from({ length: 99 }, (_, i) => ({ canonical_player_id: `cp:${i}`, identifiers: { sleeper_id: String(10_000 + i) }, nfl_team: "DAL" }) as EventTarget);
    assert.equal(untouched.filter((t) => ledger.affecting(t).length > 0).length, 0);
  });

  it("event ids are deterministic and the ledger de-duplicates", () => {
    const e = () => makeEvent({ type: "TEAM_CHANGE", scope: { kind: "TEAM", nfl_team: "KC" }, effective_at: null, known_at: at(0), source: "x", authority: "MANUAL", detail: {} });
    assert.equal(e().event_id, e().event_id);
    const l = new InvalidationLedger();
    assert.equal(l.add([e(), e()]), 1);
  });
});

describe("W1.P4 provider neutrality: generic freshness logic needs no Sleeper player id", () => {
  const injury = (p: { provider: string; provider_player_id: string }) => makeEvent({ type: "INJURY_STATUS_CHANGE", scope: { kind: "PLAYER", ...p }, effective_at: null, known_at: at(-10 * MIN), source: p.provider, authority: "PROVIDER_STATUS", detail: {} });

  it("a Yahoo-keyed event matches a Yahoo-identified forecast", () => {
    assert.equal(scopeCovers(injury({ provider: "yahoo", provider_player_id: "30121" }).scope, yahooWr), true);
    assert.equal(scopeCovers(injury({ provider: "yahoo", provider_player_id: "nfl.p.99" }).scope, yahooOnly), true, "yahoo_player_key also resolves");
  });

  it("a canonical-id event matches regardless of which provider ids the target has", () => {
    const s: InvalidationScope = { kind: "PLAYER", canonical_player_id: "cp:yonly" };
    assert.equal(scopeCovers(s, yahooOnly), true);
  });

  it("freshness evaluation for a Yahoo-only player (no Sleeper id) is fully computed and event-aware", () => {
    const events = [injury({ provider: "yahoo", provider_player_id: "nfl.p.99" })].filter((e) => scopeCovers(e.scope, yahooOnly));
    const r = evaluateForecastFreshness({ now_ms: KICK - 5 * MIN, kickoff_at: at(0), source_observed_at: at(-20 * MIN), events });
    assert.equal(r.state, "STALE");
    assert.equal(r.reason, "INVALIDATED_BY_EVENT");
  });

  it("Sleeper and Yahoo events for the same canonical player do not collide with each other's id space", () => {
    // sleeper id "30121" must not match a yahoo target whose YAHOO id is 30121, and vice versa
    assert.equal(scopeCovers(injury({ provider: "sleeper", provider_player_id: "30121" }).scope, yahooWr), false);
    assert.equal(scopeCovers(injury({ provider: "yahoo", provider_player_id: "4046" }).scope, sleeperWr), false);
  });
});

describe("W1.P4 official-inactive seam", () => {
  it("is high-authority, player-scoped, and uses Bloodline's observation time as known_at", () => {
    const [e] = officialInactiveEvents([{ season: 2026, week: 5, provider: "sleeper", provider_player_id: "4046", nfl_team: "KC", announced_at: at(-90 * MIN), observed_at: at(-85 * MIN), source: "fixture-inactives" }]);
    assert.equal(e!.type, "OFFICIAL_INACTIVE");
    assert.equal(e!.authority, "OFFICIAL");
    assert.equal(e!.effective_at, at(-90 * MIN));
    assert.equal(e!.known_at, at(-85 * MIN));
    assert.equal(scopeCovers(e!.scope, sleeperWr), true);
    assert.equal(scopeCovers(e!.scope, unrelated), false);
  });
});
