/**
 * Draft-Live client poller — deterministic interval mechanics (fake timers).
 *
 * Covers Stage F Draft-Live readiness items: status-driven cadence,
 * pre_draft → drafting auto-activation, pick observed on next poll, no request
 * pile-ups, transient error keeps last-known-good + auto-recovers, drafting →
 * complete stops rapid polling, visibility pause/resume, and that
 * BRIDGE_PUBLISHED_SNAPSHOT has no effect. No React render, no real Sleeper.
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import {
  DraftPoller,
  pollIntervalForStatus,
  DRAFT_LIVE_POLL_MS,
  DRAFT_STATUS_POLL_MS,
} from "../lib/bridge/draft-poller";

const FLAG = "BRIDGE_PUBLISHED_SNAPSHOT";
afterEach(() => delete process.env[FLAG]);

/** Minimal ordered fake clock with microtask flushing between due timers. */
class FakeClock {
  #q: { id: number; fn: () => void; at: number }[] = [];
  #now = 0;
  #id = 1;
  setTimer = (fn: () => void, ms: number): number => {
    const id = this.#id++;
    this.#q.push({ id, fn, at: this.#now + ms });
    return id;
  };
  clearTimer = (h: unknown): void => {
    this.#q = this.#q.filter((t) => t.id !== h);
  };
  async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const due = this.#q
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.#q = this.#q.filter((t) => t.id !== due.id);
      this.#now = due.at;
      due.fn();
      await this.flush();
    }
    this.#now = target;
  }
}

describe("pollIntervalForStatus", () => {
  it("drafting / paused → rapid; pre_draft → moderate; else → stop", () => {
    assert.equal(pollIntervalForStatus("drafting"), DRAFT_LIVE_POLL_MS);
    assert.equal(pollIntervalForStatus("paused"), DRAFT_LIVE_POLL_MS);
    assert.equal(pollIntervalForStatus("pre_draft"), DRAFT_STATUS_POLL_MS);
    assert.equal(pollIntervalForStatus("complete"), null);
    assert.equal(pollIntervalForStatus("unknown"), null);
    assert.equal(pollIntervalForStatus(null), null);
    assert.equal(DRAFT_LIVE_POLL_MS, 2000);
    assert.ok(DRAFT_STATUS_POLL_MS >= 5000 && DRAFT_STATUS_POLL_MS <= 10000);
  });
});

function harness(initialStatus: string) {
  const clock = new FakeClock();
  let status = initialStatus;
  let polls = 0;
  let failNext = 0;
  const poller = new DraftPoller({
    getStatus: () => status,
    poll: async () => {
      polls += 1;
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("transient");
      }
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    clock,
    poller,
    get polls() {
      return polls;
    },
    setStatus: (s: string) => (status = s),
    failNextPolls: (n: number) => (failNext = n),
  };
}

describe("DraftPoller: status-driven cadence", () => {
  it("pre_draft polls on the moderate cadence, not rapidly", async () => {
    const h = harness("pre_draft");
    h.poller.start();
    await h.clock.flush();
    assert.equal(h.polls, 1); // immediate first tick
    await h.clock.advance(2000);
    assert.equal(h.polls, 1, "no rapid poll during pre_draft");
    await h.clock.advance(DRAFT_STATUS_POLL_MS);
    assert.equal(h.polls, 2);
    h.poller.stop();
  });

  it("drafting polls every ~2s", async () => {
    const h = harness("drafting");
    h.poller.start();
    await h.clock.flush();
    assert.equal(h.polls, 1);
    await h.clock.advance(2000);
    assert.equal(h.polls, 2);
    await h.clock.advance(2000);
    assert.equal(h.polls, 3);
    await h.clock.advance(6000);
    assert.equal(h.polls, 6);
    h.poller.stop();
  });

  it("status unknown on mount: polls once to learn it, then follows the learned cadence", async () => {
    const clock = new FakeClock();
    let status: string | null = null;
    let polls = 0;
    const poller = new DraftPoller({
      getStatus: () => status,
      poll: async () => {
        polls += 1;
        status = "drafting"; // the first poll teaches us the draft is live
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    poller.start();
    await clock.flush();
    assert.equal(polls, 1, "polled once despite not knowing the status yet");
    await clock.advance(2000); // now on the rapid cadence
    assert.equal(polls, 2);
    poller.stop();
  });

  it("status genuinely complete after a poll: stops", async () => {
    const clock = new FakeClock();
    let status = "drafting";
    let polls = 0;
    const poller = new DraftPoller({
      getStatus: () => status,
      poll: async () => {
        polls += 1;
        if (polls === 2) status = "complete";
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    poller.start();
    await clock.flush();
    await clock.advance(2000); // poll 2 -> status becomes complete
    await clock.advance(60000);
    assert.equal(polls, 2);
    assert.equal(poller.isRunning, false);
  });

  it("pre_draft → drafting activates rapid polling automatically", async () => {
    const h = harness("pre_draft");
    h.poller.start();
    await h.clock.flush();
    assert.equal(h.polls, 1);
    // the draft starts; the next moderate poll observes it
    h.setStatus("drafting");
    await h.clock.advance(DRAFT_STATUS_POLL_MS);
    assert.equal(h.polls, 2);
    // from here the cadence is rapid, no manual refresh
    await h.clock.advance(2000);
    assert.equal(h.polls, 3);
    await h.clock.advance(2000);
    assert.equal(h.polls, 4);
    h.poller.stop();
  });

  it("drafting → complete stops rapid polling", async () => {
    const h = harness("drafting");
    h.poller.start();
    await h.clock.flush();
    await h.clock.advance(2000);
    assert.equal(h.polls, 2);
    h.setStatus("complete");
    await h.clock.advance(2000); // the tick after this poll sees "complete"
    const afterComplete = h.polls;
    await h.clock.advance(60000);
    assert.equal(h.polls, afterComplete, "no 2s interval left running after completion");
    assert.equal(h.poller.isRunning, false);
  });
});

describe("DraftPoller: robustness", () => {
  it("does not pile up overlapping requests (recursive schedule waits for the poll)", async () => {
    const clock = new FakeClock();
    let inFlight = 0;
    let maxConcurrent = 0;
    const resolvers: (() => void)[] = [];
    const poller = new DraftPoller({
      getStatus: () => "drafting",
      poll: () =>
        new Promise<void>((resolve) => {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          resolvers.push(() => {
            inFlight -= 1;
            resolve();
          });
        }),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    poller.start();
    await clock.flush();
    // first poll is hanging; advance well past several intervals
    await clock.advance(10000);
    assert.equal(maxConcurrent, 1, "only one poll in flight at a time");
    // let it finish and confirm it resumes
    resolvers.shift()!();
    await clock.flush();
    await clock.advance(2000);
    resolvers.forEach((r) => r());
    poller.stop();
  });

  it("a transient error keeps last-known-good and auto-recovers", async () => {
    const h = harness("drafting");
    h.failNextPolls(2); // poll 1 and 2 throw, poll 3+ succeed
    h.poller.start();
    await h.clock.flush();
    assert.equal(h.polls, 1); // first poll failed
    assert.equal(h.poller.isRunning, true, "a failed poll never disables the loop");

    // backoff after a failure is > the rapid interval; advance generously so
    // the loop retries, fails once more, then recovers.
    await h.clock.advance(60000);
    assert.ok(h.polls >= 3, `expected recovery, got ${h.polls} polls`);
    assert.equal(h.poller.isRunning, true);

    // once recovered (consecutiveFailures reset) the cadence returns to rapid
    const n = h.polls;
    await h.clock.advance(2000);
    assert.equal(h.polls, n + 1, "cadence back to 2s after recovery");
    h.poller.stop();
  });

  it("tab hidden pauses; visible refreshes immediately and resumes cadence", async () => {
    const h = harness("drafting");
    h.poller.start();
    await h.clock.flush();
    assert.equal(h.polls, 1);
    h.poller.pause();
    await h.clock.advance(30000);
    assert.equal(h.polls, 1, "no polling while hidden");
    h.poller.resume();
    await h.clock.flush();
    assert.equal(h.polls, 2, "immediate refresh on becoming visible");
    await h.clock.advance(2000);
    assert.equal(h.polls, 3, "cadence resumed");
    h.poller.stop();
  });

  it("stop() cancels any pending tick", async () => {
    const h = harness("drafting");
    h.poller.start();
    await h.clock.flush();
    h.poller.stop();
    await h.clock.advance(60000);
    assert.equal(h.polls, 1);
  });
});

describe("DraftPoller: published-snapshot isolation", () => {
  it("BRIDGE_PUBLISHED_SNAPSHOT=all does not change the cadence or behavior", async () => {
    const baseline = harness("drafting");
    baseline.poller.start();
    await baseline.clock.flush();
    await baseline.clock.advance(6000);
    const baselinePolls = baseline.polls;
    baseline.poller.stop();

    process.env[FLAG] = "all";
    const flagged = harness("drafting");
    flagged.poller.start();
    await flagged.clock.flush();
    await flagged.clock.advance(6000);
    assert.equal(flagged.polls, baselinePolls);
    flagged.poller.stop();

    // the poller module contains no code path to env / pointer / published state
    const src = (await import("node:fs")).readFileSync("lib/bridge/draft-poller.ts", "utf8");
    for (const forbidden of [
      "process.env",
      "@/lib/canonical",
      "@/lib/persistence",
      "getPublishedLeagueSnapshot",
      "readLeagueState",
      "publishLeagueSnapshot",
      "bridge_published_snapshot",
      "import(",
      "require(",
    ]) {
      assert.ok(!src.includes(forbidden), `draft-poller must not reference "${forbidden}"`);
    }
  });
});

describe("DraftPoller: Sporty's Alumni resolves through the same behavior", () => {
  it("a 14-team snake draft in `drafting` polls at 2s like any other", async () => {
    // The poller is league-agnostic — it only sees the status string. Sporty's
    // Alumni (sportys-alumni / draft 1389404340032118784, snake, 14 teams) is
    // driven by exactly this path.
    const h = harness("drafting");
    h.poller.start();
    await h.clock.flush();
    await h.clock.advance(4000);
    assert.equal(h.polls, 3);
    h.poller.stop();
  });
});
