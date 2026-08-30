/**
 * Draft Bridge — ChatGPT snapshot builder.
 *
 * Produces a single self-identifying JSON document that can be dropped into a
 * brand-new ChatGPT conversation with no prior history and still answer
 * "WHICH LEAGUE IS THIS?" with certainty.
 *
 * Fail-closed: `buildBridgeSnapshot` throws `BridgeExportError` when the active
 * league, the freshly-fetched board, and the local draft state do not all agree
 * on which league is being exported, or when the league's live scoring identity
 * has drifted away from what the draft state was built against, or when a
 * supplied model identity does not belong to the league.
 */

import { computeRosterNeeds, type RosterNeeds } from "@/lib/sleeper/draft";
import type { NormalizedPlayer } from "@/lib/sleeper/types";
import { computeDraftGeometry, type DraftGeometry } from "./geometry";
import { BRIDGE_SCHEMA_VERSION } from "./profiles";
import type { BridgeBoardResponse, BoardPlayer } from "./board";
import {
  minePlayerIds,
  overallPicksMade,
  type BridgeDraftState,
} from "./state";

export class BridgeExportError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "BridgeExportError";
    this.code = code;
    this.detail = detail;
  }
}

export interface CrossCheck {
  active_league_key: string;
  board_league_key: string;
  state_league_key: string;
  scoring_hash_expected: string | null;
  scoring_hash_live: string;
  scoring_hash_match: boolean;
  draft_source_check: "ok" | "DRAFT_SOURCE_LEAGUE_MISMATCH";
  model_identity_check: "ok" | "LEAGUE_MODEL_IDENTITY_MISMATCH";
  verdict: "PASS" | "BLOCKED";
}

export interface BuildSnapshotInput {
  /** What the UI currently believes is the active league. */
  activeLeagueKey: string;
  /** Freshly fetched board for the league being exported. */
  board: BridgeBoardResponse;
  /** The local draft state for that league. */
  state: BridgeDraftState;
  /**
   * Optional expected model identity. When given and it does not match the
   * board's league, the export is blocked (`LEAGUE_MODEL_IDENTITY_MISMATCH`).
   * Used to prove the wrong-model rejection path.
   */
  expectedModel?: {
    league_key?: string;
    candidate_id?: string | null;
  };
  /** How many best-available / best-for-my-team rows to include. */
  bestAvailableCount?: number;
  bestForMyTeamCount?: number;
  now?: string;
}

/**
 * Run the pre-export cross-check WITHOUT building the snapshot. Returns the
 * detail so the UI can show exactly why an export is blocked.
 */
export function crossCheckExport(input: BuildSnapshotInput): CrossCheck {
  const { activeLeagueKey, board, state } = input;
  const boardKey = board.league_identity.league_key;

  const scoringExpected = state.scoring_sha;
  const scoringLive = board.scoring.scoring_sha256;
  const scoringMatch =
    scoringExpected == null || scoringExpected === scoringLive;

  const draftSourceOk = board.draft_feed.source_check.ok;

  let modelOk = true;
  if (input.expectedModel) {
    if (
      input.expectedModel.league_key != null &&
      input.expectedModel.league_key !== boardKey
    ) {
      modelOk = false;
    }
    if (
      input.expectedModel.candidate_id !== undefined &&
      input.expectedModel.candidate_id !== board.model_profile.candidate_id
    ) {
      modelOk = false;
    }
  }

  const verdict: "PASS" | "BLOCKED" =
    activeLeagueKey === boardKey &&
    state.league_key === boardKey &&
    scoringMatch &&
    draftSourceOk &&
    modelOk
      ? "PASS"
      : "BLOCKED";

  return {
    active_league_key: activeLeagueKey,
    board_league_key: boardKey,
    state_league_key: state.league_key,
    scoring_hash_expected: scoringExpected,
    scoring_hash_live: scoringLive,
    scoring_hash_match: scoringMatch,
    draft_source_check: draftSourceOk ? "ok" : "DRAFT_SOURCE_LEAGUE_MISMATCH",
    model_identity_check: modelOk ? "ok" : "LEAGUE_MODEL_IDENTITY_MISMATCH",
    verdict,
  };
}

function asNormalized(
  playerId: string,
  meta: { name: string; position: string | null; fantasy_positions: string[] } | null,
): NormalizedPlayer {
  return {
    player_id: playerId,
    full_name: meta?.name ?? playerId,
    first_name: null,
    last_name: null,
    position: meta?.position ?? null,
    fantasy_positions: meta?.fantasy_positions ?? [],
    team: null,
    age: null,
    years_exp: null,
    status: null,
    injury_status: null,
    number: null,
    active: null,
    search_rank: null,
    resolved: meta != null,
  };
}

function neededPositions(needs: RosterNeeds, flexPositions: string[]): Set<string> {
  const wanted = new Set<string>();
  for (const req of needs.required) wanted.add(req.position);
  if (needs.flexible_slots_remaining > 0) {
    for (const p of flexPositions) wanted.add(p);
  }
  return wanted;
}

export interface BridgeSnapshot {
  schema_version: string;
  snapshot_title: string;
  generated_at: string;
  league_identity: Record<string, unknown>;
  model: Record<string, unknown>;
  ranking_quality: Record<string, unknown>;
  ranking_pack: Record<string, unknown> | null;
  league_rules: Record<string, unknown>;
  draft_state: Record<string, unknown>;
  best_available_overall: Array<Record<string, unknown>>;
  best_available_by_position: Record<string, Array<Record<string, unknown>>>;
  best_for_my_team: Array<Record<string, unknown>>;
  analysis_instructions: Record<string, unknown>;
  integrity: CrossCheck;
}

const POSITION_DEPTH: Record<string, number> = {
  QB: 8,
  RB: 12,
  WR: 12,
  TE: 8,
  K: 5,
  DEF: 5,
};

function positionCounts(
  players: Array<{ position: string | null; fantasy_positions?: string[] }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of players) {
    const pos = p.position ?? "UNK";
    counts[pos] = (counts[pos] ?? 0) + 1;
  }
  return counts;
}

/** Build the snapshot, or throw `BridgeExportError` if the cross-check fails. */
export function buildBridgeSnapshot(input: BuildSnapshotInput): BridgeSnapshot {
  const check = crossCheckExport(input);
  if (check.verdict === "BLOCKED") {
    const reason =
      check.active_league_key !== check.board_league_key
        ? `ACTIVE_LEAGUE_MISMATCH (active ${check.active_league_key} vs board ${check.board_league_key})`
        : check.state_league_key !== check.board_league_key
          ? `LEAGUE_STATE_KEY_MISMATCH (state ${check.state_league_key} vs board ${check.board_league_key})`
          : !check.scoring_hash_match
            ? `LEAGUE_SCORING_PROFILE_MISMATCH (state built against ${check.scoring_hash_expected}, live ${check.scoring_hash_live})`
            : check.draft_source_check !== "ok"
              ? `DRAFT_SOURCE_LEAGUE_MISMATCH (${input.board.draft_feed.source_check.ok ? "" : input.board.draft_feed.source_check.detail})`
              : `LEAGUE_MODEL_IDENTITY_MISMATCH`;
    throw new BridgeExportError("BRIDGE_EXPORT_BLOCKED", reason);
  }

  const now = input.now ?? new Date().toISOString();
  const { board, state } = input;
  const id = board.league_identity;
  const rules = board.rules;

  const order = board.draft_feed.order;
  const slot = id.draft_slot;
  const picksMade = Math.max(
    overallPicksMade(state),
    board.draft_feed.overall_picks_made,
  );

  let geometry: DraftGeometry | null = null;
  if (slot != null && id.draft_type !== "auction") {
    try {
      geometry = computeDraftGeometry({
        slot,
        teamCount: rules.team_count,
        rounds: rules.rounds,
        overallPicksMade: picksMade,
        order,
      });
    } catch {
      geometry = null;
    }
  }

  /* ---- ranking source ------------------------------------------------ */

  const rq = board.ranking_quality;
  const modelActive = board.model_profile.ranking_source === "model_pack";
  const isFallback = board.model_profile.ranking_source === "sleeper_fallback";

  /* ---- my team + needs ------------------------------------------------ */

  const mineIds = minePlayerIds(state);
  const packById = new Map(
    (board.ranking_pack ? board.pool : []).map((p) => [p.player_id, p]),
  );
  const myTeam = mineIds.map((playerId) => {
    const entry = state.entries[playerId];
    const packRow = packById.get(playerId);
    return {
      player_id: playerId,
      name: entry?.player?.name ?? playerId,
      position: entry?.player?.position ?? null,
      nfl_team: entry?.player?.team ?? null,
      pick_no: entry?.pick_no ?? null,
      round: entry?.round ?? null,
      confirmation: entry?.source === "sleeper_sync" ? "confirmed" : "manual",
      model_overall_rank: modelActive ? (packRow?.model_rank ?? null) : null,
      model_tier: modelActive ? (packRow?.model_tier ?? null) : null,
    };
  });

  const myNormalized = mineIds.map((playerId) =>
    asNormalized(playerId, state.entries[playerId]?.player ?? null),
  );
  const needs = computeRosterNeeds(myNormalized, rules.roster_positions);
  const myCounts = positionCounts(
    mineIds.map((pid) => ({ position: state.entries[pid]?.player?.position ?? null })),
  );
  const rosterStatus = {
    QB: myCounts.QB ?? 0,
    RB: myCounts.RB ?? 0,
    WR: myCounts.WR ?? 0,
    TE: myCounts.TE ?? 0,
    K: myCounts.K ?? 0,
    DEF: (myCounts.DEF ?? 0) + (myCounts.DST ?? 0),
    picks_made: mineIds.length,
    picks_remaining: Math.max(0, rules.rounds - mineIds.length),
    open_starters: needs.required.flatMap((r) =>
      Array.from({ length: r.minimum_needed }, () => r.position),
    ),
    open_flex_slots: needs.flexible_slots_remaining,
    open_bench_slots: needs.bench_slots_remaining,
  };

  /* ---- best available / best for my team --------------------------- */

  const draftedSet = new Set(Object.keys(state.entries));
  const availablePool = board.pool.filter((p) => !draftedSet.has(p.player_id));

  const wanted = neededPositions(needs, rules.flex_positions);
  const rosterFit = (p: BoardPlayer): string => {
    const positions = [p.position, ...p.fantasy_positions].filter(
      (x): x is string => x != null,
    );
    const strictNeed = needs.required.find((r) => positions.includes(r.position));
    if (strictNeed) return "OPEN STARTER";
    if (needs.flexible_slots_remaining > 0 && positions.some((x) => wanted.has(x))) {
      return "FLEX ELIGIBLE";
    }
    if ((p.position === "K" || p.position === "DEF") && rosterStatus[p.position] === 0) {
      return "LATE REQUIRED POSITION";
    }
    if (positions.some((x) => rosterStatus[x as "RB"] != null && rosterStatus[x as "RB"] > 0)) {
      return "POSITION FILLED — DEPTH / VALUE";
    }
    return "BEST OVERALL VALUE";
  };

  const bestAvailableOverall = availablePool
    .slice(0, input.bestAvailableCount ?? 30)
    .map((p) => toSnapshotPlayer(p, board, rosterFit(p)));

  const bestAvailableByPosition: Record<string, Array<Record<string, unknown>>> = {};
  for (const [pos, depth] of Object.entries(POSITION_DEPTH)) {
    bestAvailableByPosition[pos] = availablePool
      .filter((p) => [p.position, ...p.fantasy_positions].includes(pos))
      .slice(0, depth)
      .map((p) => toSnapshotPlayer(p, board, rosterFit(p)));
  }

  const bestForMyTeamPool =
    wanted.size === 0
      ? availablePool
      : availablePool.filter((p) =>
          [p.position, ...p.fantasy_positions].some(
            (pos): pos is string => pos != null && wanted.has(pos),
          ),
        );
  const bestForMyTeam = bestForMyTeamPool
    .slice(0, input.bestForMyTeamCount ?? 15)
    .map((p) => toSnapshotPlayer(p, board, rosterFit(p)));

  /* ---- recent picks + position runs -------------------------------- */

  const allEntriesByRecency = Object.entries(state.entries)
    .map(([playerId, entry]) => ({
      player_id: playerId,
      name: entry.player?.name ?? playerId,
      position: entry.player?.position ?? null,
      status: entry.status,
      pick_no: entry.pick_no,
      by_slot: entry.by_slot,
      at: entry.at,
    }))
    .sort((a, b) => {
      const pa = a.pick_no ?? -1;
      const pb = b.pick_no ?? -1;
      if (pa !== pb) return pb - pa;
      return b.at.localeCompare(a.at);
    });
  const recentPicks = allEntriesByRecency.slice(0, 15);
  const recentBoardContext = {
    last_15: recentPicks,
    position_counts_last_6: positionCounts(allEntriesByRecency.slice(0, 6)),
    position_counts_last_12: positionCounts(allEntriesByRecency.slice(0, 12)),
  };

  /* ---- state quality --------------------------------------------- */

  const syncedCount = Object.values(state.entries).filter(
    (e) => e.source === "sleeper_sync",
  ).length;
  const stateQuality = {
    mode:
      syncedCount > 0 && syncedCount === Object.keys(state.entries).length
        ? "SYNCED"
        : syncedCount > 0
          ? "MIXED_SYNC_AND_MANUAL"
          : "MANUAL_PROVISIONAL",
    sleeper_draft_status: board.draft_feed.status,
    manual_marks: Object.keys(state.entries).length - syncedCount,
    synced_marks: syncedCount,
    note:
      syncedCount === 0
        ? "All picks entered manually — board state is provisional and depends on the user keeping up."
        : "Some picks reconciled from Sleeper's live draft feed.",
  };

  /* ---- title + instructions --------------------------------------- */

  const nextPickText = geometry?.next_pick
    ? `Pick ${geometry.next_pick.overall}`
    : "Next Pick";
  const snapshotTitle =
    `${id.short_label} — ${id.season} Draft — Slot ${slot ?? "?"} — ${nextPickText} Analysis`;

  const analysisInstructions = {
    league_name: id.league_name,
    also_known_as: id.display_label,
    manager_name: id.manager_display_name,
    primary_question: `Who should ${id.manager_display_name} draft next in ${id.league_name}?`,
    task: `Recommend ${id.manager_display_name}'s next draft pick for ${id.league_name} (${id.season}), draft slot ${slot ?? "unknown"}.`,
    rules: [
      `Analyze only the ${id.league_name} league (league_key "${id.league_key}", Sleeper league ${id.platform_league_id}). Do not apply any other league's scoring, rankings, roster rules, or draft state.`,
      modelActive
        ? `Use the ${rq.source_label} rankings and tiers (model_overall_rank / model_tier / model_value) as the PRIMARY model evidence.`
        : isFallback
          ? `WARNING: the ${id.manager_display_name} model ranking pack is NOT active (ranking_quality.status = FALLBACK). Rankings below are Sleeper search_rank only. Treat them as rough market context, not a model.`
          : `Ranking source is ${rq.source_label}.`,
      modelActive
        ? "Use sleeper_search_rank and adp only as SECONDARY market context."
        : "There is no separate model ranking to weigh against the market ordering.",
      "Use the rankings, tiers, and roster_fit exactly as given in this snapshot.",
      "Consider the manager's current roster (my_team / roster_status) and open starters.",
      "Consider available-player tier cliffs and draft geometry (next_pick, wait_after_next).",
      board.opponent_modeling.exclude_own_historical_profile
        ? "Do NOT constrain the recommendation to the manager's own past drafting tendencies."
        : "Opponent-history modeling is not included in this snapshot.",
      "Return one primary selection plus at least three pivots. State whether each is best value, roster fit, or both.",
      "Flag any uncertainty caused by provisional / manual draft state (see draft_state.state_quality).",
    ],
  };

  /* ---- assemble --------------------------------------------------- */

  return {
    schema_version: BRIDGE_SCHEMA_VERSION,
    snapshot_title: snapshotTitle,
    generated_at: now,
    league_identity: {
      league_key: id.league_key,
      league_name: id.league_name,
      display_label: id.display_label,
      season: id.season,
      platform: "Sleeper",
      platform_league_id: id.platform_league_id,
      draft_id: id.platform_draft_id,
      manager_key: id.manager_key,
      manager_display_name: id.manager_display_name,
      manager_sleeper_user_id: id.manager_sleeper_user_id,
      draft_slot: slot,
      draft_slot_source: id.draft_slot_source,
      team_count: id.team_count,
      draft_type: id.draft_type,
      model_profile: `${id.league_key}/${board.model_profile.ranking_source}`,
    },
    model: {
      candidate_id: board.model_profile.candidate_id,
      candidate_verified: board.model_profile.candidate_verified,
      candidate_source: board.model_profile.candidate_source,
      survival_engine: board.model_profile.survival_engine,
      ranking_source: board.model_profile.ranking_source,
      ranking_source_detail: modelActive
        ? `${rq.source_label} — external draft model consumed as a ranking pack.`
        : isFallback
          ? "Sleeper search_rank — FALLBACK. The league's model ranking pack failed to activate."
          : board.model_profile.ranking_source === "custom_upload"
            ? "User-supplied rankings file loaded for this league."
            : "Sleeper search_rank (relevance ordering). Not a projection or survival model.",
      scoring_profile: {
        provider: board.scoring.provider,
        scoring_sha256: board.scoring.scoring_sha256,
        captured_at: board.scoring.captured_at,
        ppr_label: board.scoring.ppr_label,
        rec_points: board.scoring.rec_points,
        passing_td_points: board.scoring.passing_td_points,
      },
      declared: {
        projection_sha: board.model_profile.declared_projection_sha,
        scoring_sha: board.model_profile.declared_scoring_sha,
        config_sha: board.model_profile.declared_config_sha,
        note: "Owner-declared identifiers; NOT verified against a repo artifact.",
      },
      ranking_fallback_active:
        board.model_profile.ranking_fallback_active,
      notes: board.model_profile.notes,
    },
    ranking_quality: {
      status: rq.status,
      source: rq.source_label,
      warning: rq.warning,
    },
    ranking_pack: board.ranking_pack
      ? {
          pack_id: board.ranking_pack.pack_id,
          model_version: board.ranking_pack.model_version,
          source: board.ranking_pack.source,
          source_artifact: board.ranking_pack.source_artifact,
          source_project: board.ranking_pack.source_project,
          source_board_sha256: board.ranking_pack.source_board_sha256,
          generated_at: board.ranking_pack.generated_at,
          model_release_gate: board.ranking_pack.model_release_gate,
          model_release_note: board.ranking_pack.model_release_note,
          verification: {
            status: board.ranking_pack.status,
            scoring_status: board.ranking_pack.scoring_status,
            roster_status: board.ranking_pack.roster_status,
            verified: board.ranking_pack.verified,
            verified_note: board.ranking_pack.verified_note,
            reasons: board.ranking_pack.reasons,
            player_count: board.ranking_pack.player_count,
            matched_to_available_pool: board.ranking_pack.matched_to_pool,
            missing_from_sleeper: board.ranking_pack.missing_from_sleeper,
            top_players_off_board: board.ranking_pack.top_players_off_board,
          },
        }
      : null,
    league_rules: {
      teams: rules.team_count,
      draft_type: rules.draft_type,
      draft_slot: slot,
      rounds: rules.rounds,
      starters: rules.starters,
      bench: rules.bench,
      reserve: rules.reserve,
      flex_positions: rules.flex_positions,
      roster_positions: rules.roster_positions,
      scoring_profile: board.scoring.provider,
      scoring_hash: board.scoring.scoring_sha256,
      live_rules_match_frozen_profile: rules.matches_profile,
    },
    draft_state: {
      state_quality: stateQuality,
      overall_picks_made: picksMade,
      drafted_count: Object.keys(state.entries).length,
      last_updated_at: state.updated_at,
      geometry: geometry
        ? {
            next_pick: geometry.next_pick,
            following_pick: geometry.following_pick,
            picks_until_next: geometry.picks_until_next,
            wait_after_next: geometry.wait_after_next,
            current_round: geometry.current_round,
            own_picks_made: geometry.own_picks_made,
            all_my_picks: geometry.all_picks,
          }
        : { note: "No pick geometry (slot unconfirmed or auction draft)." },
      my_team: myTeam,
      roster_status: rosterStatus,
      my_roster_needs: needs,
      recent_board_context: recentBoardContext,
    },
    best_available_overall: bestAvailableOverall,
    best_available_by_position: bestAvailableByPosition,
    best_for_my_team: bestForMyTeam,
    analysis_instructions: analysisInstructions,
    integrity: check,
  };
}

function toSnapshotPlayer(
  p: BoardPlayer,
  board: BridgeBoardResponse,
  rosterFit: string,
): Record<string, unknown> {
  const modelActive = board.model_profile.ranking_source === "model_pack";
  return {
    name: p.name,
    position: p.position,
    team: p.team,
    player_id: p.player_id,
    injury_status: p.injury_status,
    rank: p.rank,
    tier: p.tier,
    model_overall_rank: modelActive ? p.model_rank : null,
    model_position_rank: modelActive ? p.model_pos_rank : null,
    model_tier: modelActive ? p.model_tier : null,
    model_value: p.model_value,
    market_adp: p.market_adp,
    sleeper_search_rank: p.sleeper_search_rank,
    model_action: p.model_action,
    model_note: p.model_note,
    roster_fit: rosterFit,
    flags: [
      ...(p.injury_status ? [p.injury_status] : []),
      ...(p.model_action === "FADE / PRICE" ? ["MARKET_PRICE_WARNING"] : []),
      ...(p.model_action === "TARGET / VALUE" ? ["MODEL_VALUE"] : []),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Plain-text companion summary                                                */
/* -------------------------------------------------------------------------- */

/** A short human-readable `.txt` companion. JSON stays authoritative. */
export function renderSnapshotText(snapshot: BridgeSnapshot): string {
  const id = snapshot.league_identity as Record<string, unknown>;
  const ds = snapshot.draft_state as Record<string, unknown>;
  const geo = (ds.geometry ?? {}) as Record<string, unknown>;
  const nextPick = geo.next_pick as { overall?: number; round?: number } | null;
  const myTeam = (ds.my_team ?? []) as Array<Record<string, unknown>>;
  const rs = (ds.roster_status ?? {}) as Record<string, unknown>;
  const rq = snapshot.ranking_quality as Record<string, unknown>;
  const quality = (ds.state_quality ?? {}) as Record<string, unknown>;
  const openStarters = (rs.open_starters as string[] | undefined) ?? [];

  const lines: string[] = [];
  lines.push(`LEAGUE: ${String(id.league_name).toUpperCase()}`);
  lines.push(`ALSO KNOWN AS: ${id.display_label}`);
  lines.push(`SEASON: ${id.season}   PLATFORM: Sleeper ${id.platform_league_id}`);
  lines.push(`MANAGER: ${id.manager_display_name}   SLOT: ${id.draft_slot}`);
  lines.push(`DRAFT: ${id.draft_type}, ${id.team_count} teams`);
  lines.push(`RANKING SOURCE: ${rq.source}`);
  if (rq.warning) lines.push(`!! ${rq.warning}`);
  lines.push(`BOARD STATUS: ${quality.mode ?? "?"}`);
  lines.push(
    `SCORING HASH: ${String((snapshot.league_rules as Record<string, unknown>).scoring_hash).slice(0, 16)}…`,
  );
  lines.push("");
  lines.push(
    `NEXT PICK: ${nextPick?.overall ?? "?"} (round ${nextPick?.round ?? "?"})   ` +
      `PICKS UNTIL: ${geo.picks_until_next ?? "?"}   WAIT AFTER: ${geo.wait_after_next ?? "?"}`,
  );
  lines.push("");
  lines.push(`MY TEAM (${myTeam.length}):`);
  for (const p of myTeam) {
    const r = p.model_overall_rank ?? null;
    lines.push(
      `  ${p.pick_no ? `#${p.pick_no} ` : ""}${p.name} (${p.position ?? "?"}${p.nfl_team ? ` ${p.nfl_team}` : ""})` +
        `${r ? ` — model #${r}` : ""}`,
    );
  }
  lines.push("");
  lines.push(
    `OPEN STARTERS: ${openStarters.length ? openStarters.join(" / ") : "none"}` +
      `   FLEX open: ${rs.open_flex_slots ?? "?"}   Bench open: ${rs.open_bench_slots ?? "?"}`,
  );
  lines.push("");
  lines.push("TOP AVAILABLE:");
  for (const p of snapshot.best_available_overall.slice(0, 12)) {
    const r = p.model_overall_rank ?? p.rank;
    lines.push(
      `  ${r ?? "-"}. ${p.name} (${p.position ?? "?"}${p.team ? ` ${p.team}` : ""})` +
        `${p.model_tier ? ` [${p.model_tier}]` : p.tier ? ` [T${p.tier}]` : ""}` +
        `${p.roster_fit ? ` — ${p.roster_fit}` : ""}`,
    );
  }
  lines.push("");
  lines.push("BEST FOR MY TEAM:");
  for (const p of snapshot.best_for_my_team.slice(0, 8)) {
    const r = p.model_overall_rank ?? p.rank;
    lines.push(
      `  ${r ?? "-"}. ${p.name} (${p.position ?? "?"}${p.team ? ` ${p.team}` : ""}) — ${p.roster_fit ?? ""}`,
    );
  }
  lines.push("");
  lines.push(`INTEGRITY: ${snapshot.integrity.verdict}`);
  lines.push("");
  lines.push("UPLOAD THE JSON TO CHATGPT AND ASK:");
  lines.push(
    `"${String((snapshot.analysis_instructions as Record<string, unknown>).primary_question)}"`,
  );
  return lines.join("\n");
}
