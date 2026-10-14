/** GET /api/w2r1/manifest — W2.R1 current-intelligence layer status and model identity (no league data). */
import { jsonResponse } from "@/lib/http";
import { w2r1Enabled } from "@/lib/w2r1/guard";
import { BREAKOUT_NOTICE, STACK_LABEL, K_DST_NOTICE, LAYER_STATUS, DECISION_SUPPORT_STATEMENT, TACTICAL_NOTICE } from "@/lib/w2r1/live";
import { W2R1_RESEARCH_VERDICT } from "@/lib/w2r1/qualification";
import { CAPTURED_WEEKS } from "@/lib/w2r1/data/prospective";
import { W2R1_EVIDENCE_VERSION, W2R1_MODE, W2R1_MODEL_VERSION } from "@/lib/w2r1/version";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(): Promise<Response> {
  if (!w2r1Enabled()) return new Response("Not Found", { status: 404 });
  return jsonResponse({ label: STACK_LABEL, mode: W2R1_MODE, model_version: W2R1_MODEL_VERSION, evidence_version: W2R1_EVIDENCE_VERSION, layers: LAYER_STATUS, research_verdict: W2R1_RESEARCH_VERDICT, frozen_pregame_capture_weeks: CAPTURED_WEEKS, notices: { k_dst: K_DST_NOTICE, upside: BREAKOUT_NOTICE, tactical: TACTICAL_NOTICE }, decision_support: DECISION_SUPPORT_STATEMENT, writes_to_providers: false, views: ["roster", "player", "drop", "add", "kdst", "dst", "upside", "qualification", "compare"], example: "/api/w2r1/{league}/{manager}/roster?week=6" }, { headers: { "Cache-Control": "no-store" } });
}
