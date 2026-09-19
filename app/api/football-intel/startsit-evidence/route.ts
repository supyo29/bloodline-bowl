/**
 * GET /api/football-intel/startsit-evidence
 *
 * Diagnostic surface for the Start/Sit FI SHADOW model's evidence pipeline: evidence-gate state,
 * capture-store health/durability, and counts by capture class. READ-ONLY; reports no outcome
 * metrics; changes no deployment state.
 */
import { buildStartSitEvidenceReport } from "@/lib/weekly/start-sit-fi/evidence-report";
import { handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const report = await buildStartSitEvidenceReport();
  return jsonResponse(report, { status: 200, headers: { "Cache-Control": "no-store" } });
}

export function OPTIONS(): Response {
  return handleOptions();
}
