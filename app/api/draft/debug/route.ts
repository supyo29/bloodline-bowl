/**
 * GET /api/draft/debug — sanitized view of the raw Sleeper draft fields.
 *
 * Exists to troubleshoot auction metadata (notably `metadata.amount`, which
 * Sleeper does not document). It exposes only the selected draft's own fields
 * plus a small sample of raw picks — no arbitrary proxying, and no parameters.
 * Safe to delete: nothing else imports it.
 */

import {
  SleeperError,
  getDraft,
  getDraftPicks,
  getLeagueDrafts,
} from "@/lib/sleeper/client";
import { selectActiveDraft } from "@/lib/sleeper/draft";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** How many raw picks to include; enough to inspect metadata shape. */
const SAMPLE_SIZE = 3;

export async function GET(): Promise<Response> {
  const leagueId = resolveLeagueId();

  try {
    const drafts = await getLeagueDrafts(leagueId);
    const selected = selectActiveDraft(drafts);

    if (!selected) {
      return jsonResponse(
        { league_id: leagueId, draft: null, note: "No draft found." },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const [draft, picks] = await Promise.all([
      getDraft(selected.draft_id, { noStore: true }),
      getDraftPicks(selected.draft_id, { noStore: true }),
    ]);

    const samplePicks = picks.slice(0, SAMPLE_SIZE);

    return jsonResponse(
      {
        league_id: leagueId,
        draft_count: drafts.length,
        selected_draft_id: selected.draft_id,
        draft: {
          status: draft.status,
          type: draft.type,
          season: draft.season,
          settings: draft.settings,
          metadata: draft.metadata,
          slot_to_roster_id: draft.slot_to_roster_id,
          draft_order: draft.draft_order,
          last_picked: draft.last_picked,
        },
        picks: {
          total: picks.length,
          // Which metadata keys Sleeper actually returns on a pick.
          metadata_keys_seen: [
            ...new Set(
              picks.flatMap((pick) => Object.keys(pick.metadata ?? {})),
            ),
          ].sort(),
          has_amount_field: picks.some(
            (pick) => typeof pick.metadata?.amount === "string",
          ),
          sample: samplePicks,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SleeperError) {
      return errorResponse(502, "sleeper_upstream_error", error.message);
    }
    return errorResponse(
      500,
      "internal_error",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
