/**
 * A one-way TELEMETRY hook: the evaluation path calls `runWaiver2CaptureHook` AFTER it has finished evaluating. The durable
 * implementation is installed by the server route at startup (lib/persistence). With no hook installed (tests, in-process research,
 * local scripts) nothing is written. The hook receives the finished evaluation by value-of-reference and can neither change it nor
 * fail the caller: every error is swallowed here and counted by the installed implementation's health.
 */
import type { WaiverEvaluation, WaiverInput } from "./types";
export interface CaptureMeta { league_slug: string; manager_slug: string; season: number; illustrative: boolean }
export type Waiver2CaptureHook = (ev: WaiverEvaluation, input: WaiverInput, meta: CaptureMeta) => Promise<unknown>;
let hook: Waiver2CaptureHook | null = null;
export function installWaiver2CaptureHook(h: Waiver2CaptureHook | null): void { hook = h; }
export const waiver2CaptureHookInstalled = (): boolean => hook !== null;
export async function runWaiver2CaptureHook(ev: WaiverEvaluation, input: WaiverInput, meta: CaptureMeta): Promise<void> {
  if (!hook) return;
  try { await hook(ev, input, meta); } catch { /* telemetry must never affect the response; the implementation counts failures */ }
}
