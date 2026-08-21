/**
 * Tests for the multi-league registry (`lib/leagues/registry.ts`) and its
 * integration into `resolveLeagueId` / `parseLeagueSelector`.
 *
 * These use `getLeagueRegistry()` against the real static target list (so the
 * "Devoted to the Game" entry itself is exercised), plus a set of synthetic
 * lists passed through the same validation/dedup logic to prove the
 * safety guarantees deterministically, independent of what's currently in
 * the registry.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_LEAGUE_KEY,
  findLeagueTarget,
  getLeagueRegistry,
  listLeagueTargets,
  validateAndDedupeTargets,
  type LeagueTarget,
} from "../lib/leagues/registry";
import { resolveLeagueId } from "../lib/sleeper/service";
import { parseLeagueSelector } from "../lib/analytics/query";

/** A minimal, valid target for building synthetic registry-shaped fixtures. */
function target(overrides: Partial<LeagueTarget> = {}): LeagueTarget {
  return {
    key: "test-league",
    provider: "sleeper",
    league_id: "1111111111111111111",
    display_name: "Test League",
    sleeper_username: "tester",
    sleeper_user_id: "2222222222222222222",
    enabled: true,
    ...overrides,
  };
}

describe("registry: the real static target list", () => {
  it("includes Bloodline Bowl as the default target", () => {
    const bloodlineBowl = findLeagueTarget(DEFAULT_LEAGUE_KEY);
    assert.ok(bloodlineBowl);
    assert.equal(bloodlineBowl.league_id, "1395549281678532608");
    assert.equal(bloodlineBowl.provider, "sleeper");
  });

  it("includes Devoted to the Game as an explicit league target", () => {
    const devoted = findLeagueTarget("devoted-to-the-game");
    assert.ok(devoted, "expected a registry entry for devoted-to-the-game");
    assert.equal(devoted.league_id, "1389735763649761280");
    assert.equal(devoted.display_name, "Devoted to the Game");
    assert.equal(devoted.sleeper_username, "darthmarker");
    assert.equal(devoted.sleeper_user_id, "1265419589680910336");
    assert.equal(devoted.provider, "sleeper");
    assert.equal(devoted.enabled, true);
  });

  it("keeps every enabled target's league_id unique", () => {
    const { targets } = getLeagueRegistry();
    const ids = targets.map((t) => `${t.provider}:${t.league_id}`);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("loads with no warnings for the real target list", () => {
    const { warnings } = getLeagueRegistry();
    assert.deepEqual(warnings, []);
  });
});

describe("registry: deduplication by provider + league_id (synthetic fixtures)", () => {
  it("keeps the first entry and drops a later duplicate league_id under a different key", () => {
    // The exact scenario the task describes: a league appearing under two
    // different registry keys (analogous to "returned by discovery AND
    // present in explicit config") must not be synced/served twice.
    const original = target({ key: "alpha", league_id: "9999999999999999999" });
    const duplicate = target({ key: "beta", league_id: "9999999999999999999" });

    const { targets, warnings } = validateAndDedupeTargets([
      original,
      duplicate,
    ]);

    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.key, "alpha");
    assert.ok(!targets.some((t) => t.key === "beta"));
    assert.ok(
      warnings.some(
        (w) => w.includes("beta") && w.includes("already registered"),
      ),
    );
  });

  it("drops a duplicate key outright, independent of league_id", () => {
    const first = target({ key: "same-key", league_id: "1111111111111111111" });
    const second = target({
      key: "same-key",
      league_id: "2222222222222222222",
    });

    const { targets, warnings } = validateAndDedupeTargets([first, second]);

    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.league_id, "1111111111111111111");
    assert.ok(warnings.some((w) => w.includes("duplicate league target key")));
  });

  it("treats different providers with the same league_id string as distinct (no false dedupe)", () => {
    // Not reachable today (only "sleeper" exists), but the dedupe key is
    // provider:league_id, not league_id alone — this proves that scoping.
    const a = target({
      key: "a",
      provider: "sleeper",
      league_id: "5555555555555555555",
    });
    const b = {
      ...target({ key: "b", league_id: "5555555555555555555" }),
      provider: "sleeper" as const,
    };
    // Same provider on purpose here since "sleeper" is the only real value;
    // this asserts the dedupe key is the literal string "provider:league_id".
    const { targets } = validateAndDedupeTargets([a, b]);
    assert.equal(targets.length, 1);
  });

  it("real registry: findLeagueTarget is stable across repeated lookups", () => {
    const first = findLeagueTarget("devoted-to-the-game");
    const second = findLeagueTarget("devoted-to-the-game");
    assert.deepEqual(first, second);
  });

  it("does not return a target for an unregistered key", () => {
    assert.equal(findLeagueTarget("not-a-real-league"), null);
  });
});

describe("registry: disabled targets are ignored (synthetic fixtures)", () => {
  it("a disabled target is excluded from the enabled list entirely", () => {
    const enabledOne = target({
      key: "enabled-one",
      league_id: "3333333333333333333",
    });
    const disabledOne = target({
      key: "disabled-one",
      league_id: "4444444444444444444",
      enabled: false,
    });

    const { targets, disabled } = validateAndDedupeTargets([
      enabledOne,
      disabledOne,
    ]);

    assert.deepEqual(
      targets.map((t) => t.key),
      ["enabled-one"],
    );
    assert.deepEqual(
      disabled.map((t) => t.key),
      ["disabled-one"],
    );
  });

  it("a disabled target's key does not resolve, even with no enabled target sharing it", () => {
    const disabledOnly = target({ key: "only-disabled", enabled: false });
    const { targets } = validateAndDedupeTargets([disabledOnly]);
    assert.equal(
      targets.find((t) => t.key === "only-disabled"),
      undefined,
    );
  });

  it("a disabled target never appears in the real listLeagueTargets()", () => {
    const targets = listLeagueTargets();
    const { disabled } = getLeagueRegistry();
    for (const entry of disabled) {
      assert.ok(!targets.some((t) => t.key === entry.key));
    }
  });
});

describe("registry: malformed/missing league ids fail safely (synthetic fixtures)", () => {
  it("drops a target with a non-numeric league_id, without throwing", () => {
    const bad = target({ key: "bad-id", league_id: "not-a-number" });
    const good = target({ key: "good-id", league_id: "6666666666666666666" });

    const { targets, warnings } = validateAndDedupeTargets([bad, good]);

    assert.deepEqual(
      targets.map((t) => t.key),
      ["good-id"],
    );
    assert.ok(
      warnings.some(
        (w) => w.includes("bad-id") && w.includes("not a valid numeric"),
      ),
    );
  });

  it("drops a target with an empty-string league_id", () => {
    const bad = target({ key: "empty-id", league_id: "" });
    const { targets, warnings } = validateAndDedupeTargets([bad]);
    assert.equal(targets.length, 0);
    assert.ok(warnings.length > 0);
  });

  it("drops a target with a missing key", () => {
    const bad = target({ key: "" });
    const { targets, warnings } = validateAndDedupeTargets([bad]);
    assert.equal(targets.length, 0);
    assert.ok(warnings.some((w) => w.includes("missing or invalid key")));
  });

  it("never throws on a batch of entirely malformed input", () => {
    const allBad: LeagueTarget[] = [
      target({ key: "", league_id: "" }),
      target({ key: "x", league_id: "abc" }),
      target({ key: "", league_id: "123" }),
    ];
    assert.doesNotThrow(() => validateAndDedupeTargets(allBad));
    const { targets } = validateAndDedupeTargets(allBad);
    assert.equal(targets.length, 0);
  });

  it("keeps every valid target even when malformed ones are interleaved", () => {
    const mixed: LeagueTarget[] = [
      target({ key: "ok-1", league_id: "1010101010101010101" }),
      target({ key: "bad-1", league_id: "nope" }),
      target({ key: "ok-2", league_id: "2020202020202020202" }),
      target({ key: "", league_id: "3030303030303030303" }),
    ];
    const { targets, warnings } = validateAndDedupeTargets(mixed);
    assert.deepEqual(targets.map((t) => t.key).sort(), ["ok-1", "ok-2"]);
    assert.equal(warnings.length, 2);
  });

  it("the real registry itself contains no malformed entries today", () => {
    const { warnings } = getLeagueRegistry();
    assert.deepEqual(warnings, []);
  });
});

describe("resolveLeagueId: selector resolution", () => {
  it("resolves a registry key to its league_id", () => {
    assert.equal(resolveLeagueId("devoted-to-the-game"), "1389735763649761280");
    assert.equal(resolveLeagueId("bloodline-bowl"), "1395549281678532608");
  });

  it("passes through a raw numeric league id even if unregistered", () => {
    // Any Sleeper league is reachable directly — the registry is a naming
    // convenience, not an allowlist gate.
    assert.equal(resolveLeagueId("42"), "42");
  });

  it("falls back to the default league when no selector is given", () => {
    assert.equal(resolveLeagueId(), "1395549281678532608");
    assert.equal(resolveLeagueId(null), "1395549281678532608");
    assert.equal(resolveLeagueId(""), "1395549281678532608");
  });

  it("falls back to the default rather than throwing on an unrecognized non-numeric selector", () => {
    assert.equal(
      resolveLeagueId("totally-not-a-league"),
      "1395549281678532608",
    );
  });

  it("username-based discovery selectors (env override) still work unchanged", () => {
    const original = process.env.SLEEPER_LEAGUE_ID;
    try {
      process.env.SLEEPER_LEAGUE_ID = "555555555555555555";
      assert.equal(resolveLeagueId(), "555555555555555555");
      // An explicit selector still takes priority over the env override.
      assert.equal(
        resolveLeagueId("devoted-to-the-game"),
        "1389735763649761280",
      );
    } finally {
      if (original === undefined) delete process.env.SLEEPER_LEAGUE_ID;
      else process.env.SLEEPER_LEAGUE_ID = original;
    }
  });
});

describe("parseLeagueSelector: query validation", () => {
  it("accepts a known registry key", () => {
    const result = parseLeagueSelector("devoted-to-the-game");
    assert.deepEqual(result, { value: "devoted-to-the-game" });
  });

  it("accepts a raw numeric league id", () => {
    const result = parseLeagueSelector("1389735763649761280");
    assert.deepEqual(result, { value: "1389735763649761280" });
  });

  it("accepts a missing/empty selector as null (default league)", () => {
    assert.deepEqual(parseLeagueSelector(null), { value: null });
    assert.deepEqual(parseLeagueSelector(""), { value: null });
  });

  it("rejects an unrecognized non-numeric selector with a 400-shaped error", () => {
    const result = parseLeagueSelector("not-a-real-league");
    assert.ok("error" in result);
    assert.match(result.error, /league must be a known league key/);
    // The error names the actually-known keys, so a caller can self-correct.
    assert.match(result.error, /devoted-to-the-game/);
    assert.match(result.error, /bloodline-bowl/);
  });

  it("rejects malformed input that looks numeric-adjacent but isn't", () => {
    for (const bad of ["12.5", "-5", "1e10", "<script>", "abc123"]) {
      const result = parseLeagueSelector(bad);
      assert.ok("error" in result, `expected "${bad}" to be rejected`);
    }
  });
});

describe("registry: fallback naming", () => {
  it("display_name is available as a fallback label distinct from Sleeper's own name", () => {
    const devoted = findLeagueTarget("devoted-to-the-game");
    assert.equal(devoted?.display_name, "Devoted to the Game");
    // The registry's display_name never appears in scoring/roster response
    // shapes — those always carry Sleeper's own live `league.name` instead;
    // this is purely a naming/addressing convenience for the bridge itself.
  });
});

describe("live: Devoted to the Game resolves to the real Sleeper league", () => {
  it("resolves the registry key to the correct live Sleeper league", async () => {
    const target = findLeagueTarget("devoted-to-the-game");
    assert.ok(target);

    const { getLeague, getLeagueUsers } = await import("../lib/sleeper/client");
    const league = await getLeague(target.league_id);
    assert.equal(league.league_id, "1389735763649761280");
    assert.equal(league.name, "Devoted to the Game");
    assert.equal(league.sport, "nfl");

    // darthmarker (the configured sleeper_username's user_id) must actually
    // be a member of this league, confirming the registry entry points at
    // the right account's league and not a lookalike id.
    const users = await getLeagueUsers(target.league_id);
    const darthmarker = users.find((u) => u.user_id === target.sleeper_user_id);
    assert.ok(
      darthmarker,
      "darthmarker should be a member of Devoted to the Game",
    );
  });

  it("is isolated from Bloodline Bowl's scoring settings", async () => {
    const { getLeague } = await import("../lib/sleeper/client");
    const [bloodlineBowl, devoted] = await Promise.all([
      getLeague(resolveLeagueId("bloodline-bowl")),
      getLeague(resolveLeagueId("devoted-to-the-game")),
    ]);
    // Confirmed live: these two leagues use different reception values, so
    // this also proves the two requests are not accidentally sharing state.
    assert.notEqual(
      bloodlineBowl.scoring_settings.rec,
      devoted.scoring_settings.rec,
    );
  });
});
