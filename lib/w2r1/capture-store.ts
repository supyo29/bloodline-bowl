/** W2.R1 S8: pure row builder for supabase/migrations/20261014120000_w2r1_prospective_captures.sql (the migration is NOT applied; nothing here writes to a database). */
import { CAPTURE_KINDS, payloadHash, sha256, type CaptureKind } from "./capture";
export interface CaptureRow { capture_id: string; kind: CaptureKind; season: number; week: number; league_slug: string; manager_slug: string; first_kickoff_at: string; captured_at: string; payload_sha256: string; model_artifact_hashes: Record<string, unknown>; qualification: Record<string, unknown>; record: Record<string, unknown> }
export function captureRow(a: { kind: CaptureKind; season: number; week: number; league?: string; manager?: string; firstKickoffAt: string; capturedAt: string; payload: unknown; modelArtifactHashes: Record<string, unknown>; qualification: Record<string, unknown> }): CaptureRow {
  if (!CAPTURE_KINDS.includes(a.kind)) throw new Error(`unknown capture kind ${a.kind}`);
  if (Date.parse(a.capturedAt) >= Date.parse(a.firstKickoffAt)) throw new Error("capture is not pregame");
  const league = a.league ?? "*", manager = a.manager ?? "*", ph = payloadHash(a.payload);
  const id = `w2c:${sha256(`${a.season}|${a.week}|${a.kind}|${league}|${manager}|${ph}`).slice(0, 16)}`;
  return { capture_id: id, kind: a.kind, season: a.season, week: a.week, league_slug: league, manager_slug: manager, first_kickoff_at: a.firstKickoffAt, captured_at: a.capturedAt, payload_sha256: ph, model_artifact_hashes: a.modelArtifactHashes, qualification: a.qualification, record: { mode: "SHADOW_ONLY", may_influence_production: "false", payload: a.payload } };
}
