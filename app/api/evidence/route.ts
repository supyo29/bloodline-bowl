/**
 * GET /api/evidence?topic=<topic>&<params>[&history=1][&comparisons=1]
 * GET /api/evidence?capabilities=1
 *
 * Phase 3.5C — Book-Ready analytical retrieval. READ-ONLY. Returns structured EvidenceBlocks with source-native
 * values preserved, explicit units, independent confidence/sample/freshness/deployment axes, explicit comparison
 * populations, immutable history, and lineage. It never ranks decisions, writes prose, or activates a model.
 * History and comparison populations are opt-in; ordinary recommendation endpoints do not use this route.
 */
import { getCapabilities, getEvidence } from "@/lib/book-ready/query";
import { installMarketSnapshotCapture } from "@/lib/persistence/supabase/market-state";
import { installWaiver2Capture } from "@/lib/persistence/supabase/waiver2-capture-runtime";
import { handleOptions, jsonResponse } from "@/lib/http";

// Prospective Waiver 2.0 shadow-evidence telemetry (insert-only, never on the ranking path, never affects a response).
installWaiver2Capture();
installMarketSnapshotCapture();

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("capabilities")) return jsonResponse(getCapabilities(), { status: 200, headers: { "Cache-Control": "public, max-age=60" } });
  const topic = url.searchParams.get("topic");
  if (!topic) return jsonResponse({ status: "INVALID_REQUEST", detail: "topic is required; see ?capabilities=1", contract_version: "book-ready-evidence-2026.1" }, { status: 400 });
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (!["topic", "history", "comparisons", "capabilities"].includes(k)) params[k] = v;
  const res = await getEvidence({ topic, params, history: url.searchParams.get("history") === "1", comparisons: url.searchParams.get("comparisons") === "1" });
  const status = res.status === "OK" ? 200 : res.status === "UNKNOWN_TOPIC" ? 404 : 400;
  return jsonResponse(res, { status, headers: { "Cache-Control": "no-store" } });
}

export function OPTIONS(): Response {
  return handleOptions();
}
