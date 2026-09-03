/**
 * Thin shared glue for the four post-draft-intelligence routes — parsing,
 * status-code mapping, response envelope. No analytical logic here.
 */

import { errorResponse, jsonResponse, cacheHeader } from "@/lib/http";
import type { NextResponse } from "next/server";
import type { ContextView } from "./intelligence";

export function parseWeek(raw: string): { ok: true; week: number } | { ok: false; response: NextResponse } {
  const week = Number.parseInt(raw, 10);
  if (!Number.isInteger(week) || week < 1 || week > 22) {
    return { ok: false, response: errorResponse(400, "invalid_week", "week must be an integer 1..22.") };
  }
  return { ok: true, week };
}

export function viewResponse<T>(view: ContextView<T>, contextLabel: string): NextResponse {
  if (!view.data) {
    if (view.code === "AUTH_REQUIRED" || view.code === "NOT_CONFIGURED") {
      return jsonResponse(
        { status: view.code, detail: view.detail, data: null },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    return errorResponse(view.status, view.code ?? "weekly_context_unavailable", view.detail);
  }
  const meta = view.context_meta!;
  const healthy = meta.status === "READY";
  return jsonResponse(
    { status: meta.status, context: meta, data: view.data },
    {
      headers: {
        "Cache-Control": healthy ? cacheHeader(120, 300) : cacheHeader(45, 120),
        "X-Bridge-Context": contextLabel,
      },
    },
  );
}
