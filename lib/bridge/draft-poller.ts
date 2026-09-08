/**
 * Draft-Live client poller — framework-agnostic so the interval mechanics can be
 * unit-tested with fake timers (the `/bridge` React component just wires it up).
 *
 * Status-driven cadence:
 *   drafting / paused  → DRAFT_LIVE_POLL_MS   (rapid — catch every pick)
 *   pre_draft          → DRAFT_STATUS_POLL_MS (moderate — notice the draft start)
 *   complete / other   → stop polling
 *   unknown (no board yet) → poll once to learn the status, bounded retries
 *
 * It does NOT touch canonical state, published snapshots, the pointer, the
 * refresh/publish cron, or any recommendation model. It only decides WHEN the
 * client should re-fetch the existing Draft-Live board.
 *
 * Overlap-safe by construction: a recursive `setTimeout` schedules the next tick
 * only AFTER the current `poll()` promise settles, so two polls never run at
 * once. A failed poll never stops the loop — it backs off (bounded) and retries,
 * and the caller keeps its last-known-good board.
 */

export const DRAFT_LIVE_POLL_MS = 2000;
export const DRAFT_STATUS_POLL_MS = 7000;
/** Failed-poll backoff: interval × 2^n, capped. */
export const DRAFT_POLL_MAX_BACKOFF_MS = 15000;

export type DraftPollStatus = string | null | undefined;

export type PollDecision = "rapid" | "moderate" | "stop" | "unknown";

/**
 * What to do for a given draft status:
 *   rapid    — `drafting` / `paused`      → poll every DRAFT_LIVE_POLL_MS
 *   moderate — `pre_draft`                → poll every DRAFT_STATUS_POLL_MS
 *   stop     — any other KNOWN status (`complete`, `idle`, …) → stop polling
 *   unknown  — no status yet (null / "")  → poll once to learn it, bounded retries
 */
export function pollDecision(status: DraftPollStatus): PollDecision {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "drafting" || s === "paused") return "rapid";
  if (s === "pre_draft") return "moderate";
  if (s === "") return "unknown";
  return "stop";
}

/**
 * Milliseconds until the next poll for a given draft status, or `null` when
 * there is no rapid/moderate cadence (stop or still-unknown).
 */
export function pollIntervalForStatus(status: DraftPollStatus): number | null {
  switch (pollDecision(status)) {
    case "rapid":
      return DRAFT_LIVE_POLL_MS;
    case "moderate":
      return DRAFT_STATUS_POLL_MS;
    default:
      return null;
  }
}

export interface DraftPollerOptions {
  /** Current draft status (from the last board the caller received). */
  getStatus: () => DraftPollStatus;
  /** Perform one board refetch. Rejections are caught and retried, not fatal. */
  poll: () => Promise<void>;
  /** Injected for tests. Default: global `setTimeout` / `clearTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class DraftPoller {
  #opts: Required<DraftPollerOptions>;
  #handle: unknown = null;
  #running = false;
  #hidden = false;
  #inFlight = false;
  #consecutiveFailures = 0;
  #learnAttempts = 0;

  constructor(opts: DraftPollerOptions) {
    this.#opts = {
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...opts,
    };
  }

  /** Begin polling. Idempotent. Does an immediate first tick. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#learnAttempts = 0;
    this.#consecutiveFailures = 0;
    void this.#tick();
  }

  /** Stop polling and cancel any pending tick. Idempotent. */
  stop(): void {
    this.#running = false;
    this.#clearPending();
  }

  /** Tab hidden — pause the loop without losing "running" intent. */
  pause(): void {
    this.#hidden = true;
    this.#clearPending();
  }

  /**
   * Tab visible again — if we are meant to be running and the status still
   * warrants polling, refetch immediately and resume the cadence.
   */
  resume(): void {
    if (!this.#hidden) return;
    this.#hidden = false;
    if (this.#running) void this.#tick();
  }

  /** Test / introspection. */
  get isRunning(): boolean {
    return this.#running;
  }
  get isPaused(): boolean {
    return this.#hidden;
  }

  #clearPending(): void {
    if (this.#handle != null) {
      this.#opts.clearTimer(this.#handle);
      this.#handle = null;
    }
  }

  /** Max moderate re-checks to spend LEARNING a status before giving up. */
  static readonly #MAX_LEARN_ATTEMPTS = 8;

  #schedule(): void {
    const decision = pollDecision(this.#opts.getStatus());
    if (decision === "stop") {
      this.#running = false;
      return;
    }
    if (decision === "unknown") {
      if (this.#learnAttempts >= DraftPoller.#MAX_LEARN_ATTEMPTS) {
        this.#running = false;
        return;
      }
      this.#handle = this.#opts.setTimer(() => void this.#tick(), DRAFT_STATUS_POLL_MS);
      return;
    }
    const base = decision === "rapid" ? DRAFT_LIVE_POLL_MS : DRAFT_STATUS_POLL_MS;
    const delay =
      this.#consecutiveFailures > 0
        ? Math.min(base * 2 ** this.#consecutiveFailures, DRAFT_POLL_MAX_BACKOFF_MS)
        : base;
    this.#handle = this.#opts.setTimer(() => void this.#tick(), delay);
  }

  async #tick(): Promise<void> {
    this.#clearPending();
    if (!this.#running || this.#hidden) return;

    const decision = pollDecision(this.#opts.getStatus());
    if (decision === "stop") {
      this.#running = false;
      return;
    }
    if (decision === "unknown") {
      this.#learnAttempts += 1;
    } else {
      this.#learnAttempts = 0;
    }

    await this.#runPoll();
    if (!this.#running || this.#hidden) return;

    // Re-evaluate for the NEXT interval — the poll we just did may have changed
    // the status (pre_draft → drafting, drafting → complete).
    this.#schedule();
  }

  /** One poll attempt. Never throws; a failure just increments the backoff. */
  async #runPoll(): Promise<void> {
    if (this.#inFlight) return; // structural overlap guard
    this.#inFlight = true;
    try {
      await this.#opts.poll();
      this.#consecutiveFailures = 0;
    } catch {
      // A transient failure must NOT stop the loop or clear the board.
      this.#consecutiveFailures = Math.min(this.#consecutiveFailures + 1, 10);
    } finally {
      this.#inFlight = false;
    }
  }
}
