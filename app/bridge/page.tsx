"use client";

/* eslint-disable react-hooks/set-state-in-effect --
 * This is an interactive draft-night client component. It legitimately
 * synchronizes React state with two external systems inside effects:
 * `localStorage` (mount-time hydration of the active league + per-league draft
 * state) and the `/api/bridge/board` endpoint (async board loads). Both are the
 * documented "sync with an external system" effect use; there is no render-time
 * path to the same values because `window` is absent during SSR. */

/**
 * The Draft Bridge — interactive, league-isolated draft-night board.
 *
 * Everything on this page belongs to exactly ONE league at a time. Draft state
 * is persisted per league in localStorage under a league-keyed slot and never
 * merged. Switching leagues persists the current one, loads the other's own
 * state, and rebuilds the board from that league's model/rules.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BridgeBoardResponse, BoardPlayer } from "@/lib/bridge/board";
import {
  DEFAULT_BRIDGE_LEAGUE_KEY,
  listBridgeProfiles,
} from "@/lib/bridge/profiles";
import {
  ACTIVE_LEAGUE_STORAGE_KEY,
  clearPlayer,
  draftedPlayerIds,
  emptyDraftState,
  hydrateDraftState,
  markPlayer,
  minePlayerIds,
  overallPicksMade,
  stateStorageKey,
  type BridgeDraftState,
  type CustomRanking,
} from "@/lib/bridge/state";
import { computeDraftGeometry } from "@/lib/bridge/geometry";
import { computeRosterNeeds } from "@/lib/sleeper/draft";
import type { NormalizedPlayer } from "@/lib/sleeper/types";
import {
  applyCustomRankingsToPool,
  matchCustomRankings,
  parseCustomRankings,
} from "@/lib/bridge/rankings";
import {
  buildBridgeSnapshot,
  crossCheckExport,
  renderSnapshotText,
  BridgeExportError,
  type BridgeSnapshot,
} from "@/lib/bridge/snapshot";

const PROFILES = listBridgeProfiles();
const POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "K", "DEF"] as const;

const C = {
  bg: "#0b0f14",
  panel: "#11171f",
  panel2: "#161d27",
  border: "#26303c",
  text: "#e6edf3",
  dim: "#9aa7b2",
  accent: "#6cb6ff",
  mine: "#3fb950",
  drafted: "#f85149",
  warn: "#d29922",
};

/* ---------------------------------------------------------------- storage -- */

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — the board still works in-memory */
  }
}
function readString(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeString(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / quota */
  }
}

/* ------------------------------------------------------------------ page --- */

export default function BridgePage() {
  const [leagueKey, setLeagueKey] = useState<string>(DEFAULT_BRIDGE_LEAGUE_KEY);
  const [hydrated, setHydrated] = useState(false);

  const [board, setBoard] = useState<BridgeBoardResponse | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);

  const [draftState, setDraftState] = useState<BridgeDraftState | null>(null);
  const [stateWarnings, setStateWarnings] = useState<string[]>([]);

  const [position, setPosition] = useState<(typeof POSITIONS)[number]>("ALL");
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(150);
  const [slotInput, setSlotInput] = useState("");
  const [rankingMode, setRankingMode] = useState<"sleeper" | "custom">("sleeper");

  const [rankingsText, setRankingsText] = useState("");
  const [rankingsReport, setRankingsReport] = useState<string | null>(null);
  const [showRankings, setShowRankings] = useState(false);

  const [exportOpen, setExportOpen] = useState(false);

  const profile = useMemo(
    () => PROFILES.find((p) => p.league_key === leagueKey) ?? PROFILES[0]!,
    [leagueKey],
  );

  /* -- initial hydrate -------------------------------------------------- */
  useEffect(() => {
    const stored = readString(ACTIVE_LEAGUE_STORAGE_KEY);
    const initial =
      stored && PROFILES.some((p) => p.league_key === stored)
        ? stored
        : DEFAULT_BRIDGE_LEAGUE_KEY;
    setLeagueKey(initial);
    setHydrated(true);
  }, []);

  /* -- load per-league draft state on league change ------------------- */
  useEffect(() => {
    if (!hydrated) return;
    const prof = PROFILES.find((p) => p.league_key === leagueKey) ?? PROFILES[0]!;
    const raw = readJson<BridgeDraftState>(stateStorageKey(leagueKey));
    const { state, warnings } = hydrateDraftState(prof, raw);
    setDraftState(state);
    setStateWarnings(warnings);
    setSlotInput(state.slot_override != null ? String(state.slot_override) : "");
    setRankingMode(state.custom_rankings?.length ? "custom" : "sleeper");
    setVisibleCount(150);
    writeString(ACTIVE_LEAGUE_STORAGE_KEY, leagueKey);
  }, [leagueKey, hydrated]);

  /* -- persist draft state whenever it changes ----------------------- */
  useEffect(() => {
    if (!draftState) return;
    writeJson(stateStorageKey(draftState.league_key), draftState);
  }, [draftState]);

  /* -- fetch board -------------------------------------------------- */
  const fetchBoard = useCallback(
    async (key: string, slot: number | null, mode: "sleeper" | "custom") => {
      setBoardLoading(true);
      setBoardError(null);
      try {
        const url = new URL("/api/bridge/board", window.location.origin);
        url.searchParams.set("league", key);
        url.searchParams.set("ranking", mode === "custom" ? "custom" : "sleeper");
        if (slot != null) url.searchParams.set("slot", String(slot));
        const res = await fetch(url.toString(), { cache: "no-store" });
        const body = (await res.json()) as BridgeBoardResponse & {
          error?: string;
          detail?: string;
        };
        if (!res.ok) {
          throw new Error(body.detail || body.error || `HTTP ${res.status}`);
        }
        if (body.league_identity.league_key !== key) {
          throw new Error(
            `Board returned league ${body.league_identity.league_key}, expected ${key} — refusing to display.`,
          );
        }
        setBoard(body);
        // Record the scoring identity this state is now aligned to.
        setDraftState((prev) =>
          prev && prev.league_key === key
            ? { ...prev, scoring_sha: body.scoring.scoring_sha256 }
            : prev,
        );
      } catch (err) {
        setBoard(null);
        setBoardError(err instanceof Error ? err.message : "Failed to load board.");
      } finally {
        setBoardLoading(false);
      }
    },
    [],
  );

  const lastFetchKey = useRef<string>("");
  useEffect(() => {
    if (!hydrated || !draftState) return;
    const slot = draftState.slot_override ?? null;
    const sig = `${leagueKey}|${slot}|${rankingMode}`;
    if (lastFetchKey.current === sig) return;
    lastFetchKey.current = sig;
    void fetchBoard(leagueKey, slot, rankingMode);
  }, [hydrated, draftState, leagueKey, rankingMode, fetchBoard]);

  /* -- derived: effective (re-ranked) pool --------------------------- */
  const effectivePool: BoardPlayer[] = useMemo(() => {
    if (!board) return [];
    const cr = draftState?.custom_rankings;
    if (rankingMode === "custom" && cr && cr.length > 0) {
      return applyCustomRankingsToPool(board.pool, cr);
    }
    return board.pool;
  }, [board, rankingMode, draftState]);

  const drafted = useMemo(
    () => (draftState ? draftedPlayerIds(draftState) : new Set<string>()),
    [draftState],
  );

  const available = useMemo(
    () => effectivePool.filter((p) => !drafted.has(p.player_id)),
    [effectivePool, drafted],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return available.filter((p) => {
      if (position !== "ALL") {
        const pos = [p.position, ...p.fantasy_positions];
        if (!pos.includes(position)) return false;
      }
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [available, position, search]);

  /* -- my team + needs --------------------------------------------- */
  const myTeam = useMemo(() => {
    if (!draftState) return [];
    return minePlayerIds(draftState).map((id) => ({
      id,
      entry: draftState.entries[id]!,
    }));
  }, [draftState]);

  const needs = useMemo(() => {
    if (!board) return null;
    const players: NormalizedPlayer[] = myTeam.map(({ id, entry }) =>
      asNormalized(id, entry.player),
    );
    return computeRosterNeeds(players, board.rules.roster_positions);
  }, [board, myTeam]);

  const geometry = useMemo(() => {
    if (!board) return null;
    const slot = board.league_identity.draft_slot;
    if (slot == null || board.league_identity.draft_type === "auction") return null;
    const picksMade = Math.max(
      draftState ? overallPicksMade(draftState) : 0,
      board.draft_feed.overall_picks_made,
    );
    try {
      return computeDraftGeometry({
        slot,
        teamCount: board.rules.team_count,
        rounds: board.rules.rounds,
        overallPicksMade: picksMade,
        order: board.draft_feed.order,
      });
    } catch {
      return null;
    }
  }, [board, draftState]);

  const bestForMyTeam = useMemo(() => {
    if (!needs) return available.slice(0, 10);
    const wanted = new Set<string>(needs.required.map((r) => r.position));
    if (needs.flexible_slots_remaining > 0 && board) {
      for (const p of board.rules.flex_positions) wanted.add(p);
    }
    if (wanted.size === 0) return available.slice(0, 10);
    return available
      .filter((p) =>
        [p.position, ...p.fantasy_positions].some(
          (x): x is string => x != null && wanted.has(x),
        ),
      )
      .slice(0, 10);
  }, [available, needs, board]);

  /* -- actions ---------------------------------------------------- */
  const teamCount = board?.rules.team_count ?? profile.draft.team_count;
  const mySlot = board?.league_identity.draft_slot ?? profile.manager.draft_slot;

  const mark = useCallback(
    (p: BoardPlayer, status: "drafted" | "mine") => {
      setDraftState((prev) => {
        if (!prev) return prev;
        // Assume clicks track draft order: the next pick number is one past the
        // count already marked. Cheap and good enough for a manual board; the
        // user can still fix an out-of-order pick by undo + re-mark.
        const already = overallPicksMade(prev);
        const alreadyMarked = prev.entries[p.player_id];
        const pickNo = alreadyMarked?.pick_no ?? already + 1;
        const round = teamCount > 0 ? Math.ceil(pickNo / teamCount) : null;
        return markPlayer(prev, p.player_id, status, {
          pick_no: pickNo,
          round,
          by_slot: status === "mine" ? mySlot : null,
          player: {
            name: p.name,
            position: p.position,
            team: p.team,
            fantasy_positions: p.fantasy_positions,
          },
        });
      });
    },
    [teamCount, mySlot],
  );

  const unmark = useCallback((playerId: string) => {
    setDraftState((prev) => (prev ? clearPlayer(prev, playerId) : prev));
  }, []);

  const applySlot = useCallback(() => {
    const v = slotInput.trim();
    const slot = v === "" ? null : Number.parseInt(v, 10);
    if (v !== "" && (!Number.isFinite(slot) || slot! < 1 || slot! > 32)) return;
    setDraftState((prev) =>
      prev ? { ...prev, slot_override: slot, updated_at: new Date().toISOString() } : prev,
    );
    lastFetchKey.current = "";
  }, [slotInput]);

  const loadRankings = useCallback(() => {
    if (!board) return;
    const { rankings, errors } = parseCustomRankings(rankingsText);
    if (!rankings.length) {
      setRankingsReport(`No rankings parsed. ${errors.join(" ")}`);
      return;
    }
    const pseudoPlayers = board.pool.map(
      (p) =>
        ({
          player_id: p.player_id,
          full_name: p.name,
          position: p.position,
          fantasy_positions: p.fantasy_positions,
          search_rank: p.sleeper_search_rank,
        }) as unknown as NormalizedPlayer,
    );
    const { matched, unmatched } = matchCustomRankings(rankings, pseudoPlayers);
    const custom: CustomRanking[] = matched;
    setDraftState((prev) =>
      prev
        ? {
            ...prev,
            custom_rankings: custom,
            custom_rankings_meta: {
              filename: "pasted-rankings",
              loaded_at: new Date().toISOString(),
              matched: matched.length,
              unmatched,
            },
            updated_at: new Date().toISOString(),
          }
        : prev,
    );
    setRankingMode("custom");
    lastFetchKey.current = "";
    setRankingsReport(
      `Loaded ${matched.length} ranked players` +
        (unmatched.length
          ? `. ${unmatched.length} unmatched: ${unmatched.slice(0, 8).join(", ")}${unmatched.length > 8 ? "…" : ""}`
          : ". All matched.") +
        (errors.length ? ` (parse notes: ${errors.join(" ")})` : ""),
    );
  }, [board, rankingsText]);

  const clearRankings = useCallback(() => {
    setDraftState((prev) =>
      prev
        ? {
            ...prev,
            custom_rankings: null,
            custom_rankings_meta: null,
            updated_at: new Date().toISOString(),
          }
        : prev,
    );
    setRankingMode("sleeper");
    setRankingsReport(null);
    lastFetchKey.current = "";
  }, []);

  const resetLeague = useCallback(() => {
    if (!draftState) return;
    if (
      !window.confirm(
        `Reset ALL draft state for ${profile.display_label}? This does not touch the other league.`,
      )
    )
      return;
    setDraftState(emptyDraftState(profile));
    setSlotInput("");
  }, [draftState, profile]);

  /* -- export --------------------------------------------------- */
  const runExport = useCallback(async () => {
    setExportOpen(true);
    if (!draftState) return;
    // Always export against a freshly fetched board.
    await fetchBoard(leagueKey, draftState.slot_override ?? null, rankingMode);
  }, [draftState, leagueKey, rankingMode, fetchBoard]);

  const { snapshot, exportError } = useMemo((): {
    snapshot: BridgeSnapshot | null;
    exportError: string | null;
  } => {
    if (!exportOpen || !board || !draftState || boardLoading) {
      return { snapshot: null, exportError: null };
    }
    try {
      return {
        snapshot: buildBridgeSnapshot({
          activeLeagueKey: leagueKey,
          board: { ...board, pool: effectivePool },
          state: draftState,
        }),
        exportError: null,
      };
    } catch (err) {
      return {
        snapshot: null,
        exportError:
          err instanceof BridgeExportError
            ? `${err.code} — ${err.detail}`
            : err instanceof Error
              ? err.message
              : "Export failed.",
      };
    }
  }, [exportOpen, board, boardLoading, effectivePool, draftState, leagueKey]);

  const check = useMemo(() => {
    if (!board || !draftState) return null;
    return crossCheckExport({
      activeLeagueKey: leagueKey,
      board: { ...board, pool: effectivePool },
      state: draftState,
    });
  }, [board, draftState, leagueKey, effectivePool]);

  const download = useCallback(
    (kind: "json" | "txt") => {
      if (!snapshot) return;
      // League-keyed, stable filename — the manager_key prefix is what stops a
      // Bloodline and a DarthMarker export from ever colliding.
      const key = String(
        (snapshot.league_identity as Record<string, unknown>).manager_key ??
          "league",
      ).replace(/[^a-z0-9]+/gi, "_");
      const name =
        kind === "json"
          ? `${key}_chatgpt_snapshot.json`
          : `${key}_chatgpt_summary.txt`;
      const body =
        kind === "json"
          ? JSON.stringify(snapshot, null, 2)
          : renderSnapshotText(snapshot);
      const blob = new Blob([body], {
        type: kind === "json" ? "application/json" : "text/plain",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    [snapshot],
  );

  const copyJson = useCallback(() => {
    if (!snapshot) return;
    void navigator.clipboard?.writeText(JSON.stringify(snapshot, null, 2));
  }, [snapshot]);

  /* -- render -------------------------------------------------- */
  if (!hydrated || !draftState) {
    return <div style={{ padding: 40, color: C.dim }}>Loading the Bridge…</div>;
  }

  const id = board?.league_identity;
  const rq = board?.ranking_quality;
  const rankingFallback = rq?.status === "FALLBACK";
  const modelLabel = board
    ? rq?.status === "MODEL"
      ? rq.source_label
      : rq?.status === "FALLBACK"
        ? "SLEEPER FALLBACK — model not loaded"
        : rq?.status === "CUSTOM"
          ? "Your uploaded rankings"
          : board.model_profile.candidate_id
            ? `Candidate ${board.model_profile.candidate_id}${board.model_profile.candidate_verified ? "" : " (declared, unverified)"}`
            : "Sleeper search_rank (market)"
    : "—";

  return (
    <div
      style={{
        maxWidth: 1180,
        margin: "0 auto",
        padding: "0 16px 80px",
        color: C.text,
      }}
    >
      {/* sticky top bar */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: C.bg,
          borderBottom: `2px solid ${C.border}`,
          padding: "10px 0",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "center",
            fontWeight: 700,
            fontSize: 15,
          }}
        >
          <span style={{ fontSize: 18, letterSpacing: 0.5 }}>
            {profile.short_label}
          </span>
          <span style={{ color: C.dim }}>
            SLOT{" "}
            <span style={{ color: C.text }}>
              {id?.draft_slot ?? profile.manager.draft_slot ?? "?"}
            </span>
            {id && id.draft_slot_source !== "sleeper_draft_order" && (
              <span style={{ color: C.warn }}> ({id.draft_slot_source})</span>
            )}
          </span>
          {geometry?.next_pick && (
            <span style={{ color: C.dim }}>
              NEXT PICK{" "}
              <span style={{ color: C.accent }}>
                {geometry.next_pick.overall}
              </span>{" "}
              (R{geometry.next_pick.round}) · in {geometry.picks_until_next}
              {geometry.wait_after_next != null && (
                <> · then wait {geometry.wait_after_next}</>
              )}
            </span>
          )}
          <span style={{ color: C.dim }}>
            SYNC{" "}
            <span style={{ color: C.text }}>
              {board && board.draft_feed.overall_picks_made > 0
                ? `SLEEPER (${board.draft_feed.status})`
                : "MANUAL"}
            </span>
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={() => void runExport()} style={btnPrimary}>
            Export for ChatGPT
          </button>
          <button
            onClick={() => {
              lastFetchKey.current = "";
              void fetchBoard(
                leagueKey,
                draftState.slot_override ?? null,
                rankingMode,
              );
            }}
            style={btn}
          >
            {boardLoading ? "…" : "Refresh"}
          </button>
        </div>
      </div>

      <h1 style={{ fontSize: 22, margin: "18px 0 6px" }}>
        Draft Bridge
        <span style={{ color: C.dim, fontWeight: 400, fontSize: 14 }}>
          {" "}
          — one league at a time, never mixed
        </span>
      </h1>

      {/* league selector */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "10px 0" }}>
        {PROFILES.map((p) => {
          const active = p.league_key === leagueKey;
          return (
            <button
              key={p.league_key}
              onClick={() => setLeagueKey(p.league_key)}
              style={{
                ...btn,
                padding: "10px 14px",
                border: `2px solid ${active ? C.accent : C.border}`,
                background: active ? C.panel2 : C.panel,
                fontWeight: active ? 800 : 500,
                fontSize: 14,
              }}
            >
              {active && (
                <span style={{ color: C.accent, marginRight: 6 }}>● ACTIVE</span>
              )}
              {p.display_label}
              <span style={{ color: C.dim, fontWeight: 400 }}>
                {" "}
                · slot {p.manager.draft_slot ?? "?"} ·{" "}
                {p.draft.type}
              </span>
            </button>
          );
        })}
      </div>

      {/* visual league-safety banner */}
      <div
        style={{
          border: `2px solid ${C.border}`,
          background: C.panel,
          borderRadius: 8,
          padding: "14px 16px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
          gap: 12,
          margin: "6px 0 16px",
        }}
      >
        <Field label="LEAGUE" value={board?.league_identity.league_name ?? profile.league_name} big />
        <Field label="ALSO KNOWN AS" value={profile.display_label} />
        <Field
          label="DRAFT SLOT"
          value={String(id?.draft_slot ?? profile.manager.draft_slot ?? "?")}
          big
        />
        <Field
          label="MODEL / PROFILE"
          value={modelLabel}
          warn={board?.model_profile.ranking_fallback_active}
        />
        <Field
          label="SCORING HASH"
          value={board ? `${board.scoring.scoring_sha256.slice(0, 16)}…` : "—"}
          sub={board?.scoring.ppr_label}
        />
        <Field
          label="SLEEPER LEAGUE"
          value={profile.platform_league_id}
          sub={`draft ${profile.platform_draft_id}`}
        />
      </div>

      {/* ranking-source strip — must be unmissable */}
      {board && rq && (
        <div
          style={{
            border: `2px solid ${
              rq.status === "MODEL"
                ? C.mine
                : rq.status === "FALLBACK"
                  ? C.drafted
                  : C.border
            }`,
            background: rankingFallback ? "#2a1416" : C.panel,
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 14,
            fontSize: 14,
          }}
        >
          <span style={{ color: C.dim, letterSpacing: 1, fontSize: 11 }}>
            RANKING SOURCE
          </span>
          <div
            style={{
              fontWeight: 800,
              fontSize: rankingFallback ? 16 : 15,
              color:
                rq.status === "MODEL"
                  ? C.mine
                  : rankingFallback
                    ? C.drafted
                    : C.text,
            }}
          >
            {rankingMode === "custom" && draftState.custom_rankings?.length
              ? `Your uploaded rankings (${draftState.custom_rankings.length})`
              : rq.source_label}
          </div>
          {rankingFallback && (
            <div style={{ color: C.drafted, fontWeight: 700, marginTop: 4 }}>
              ⚠ {profile.short_label} MODEL NOT LOADED — USING SLEEPER FALLBACK
              RANKINGS
              <div style={{ fontWeight: 400, fontSize: 12, marginTop: 2 }}>
                {rq.warning}
              </div>
            </div>
          )}
          {board.ranking_pack && rq.status === "MODEL" && (
            <div style={{ color: C.dim, fontSize: 12, marginTop: 3 }}>
              {board.ranking_pack.model_version} · scoring{" "}
              {board.ranking_pack.scoring_status} · roster{" "}
              {board.ranking_pack.roster_status} ·{" "}
              {board.ranking_pack.matched_to_pool}/
              {board.ranking_pack.player_count} matched
              {board.ranking_pack.missing_from_sleeper.length > 0 &&
                ` · ${board.ranking_pack.missing_from_sleeper.length} unmatched!`}
            </div>
          )}
        </div>
      )}

      {/* slot confirm + ranking toggle */}
      <div
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 12,
          fontSize: 13,
        }}
      >
        <label style={{ color: C.dim }}>
          Confirm your draft slot:{" "}
          <input
            value={slotInput}
            onChange={(e) => setSlotInput(e.target.value)}
            placeholder={String(profile.manager.draft_slot ?? "")}
            style={{
              width: 54,
              background: C.panel2,
              border: `1px solid ${C.border}`,
              color: C.text,
              padding: "4px 6px",
              borderRadius: 4,
            }}
          />{" "}
          <button onClick={applySlot} style={btn}>
            Set
          </button>
        </label>
        <span style={{ color: C.dim }}>
          Ranking:{" "}
          <b style={{ color: rankingMode === "sleeper" ? C.accent : C.text }}>
            {rankingMode === "custom"
              ? `your file (${draftState.custom_rankings?.length ?? 0})`
              : "Sleeper search_rank"}
          </b>
        </span>
        <button onClick={() => setShowRankings((v) => !v)} style={btn}>
          {showRankings ? "Hide" : "Load my rankings"}
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={resetLeague} style={{ ...btn, color: C.drafted }}>
          Reset {profile.short_label}
        </button>
      </div>

      {showRankings && (
        <div
          style={{
            border: `1px solid ${C.border}`,
            background: C.panel,
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
          }}
        >
          <div style={{ color: C.dim, fontSize: 12, marginBottom: 6 }}>
            Paste CSV (<code>rank,name,position,tier</code> or a header row) or a
            JSON array of <code>{"{ name, position, rank, tier }"}</code>. Applied
            to <b>{profile.short_label}</b> only.
          </div>
          <textarea
            value={rankingsText}
            onChange={(e) => setRankingsText(e.target.value)}
            rows={6}
            style={{
              width: "100%",
              background: C.bg,
              color: C.text,
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              fontFamily: "ui-monospace, monospace",
              fontSize: 12,
              padding: 8,
            }}
            placeholder={"1,Ja'Marr Chase,WR,1\n2,Bijan Robinson,RB,1\n3,Justin Jefferson,WR,1"}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <button onClick={loadRankings} style={btnPrimary}>
              Load & use my rankings
            </button>
            <button onClick={() => setRankingMode("sleeper")} style={btn}>
              Use Sleeper ranking
            </button>
            {draftState.custom_rankings?.length ? (
              <button onClick={clearRankings} style={{ ...btn, color: C.drafted }}>
                Clear my rankings
              </button>
            ) : null}
          </div>
          {rankingsReport && (
            <div style={{ color: C.dim, fontSize: 12, marginTop: 8 }}>
              {rankingsReport}
            </div>
          )}
        </div>
      )}

      {/* warnings */}
      {(boardError || stateWarnings.length > 0 || board?.warnings.length) && (
        <div
          style={{
            border: `1px solid ${C.warn}`,
            background: "#1c1710",
            borderRadius: 6,
            padding: "8px 12px",
            marginBottom: 14,
            fontSize: 12,
            color: C.warn,
          }}
        >
          {boardError && <div>Board error: {boardError}</div>}
          {stateWarnings.map((w, i) => (
            <div key={`s${i}`}>{w}</div>
          ))}
          {board?.warnings.map((w, i) => (
            <div key={`b${i}`}>
              {w.code}: {w.message}
            </div>
          ))}
        </div>
      )}

      {/* main grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.7fr) minmax(0, 1fr)",
          gap: 18,
        }}
      >
        {/* board */}
        <div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {POSITIONS.map((p) => (
              <button
                key={p}
                onClick={() => setPosition(p)}
                style={{
                  ...btn,
                  padding: "4px 10px",
                  fontSize: 12,
                  border: `1px solid ${position === p ? C.accent : C.border}`,
                  color: position === p ? C.accent : C.text,
                }}
              >
                {p}
              </button>
            ))}
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search player…"
              style={{
                flex: 1,
                minWidth: 120,
                background: C.panel2,
                border: `1px solid ${C.border}`,
                color: C.text,
                padding: "4px 8px",
                borderRadius: 4,
                fontSize: 12,
              }}
            />
          </div>

          <div style={{ color: C.dim, fontSize: 12, marginBottom: 6 }}>
            {available.length} available
            {board?.pool_truncated && " (pool capped at 700)"} ·{" "}
            {drafted.size} off the board
          </div>

          <div style={{ border: `1px solid ${C.border}`, borderRadius: 8 }}>
            {filtered.slice(0, visibleCount).map((p, i) => (
              <div
                key={p.player_id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 10px",
                  borderTop: i === 0 ? "none" : `1px solid ${C.panel2}`,
                  fontSize: 13,
                }}
              >
                <span style={{ width: 34, color: C.dim, textAlign: "right" }}>
                  {p.rank ?? "–"}
                </span>
                <span style={{ flex: 1 }}>
                  <b>{p.name}</b>{" "}
                  <span style={{ color: C.dim }}>
                    {p.position}
                    {p.team ? ` · ${p.team}` : ""}
                    {p.tier != null
                      ? ` · ${typeof p.tier === "number" ? `T${p.tier}` : p.tier}`
                      : ""}
                    {p.market_adp != null ? ` · ADP ${p.market_adp}` : ""}
                    {p.injury_status ? ` · ${p.injury_status}` : ""}
                  </span>
                  {p.model_action && p.model_action !== "CONSIDER" && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 10,
                        color: p.model_action.includes("FADE") ? C.warn : C.mine,
                        fontWeight: 700,
                      }}
                    >
                      {p.model_action}
                    </span>
                  )}
                </span>
                <button
                  onClick={() => mark(p, "drafted")}
                  style={{ ...btnMini, borderColor: C.drafted, color: C.drafted }}
                >
                  DRAFTED
                </button>
                <button
                  onClick={() => mark(p, "mine")}
                  style={{ ...btnMini, borderColor: C.mine, color: C.mine }}
                >
                  MINE
                </button>
              </div>
            ))}
            {filtered.length === 0 && (
              <div style={{ padding: 16, color: C.dim, fontSize: 13 }}>
                Nothing available for this filter.
              </div>
            )}
          </div>
          {filtered.length > visibleCount && (
            <button
              onClick={() => setVisibleCount((c) => c + 150)}
              style={{ ...btn, marginTop: 8 }}
            >
              Show more ({filtered.length - visibleCount} hidden)
            </button>
          )}
        </div>

        {/* right column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Panel title={`My Team · ${myTeam.length}`}>
            {myTeam.length === 0 && (
              <div style={{ color: C.dim, fontSize: 12 }}>
                Nothing yet. Click <b style={{ color: C.mine }}>MINE</b> as you
                draft.
              </div>
            )}
            {myTeam.map(({ id: pid, entry }) => (
              <div
                key={pid}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                  padding: "2px 0",
                }}
              >
                <span>
                  {entry.pick_no ? `#${entry.pick_no} ` : ""}
                  <b>{entry.player?.name ?? pid}</b>{" "}
                  <span style={{ color: C.dim }}>{entry.player?.position}</span>
                </span>
                <button onClick={() => unmark(pid)} style={btnMini}>
                  undo
                </button>
              </div>
            ))}
            {needs && (
              <div
                style={{
                  marginTop: 8,
                  paddingTop: 8,
                  borderTop: `1px solid ${C.panel2}`,
                  fontSize: 12,
                  color: C.dim,
                }}
              >
                Needs:{" "}
                {needs.required.length
                  ? needs.required
                      .map((r) => `${r.position}×${r.minimum_needed}`)
                      .join(", ")
                  : "no strict starters missing"}
                <br />
                Flex open: {needs.flexible_slots_remaining} · Bench open:{" "}
                {needs.bench_slots_remaining} · Starters{" "}
                {needs.starters_filled}/{needs.starters_required}
              </div>
            )}
          </Panel>

          <Panel title="Best for my team">
            {bestForMyTeam.map((p) => (
              <BestRow key={p.player_id} p={p} onMark={mark} />
            ))}
          </Panel>

          <Panel title="Best available">
            {available.slice(0, 10).map((p) => (
              <BestRow key={p.player_id} p={p} onMark={mark} />
            ))}
          </Panel>

          <Panel title="Recent picks">
            {draftState &&
              Object.entries(draftState.entries)
                .sort((a, b) => b[1].at.localeCompare(a[1].at))
                .slice(0, 10)
                .map(([pid, e]) => (
                  <div
                    key={pid}
                    style={{ fontSize: 12, display: "flex", gap: 6, padding: "1px 0" }}
                  >
                    <span
                      style={{
                        color: e.status === "mine" ? C.mine : C.drafted,
                        width: 54,
                      }}
                    >
                      {e.status.toUpperCase()}
                    </span>
                    <span>{e.player?.name ?? pid}</span>
                    <span style={{ color: C.dim }}>{e.player?.position}</span>
                  </div>
                ))}
            {draftState && Object.keys(draftState.entries).length === 0 && (
              <div style={{ color: C.dim, fontSize: 12 }}>None yet.</div>
            )}
          </Panel>
        </div>
      </div>

      {exportOpen && (
        <ExportModal
          onClose={() => setExportOpen(false)}
          loading={boardLoading}
          error={exportError}
          snapshot={snapshot}
          check={check}
          onDownloadJson={() => download("json")}
          onDownloadTxt={() => download("txt")}
          onCopy={copyJson}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- helpers -- */

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

const btn: React.CSSProperties = {
  background: "#1b2430",
  color: "#e6edf3",
  border: "1px solid #26303c",
  borderRadius: 5,
  padding: "5px 10px",
  fontSize: 13,
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "#1f6feb",
  borderColor: "#1f6feb",
  fontWeight: 700,
};
const btnMini: React.CSSProperties = {
  background: "transparent",
  color: "#9aa7b2",
  border: "1px solid #26303c",
  borderRadius: 4,
  padding: "2px 6px",
  fontSize: 11,
  cursor: "pointer",
};

function Field({
  label,
  value,
  sub,
  big,
  warn,
}: {
  label: string;
  value: string;
  sub?: string | null;
  big?: boolean;
  warn?: boolean;
}) {
  return (
    <div>
      <div style={{ color: C.dim, fontSize: 10, letterSpacing: 1 }}>{label}</div>
      <div
        style={{
          fontSize: big ? 18 : 13,
          fontWeight: big ? 800 : 600,
          color: warn ? C.warn : C.text,
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
      {sub && <div style={{ color: C.dim, fontSize: 11 }}>{sub}</div>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: `1px solid ${C.border}`,
        background: C.panel,
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function BestRow({
  p,
  onMark,
}: {
  p: BoardPlayer;
  onMark: (p: BoardPlayer, status: "drafted" | "mine") => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        padding: "2px 0",
      }}
    >
      <span style={{ width: 26, color: C.dim, textAlign: "right" }}>
        {p.rank ?? "–"}
      </span>
      <span style={{ flex: 1 }}>
        {p.name} <span style={{ color: C.dim }}>{p.position}{p.team ? ` ${p.team}` : ""}</span>
      </span>
      <button
        onClick={() => onMark(p, "drafted")}
        style={{ ...btnMini, color: C.drafted }}
      >
        drafted
      </button>
      <button onClick={() => onMark(p, "mine")} style={{ ...btnMini, color: C.mine }}>
        mine
      </button>
    </div>
  );
}

function ExportModal({
  onClose,
  loading,
  error,
  snapshot,
  check,
  onDownloadJson,
  onDownloadTxt,
  onCopy,
}: {
  onClose: () => void;
  loading: boolean;
  error: string | null;
  snapshot: BridgeSnapshot | null;
  check: ReturnType<typeof crossCheckExport> | null;
  onDownloadJson: () => void;
  onDownloadTxt: () => void;
  onCopy: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 50,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: 24,
        overflow: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          maxWidth: 760,
          width: "100%",
          padding: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>ChatGPT snapshot</h2>
          <button onClick={onClose} style={btn}>
            close
          </button>
        </div>

        {loading && (
          <div style={{ color: C.dim, marginTop: 12 }}>
            Fetching a fresh board and cross-checking…
          </div>
        )}

        {check && (
          <div
            style={{
              marginTop: 12,
              border: `1px solid ${check.verdict === "PASS" ? C.mine : C.drafted}`,
              borderRadius: 6,
              padding: 10,
              fontSize: 12,
            }}
          >
            <b
              style={{
                color: check.verdict === "PASS" ? C.mine : C.drafted,
              }}
            >
              CROSS-CHECK: {check.verdict}
            </b>
            <div style={{ color: C.dim, marginTop: 4 }}>
              active={check.active_league_key} · board={check.board_league_key} ·
              state={check.state_league_key}
              <br />
              scoring hash match: {String(check.scoring_hash_match)} · draft
              source: {check.draft_source_check} · model:{" "}
              {check.model_identity_check}
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              marginTop: 12,
              border: `1px solid ${C.drafted}`,
              borderRadius: 6,
              padding: 10,
              color: C.drafted,
              fontSize: 13,
            }}
          >
            EXPORT BLOCKED — {error}
          </div>
        )}

        {snapshot && (
          <>
            <div style={{ margin: "12px 0", fontSize: 13 }}>
              <b>{snapshot.snapshot_title}</b>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button onClick={onDownloadJson} style={btnPrimary}>
                Download JSON
              </button>
              <button onClick={onDownloadTxt} style={btn}>
                Download .txt
              </button>
              <button onClick={onCopy} style={btn}>
                Copy JSON
              </button>
            </div>
            <pre
              style={{
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                padding: 12,
                maxHeight: 320,
                overflow: "auto",
                fontSize: 11,
                lineHeight: 1.5,
              }}
            >
              {JSON.stringify(snapshot, null, 2)}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
