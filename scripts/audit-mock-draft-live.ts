/**
 * LIVE mock-draft rehearsal audit — inspect a Sleeper draft's state before (or
 * during) a rehearsal. READ-ONLY: fetches `/v1/draft/<id>` and
 * `/v1/draft/<id>/picks`, applies the Bloodline geometry frame, and prints
 * exactly what the recommendation override would consume, plus a PASS / DEGRADED
 * / FAIL verdict.
 *
 *   npx tsx scripts/audit-mock-draft-live.ts --draft-id 1396600871957061632 --slot 7
 *
 * It alters nothing. Use it to confirm a draft id is a genuinely followable,
 * in-progress board before pointing the preview endpoint at it.
 */

import { getDraftLive, getDraftPicksLive, getPlayerIndex } from "@/lib/sleeper/client";
import { deriveMockDraftState } from "@/lib/draft/mock-draft";
import { computeSnakeTurnState } from "@/lib/draft/geometry";

const BLOODLINE_TEAMS = 12;
const BLOODLINE_ROUNDS = 15;
const SUPYO_USER_ID = "1308955807408230400";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

async function main(): Promise<void> {
  const draftId = arg("draft-id");
  const slotArg = arg("slot");
  if (!draftId || !/^\d{1,25}$/.test(draftId)) {
    console.error("usage: npx tsx scripts/audit-mock-draft-live.ts --draft-id <numeric> [--slot <1..32>]");
    process.exit(2);
  }
  const requestedSlot = slotArg ? Number(slotArg) : null;

  console.log(`\n=== LIVE MOCK-DRAFT AUDIT — draft ${draftId} ===`);
  console.log(`Bloodline frame: ${BLOODLINE_TEAMS} teams × ${BLOODLINE_ROUNDS} rounds = ${BLOODLINE_TEAMS * BLOODLINE_ROUNDS} picks\n`);

  const t0 = Date.now();
  const [meta, picks, playerIndex] = await Promise.all([
    getDraftLive(draftId).catch((e) => {
      console.error(`FAILED to fetch /v1/draft/${draftId}: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }),
    getDraftPicksLive(draftId).catch(() => []),
    getPlayerIndex(),
  ]);

  const state = deriveMockDraftState({
    meta, picks, playerIndex,
    managerUserId: SUPYO_USER_ID,
    requestedDraftId: draftId,
    requestedSlot,
    numTeams: BLOODLINE_TEAMS,
    rounds: BLOODLINE_ROUNDS,
  });
  const d = state.diagnostics;
  const turn = computeSnakeTurnState({
    slot: state.applied_slot,
    teamCount: BLOODLINE_TEAMS,
    rounds: BLOODLINE_ROUNDS,
    overallPicksMade: state.completed_picks.length,
    order: meta.type === "linear" ? "linear" : "snake",
  });

  console.log("SOURCE METADATA");
  console.log(`  status ............ ${d.source_status}`);
  console.log(`  type .............. ${d.source_type}`);
  console.log(`  configured ........ ${d.source_teams} teams / ${d.source_rounds} rounds`);
  console.log(`  created ........... ${d.source_created_iso}`);
  console.log(`  last_picked ....... ${d.source_last_picked_iso}`);
  console.log(`  draft_id echoed ... ${d.draft_id}${d.draft_id === draftId ? "" : "  ⚠ MISMATCH"}`);

  console.log("\nPICK FRAMING (Bloodline 15-round frame)");
  console.log(`  raw picks ......... ${d.raw_pick_count}   (max pick_no ${d.raw_max_pick_no})`);
  console.log(`  framed picks ...... ${d.framed_pick_count}   (max pick_no ${d.framed_max_pick_no})`);
  console.log(`  discarded ......... ${d.picks_discarded_outside_frame}   (rounds ${BLOODLINE_ROUNDS + 1}+ of the mock)`);

  console.log("\nMANAGER (supyo29)");
  console.log(`  applied slot ...... ${d.applied_slot}   (source: ${d.slot_source})`);
  console.log(`  expected picks .... ${d.manager_expected_pick_numbers.join(", ")}`);
  console.log(`  source picks ...... ${d.manager_source_picks.join(", ") || "(none yet)"}`);
  console.log(`  roster count ...... ${d.manager_roster_count}`);
  console.log(`  roster ............ ${state.roster_players.map((p) => p.full_name).join(", ") || "(empty)"}`);
  console.log(`  own_picks_made .... ${turn.own_picks_made}`);
  console.log(`  current pick ...... ${turn.current_pick ? `overall ${turn.current_pick.overall} (round ${turn.current_pick.round})` : "NONE — no picks left in the Bloodline frame"}`);
  console.log(`  next manager pick . ${turn.next_manager_pick ? `overall ${turn.next_manager_pick.overall}` : "—"}`);

  console.log("\nRECENT PICKS (last 5, framed)");
  for (const p of d.recent_picks) {
    console.log(`  #${String(p.pick_no).padStart(3)}  slot ${String(p.draft_slot).padStart(2)}  ${p.player_name} (${p.player_id})`);
  }
  if (d.recent_picks.length === 0) console.log("  (none)");

  console.log("\nSOURCE VALIDATION");
  console.log(`  state_validation .. ${d.state_validation}`);
  for (const r of d.validation_reasons) console.log(`    - ${r}`);

  const followable =
    d.state_validation !== "INVALID" &&
    d.source_status !== "complete" &&
    turn.current_pick != null;

  let verdict: string;
  if (d.state_validation === "INVALID") verdict = "FAIL — source is INVALID; recommendations are withheld";
  else if (d.source_status === "complete" || turn.current_pick == null)
    verdict = "FAIL — this draft is finished; it cannot be followed pick-by-pick. Start a fresh in-progress Sleeper draft.";
  else if (d.state_validation === "DEGRADED")
    verdict = "DEGRADED — followable, but read the validation reasons above (framing caveats apply)";
  else verdict = "PASS — in-progress, geometry-consistent, safe to rehearse against";

  console.log(`\n=== VERDICT: ${verdict} ===`);
  console.log(`(audit read ${d.raw_pick_count} picks in ${Date.now() - t0}ms; altered nothing)\n`);
  process.exit(followable && d.state_validation !== "INVALID" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
