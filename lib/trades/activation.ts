/**
 * Trade Engine — Phase 3.5A: server-side-only activation gate.
 *
 * `resolvePhase3CalibrationMode` is the single place that decides whether
 * Phase 3's calibrated weights could ever be anything other than shadow-mode
 * diagnostics. It reads ONLY environment configuration — never a request
 * body (see `sanitizePublicTradeConfig` in `lib/trades/config.ts`, which
 * unconditionally drops a client-supplied `config.phase3` before it reaches
 * `analyzeTrade`) — so no API caller can promote itself into a live-weighted
 * evaluation.
 *
 * Phase 3.5 hard gate: even if an operator's environment sets `PRODUCTION`,
 * no signal has cleared the calibration-readiness bar yet (see
 * `lib/trades/data-readiness.ts`) — `PRODUCTION` is refused and downgraded to
 * `SHADOW`. Remove that downgrade only after a specific signal is promoted
 * with documented ablation evidence from a real dataset, and update
 * `docs/TRADE_ENGINE_PHASE35_DATA_READINESS.md` accordingly.
 */

export type Phase3CalibrationMode = "SHADOW" | "INTERNAL_VALIDATION" | "PRODUCTION";

export function resolvePhase3CalibrationMode(env: Record<string, string | undefined> = process.env): Phase3CalibrationMode {
  const raw = env.PHASE3_CALIBRATION_MODE;
  if (raw === "INTERNAL_VALIDATION") return raw; // allowed for internal/offline validation runs only
  // absent, "SHADOW", "PRODUCTION", or any unrecognized value all resolve to SHADOW —
  // PRODUCTION is explicitly refused in Phase 3.5 regardless of what the environment requests.
  return "SHADOW";
}
