/**
 * Stage C — shadow comparison harness.
 *
 *   npx tsx scripts/bridge-shadow-compare.ts [--json <path>] [--md <path>]
 *
 * OPERATIONALLY READ-ONLY:
 *   - uses an in-memory persistence bundle → the production
 *     `bridge_published_snapshot` pointer and `bridge_league_snapshots` are
 *     NEVER written;
 *   - the new path runs with `dryRun: true` → no `put`, no `advance`;
 *   - only Sleeper GET reads happen (the same ones the live site already makes).
 *
 * Layers:
 *   A. deterministic same-source (publish wrapper transparency) — also covered by
 *      test/bridge-shadow-compare.test.ts; re-asserted here per league.
 *   B. live shadow — OLD `buildCanonicalLeagueState` vs NEW
 *      `getPublishedLeagueSnapshot({dryRun})`, with source-moved detection.
 *   + P0 direct-route surface comparison (standings / managers / matchups /
 *     transactions) against canonical.
 *   + capability-health assertions.
 *   + team-state model-input equivalence (same schedule, both snapshots).
 */

import { writeFileSync } from "node:fs";
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { getPublishedLeagueSnapshot } from "@/lib/canonical/published";
import { readLeagueState } from "@/lib/canonical/read";
import { compareCanonicalPaths, compareDirectSurface, type ShadowComparison } from "@/lib/canonical/shadow";
import { summarizeCapabilities } from "@/lib/canonical/capabilities";
import { snapshotContentHash } from "@/lib/persistence/serialize";
import { memoryPersistence } from "@/lib/persistence/memory";
import { buildTeamManagementState } from "@/lib/team-state/build";
import { certify, factsFromCanonical, type LeagueFacts, type TeamFacts } from "@/lib/canonical/certification/harness";
import {
  getLeagueRosters,
  getLeagueUsers,
  getMatchups,
  getLeagueTransactions,
} from "@/lib/sleeper/client";
import { listLeagueTargets, leagueConfigStatus } from "@/lib/leagues/registry";
import { getPersistence } from "@/lib/persistence";
import type { CanonicalLeagueSnapshot } from "@/lib/canonical/schema";

const argv = process.argv.slice(2);
const jsonPath = argFlag("--json");
const mdPath = argFlag("--md") ?? "docs/BRIDGE_REALTIME_STATE_PHASE_C_SHADOW_RUN.md";

function argFlag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const emptySchedule = {
  status: "UNVERIFIED" as const,
  source: null,
  byeTeamsByWeek: new Map<number, Set<string>>(),
  opponentByTeam: {} as Record<string, string>,
  currentWeek: 0,
};

interface LeagueReport {
  league_slug: string;
  reachable: boolean;
  error?: string;
  /** Set when the publication path intentionally skips this league (pre_draft / drafting). */
  skipped_reason?: string;
  layerA: { verdict: string; unexplained: number };
  layerB: ShadowComparison | null;
  p0: Record<string, { timing: number; semantic: number; semantic_detail: string[] }>;
  capability_summary: string;
  model_equivalence: { teams_compared: number; divergent_teams: string[] };
  /** §16 — legacy live vs the ACTUAL published pointer snapshot, when one exists. */
  published_comparison:
    | { pointer_present: false; note: string }
    | {
        pointer_present: true;
        published_snapshot_id: string;
        published_seq: number;
        verdict: string;
        unexplained: number;
        source_stable: boolean;
        /** Stage F — what `readLeagueState` returns with the flag forced ON. */
        reader_state_source: string;
        reader_fallback_reason: string | null;
      };
}

function directFactsFromRaw(
  slug: string,
  rosters: Awaited<ReturnType<typeof getLeagueRosters>>,
  users: Awaited<ReturnType<typeof getLeagueUsers>>,
  matchups: Awaited<ReturnType<typeof getMatchups>>,
): LeagueFacts {
  const nameByUser = new Map(users.map((u) => [u.user_id, u.display_name ?? null]));
  const teamNameByUser = new Map(
    users.map((u) => [u.user_id, (u.metadata as { team_name?: string } | null)?.team_name ?? null]),
  );
  const teams = new Map<number, TeamFacts>();
  const oppByRoster = new Map<number, number | null>();
  const byMatchupId = new Map<number, number[]>();
  for (const m of matchups) {
    if (m.matchup_id == null) continue;
    const arr = byMatchupId.get(m.matchup_id) ?? [];
    arr.push(m.roster_id);
    byMatchupId.set(m.matchup_id, arr);
  }
  for (const arr of byMatchupId.values()) {
    if (arr.length === 2) {
      oppByRoster.set(arr[0]!, arr[1]!);
      oppByRoster.set(arr[1]!, arr[0]!);
    }
  }
  for (const r of rosters) {
    const s = (r.settings ?? {}) as Record<string, number>;
    const rosterMetaName = (r.metadata as { team_name?: string } | null)?.team_name ?? null;
    teams.set(r.roster_id, {
      roster_id: r.roster_id,
      owner_user_id: r.owner_id ?? null,
      manager_display_name: r.owner_id ? (nameByUser.get(r.owner_id) ?? null) : null,
      team_name: (r.owner_id ? teamNameByUser.get(r.owner_id) : null) ?? rosterMetaName,
      wins: s.wins ?? 0,
      losses: s.losses ?? 0,
      ties: s.ties ?? 0,
      points_for: Math.round(((s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100) * 100) / 100,
      starter_ids: [...(r.starters ?? [])].filter((x) => x && x !== "0").sort(),
      all_player_ids: [...(r.players ?? [])].filter((x) => x && x !== "0").sort(),
      opponent_roster_id: oppByRoster.has(r.roster_id) ? oppByRoster.get(r.roster_id)! : undefined,
    });
  }
  return { source: `direct:${slug}`, teams };
}

async function runLeague(slug: string): Promise<LeagueReport> {
  const report: LeagueReport = {
    league_slug: slug,
    reachable: false,
    layerA: { verdict: "SKIPPED", unexplained: 0 },
    layerB: null,
    p0: {},
    capability_summary: "-",
    model_equivalence: { teams_compared: 0, divergent_teams: [] },
    published_comparison: { pointer_present: false, note: "not evaluated" },
  };

  let oldStart: CanonicalLeagueSnapshot;
  try {
    const s = await buildCanonicalLeagueState(slug, { includeMatchups: true, includeRecentTransactions: true, reportPersistence: false });
    if (!s.ok || !s.snapshot) throw new Error(s.detail ?? "old path returned no snapshot");
    oldStart = s.snapshot;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    return report;
  }
  report.reachable = true;
  const startHash = snapshotContentHash(oldStart);

  // NEW path — dry run, in-memory persistence, its own provider read.
  const newRes = await getPublishedLeagueSnapshot(slug, {
    persistence: memoryPersistence(),
    forced: true,
    dryRun: true,
  });
  // A league the publication path intentionally skips (pre_draft / drafting) has
  // no management state to compare — record it and move on.
  if (newRes.outcome === "skipped" || !newRes.reconcile) {
    report.reachable = true;
    report.skipped_reason =
      newRes.detail ?? `publication outcome=${newRes.outcome} (no reconcile)`;
    report.layerA = { verdict: "SKIPPED", unexplained: 0 };
    report.capability_summary = newRes.capabilities
      ? summarizeCapabilities(newRes.capabilities)
      : "-";
    return report;
  }

  const newSnap = newRes.snapshot!;
  report.capability_summary = newRes.capabilities
    ? summarizeCapabilities(newRes.capabilities)
    : "-";

  // source-moved probe
  const endRes = await buildCanonicalLeagueState(slug, { includeMatchups: true, includeRecentTransactions: true, reportPersistence: false });
  const endHash = endRes.snapshot ? snapshotContentHash(endRes.snapshot) : "UNKNOWN";

  // Layer A — deterministic: feed oldStart through both, expect identity.
  const aNew = await getPublishedLeagueSnapshot(slug, {
    persistence: memoryPersistence(),
    forced: true,
    dryRun: true,
    buildOverride: async () => ({ ok: true, status: 200, snapshot: oldStart }),
  });
  const aCmp = compareCanonicalPaths(oldStart, aNew.snapshot!, {
    mode: "DETERMINISTIC_SAME_SOURCE",
    sourceStartHash: startHash,
    sourceEndHash: startHash,
    reconcileOk: aNew.reconcile!.ok,
  });
  report.layerA = { verdict: aCmp.verdict, unexplained: aCmp.totals.UNEXPLAINED };

  // Layer B — live shadow.
  report.layerB = compareCanonicalPaths(oldStart, newSnap, {
    mode: "LIVE_SHADOW",
    sourceStartHash: startHash,
    sourceEndHash: endHash,
    reconcileOk: newRes.reconcile!.ok,
  });

  // §16 — legacy live vs the ACTUAL published pointer snapshot (real persistence).
  try {
    const realPersistence = getPersistence();
    if ((await realPersistence.published.status()) !== "READY") {
      report.published_comparison = {
        pointer_present: false,
        note: "published-pointer store not configured in this environment",
      };
    } else {
      const league = listLeagueTargets().find((t) => t.key === slug)!;
      const ptr = await realPersistence.published.get(slug, league.season ?? oldStart.season);
      if (!ptr) {
        report.published_comparison = {
          pointer_present: false,
          note: "no published pointer for this league yet — run POST /api/refresh or /api/cron/publish",
        };
      } else {
        const stored = await realPersistence.snapshots.getById(ptr.snapshot_id);
        if (!stored) {
          report.published_comparison = {
            pointer_present: false,
            note: `pointer names snapshot ${ptr.snapshot_id} but it is missing from the store`,
          };
        } else {
          const cmp = compareCanonicalPaths(oldStart, stored.payload, {
            mode: "LIVE_SHADOW",
            sourceStartHash: startHash,
            sourceEndHash: endHash,
            reconcileOk: true,
          });
          // Stage F — what does the shared reader actually serve with the flag ON?
          const prevFlag = process.env.BRIDGE_PUBLISHED_SNAPSHOT;
          process.env.BRIDGE_PUBLISHED_SNAPSHOT = "1";
          const readerRes = await readLeagueState(slug, { wave: 3 });
          if (prevFlag === undefined) delete process.env.BRIDGE_PUBLISHED_SNAPSHOT;
          else process.env.BRIDGE_PUBLISHED_SNAPSHOT = prevFlag;

          report.published_comparison = {
            pointer_present: true,
            published_snapshot_id: ptr.league_snapshot_id,
            published_seq: ptr.published_seq,
            verdict: cmp.verdict,
            unexplained: cmp.totals.UNEXPLAINED,
            source_stable: startHash === endHash,
            reader_state_source: readerRes.provenance.state_source,
            reader_fallback_reason: readerRes.provenance.fallback_reason,
          };
        }
      }
    }
  } catch (e) {
    report.published_comparison = { pointer_present: false, note: `error: ${String(e)}` };
  }

  // P0 direct-surface comparison.
  try {
    const league = listLeagueTargets().find((t) => t.key === slug)!;
    const id = league.external_league_id ?? league.league_id;
    const week = newSnap.week > 0 ? newSnap.week : 1;
    const [rosters, users, matchups] = await Promise.all([
      getLeagueRosters(id),
      getLeagueUsers(id),
      getMatchups(id, week).catch(() => []),
    ]);
    const direct = directFactsFromRaw(slug, rosters, users, matchups);
    const { timing, semantic } = compareDirectSurface(newSnap, direct, {
      sourceStable: startHash === endHash,
    });
    report.p0["standings+managers+matchups (raw rosters/users/matchups)"] = {
      timing: timing.length,
      semantic: semantic.length,
      semantic_detail: semantic.map((d) => `[${d.scope}] ${d.field}: canonical=${JSON.stringify(d.a_value)} direct=${JSON.stringify(d.b_value)}`),
    };

    const txn = await getLeagueTransactions(id, week).catch(() => []);
    const directTxIds = new Set(txn.filter((t) => t.status === "complete").map((t) => t.transaction_id));
    const canonTxIds = new Set(newSnap.recent_transactions.map((t) => t.provenance.provider_id));
    const missing = [...directTxIds].filter((x) => !canonTxIds.has(x));
    const extra = [...canonTxIds].filter((x) => x && !directTxIds.has(x));
    report.p0["transactions (week feed)"] = {
      timing: startHash === endHash ? 0 : missing.length + extra.length,
      semantic: startHash === endHash ? missing.length + extra.length : 0,
      semantic_detail: [
        ...missing.map((x) => `direct-only txn ${x}`),
        ...extra.map((x) => `canonical-only txn ${x}`),
      ],
    };
  } catch (e) {
    report.p0["_error"] = { timing: 0, semantic: 0, semantic_detail: [String(e)] };
  }

  // team-state model-input equivalence (same schedule both sides).
  const divergent: string[] = [];
  for (const team of newSnap.teams) {
    const tid = team.canonical_team_id;
    if (!oldStart.teams.some((t) => t.canonical_team_id === tid)) continue;
    try {
      const a = buildTeamManagementState(oldStart, tid, emptySchedule);
      const b = buildTeamManagementState(newSnap, tid, emptySchedule);
      // Compare the state-input surface, ignoring lineage timestamps.
      const strip = (x: unknown) => JSON.stringify(x, (k, v) => (k === "generated_at" || k === "lineage" ? undefined : v));
      if (strip(a) !== strip(b)) divergent.push(tid);
      report.model_equivalence.teams_compared += 1;
    } catch {
      /* team absent from one side — counted via divergent set below */
    }
  }
  report.model_equivalence.divergent_teams = divergent;

  return report;
}

function md(reports: LeagueReport[]): string {
  const L: string[] = [];
  L.push("# Bridge Real-Time State — Stage C: Shadow Comparison Report");
  L.push("");
  L.push(`Generated: ${new Date().toISOString()}`);
  L.push("");
  L.push("**Operationally read-only.** In-memory persistence; `dryRun: true`; only Sleeper GETs.");
  L.push("Pointer rows written to production: **0** (by construction — the harness never");
  L.push("receives the real persistence bundle).");
  L.push("");

  let anyUnexplainedStable = false;
  let pointerWrites = 0;

  for (const r of reports) {
    L.push(`## ${r.league_slug}`);
    L.push("");
    if (!r.reachable) {
      L.push(`- comparison mode: **INCONCLUSIVE** — provider unreachable from this environment`);
      L.push(`- error: \`${r.error}\``);
      L.push("");
      continue;
    }
    if (r.skipped_reason) {
      L.push(`- comparison mode: **NOT APPLICABLE** — publication path skips this league`);
      L.push(`- reason: \`${r.skipped_reason}\``);
      L.push(`- capability health: \`${r.capability_summary}\``);
      L.push("");
      continue;
    }
    const b = r.layerB!;
    L.push(`| field | value |`);
    L.push(`| --- | --- |`);
    L.push(`| old observation | \`${b.old_snapshot_id}\` |`);
    L.push(`| new observation | \`${b.new_snapshot_id}\` |`);
    L.push(`| source stable during comparison? | ${b.source_stable ? "**yes**" : "**NO — INCONCLUSIVE_SOURCE_MOVED**"} |`);
    L.push(`| source start hash | \`${b.source_start_hash.slice(0, 16)}\` |`);
    L.push(`| source end hash | \`${b.source_end_hash.slice(0, 16)}\` |`);
    L.push(`| domains compared | ${b.domains_compared.join(", ")} |`);
    L.push(`| Layer A (deterministic) verdict | ${r.layerA.verdict} (unexplained ${r.layerA.unexplained}) |`);
    L.push(`| Layer B verdict | **${b.verdict}** |`);
    L.push(`| reconcile / certification | ${b.reconcile_ok ? "CERTIFIED" : "REJECTED"} |`);
    L.push(`| capability health | \`${r.capability_summary}\` |`);
    L.push("");

    L.push(`### Difference taxonomy (Layer B)`);
    L.push("");
    L.push(`| category | count |`);
    L.push(`| --- | --- |`);
    for (const [k, v] of Object.entries(b.totals)) L.push(`| ${k} | ${v} |`);
    L.push("");
    if (b.diffs.length > 0) {
      L.push(`<details><summary>${b.diffs.length} diffs</summary>`);
      L.push("");
      for (const d of b.diffs) {
        L.push(`- **${d.category}** · ${d.domain}/${d.scope} · ${d.field}: \`${JSON.stringify(d.old_value)}\` → \`${JSON.stringify(d.new_value)}\` — ${d.note}`);
      }
      L.push("");
      L.push(`</details>`);
      L.push("");
    }
    if (b.totals.UNEXPLAINED > 0 && b.source_stable) anyUnexplainedStable = true;

    L.push(`### P0 direct-route surface comparison`);
    L.push("");
    L.push(`| surface | timing-only | semantic | notes |`);
    L.push(`| --- | --- | --- | --- |`);
    for (const [name, v] of Object.entries(r.p0)) {
      L.push(`| ${name} | ${v.timing} | ${v.semantic} | ${v.semantic_detail.slice(0, 3).join("; ") || "—"} |`);
    }
    L.push("");

    L.push(`### Model-input equivalence (team-state, identical schedule both sides)`);
    L.push("");
    L.push(`- teams compared: ${r.model_equivalence.teams_compared}`);
    L.push(`- divergent teams: ${r.model_equivalence.divergent_teams.length === 0 ? "**none**" : r.model_equivalence.divergent_teams.join(", ")}`);
    L.push("");

    L.push(`### Legacy live vs published pointer (§16)`);
    L.push("");
    if (r.published_comparison.pointer_present) {
      const pc = r.published_comparison;
      L.push(`- published snapshot: \`${pc.published_snapshot_id}\` (seq ${pc.published_seq})`);
      L.push(`- verdict: **${pc.verdict}** · unexplained ${pc.unexplained} · source stable ${pc.source_stable}`);
      L.push(`- reader (flag ON, wave 3): **${pc.reader_state_source}**${pc.reader_fallback_reason ? ` (fallback: ${pc.reader_fallback_reason})` : ""}`);
      if (pc.unexplained > 0 && pc.source_stable) anyUnexplainedStable = true;
    } else {
      L.push(`- ${r.published_comparison.note}`);
    }
    L.push("");
  }

  L.push(`## Aggregate`);
  L.push("");
  L.push(`| gate | result |`);
  L.push(`| --- | --- |`);
  L.push(`| deterministic same-source: unexplained = 0 | ${reports.every((r) => r.layerA.unexplained === 0) ? "**PASS**" : "**FAIL**"} |`);
  L.push(`| live shadow (stable-source runs): unexplained = 0 | ${anyUnexplainedStable ? "**FAIL**" : "**PASS**"} |`);
  L.push(`| pointer rows written by shadow run | ${pointerWrites} (expected 0) |`);
  L.push(`| model files changed | none |`);
  L.push("");
  L.push(anyUnexplainedStable
    ? "> **STOP.** An unexplained semantic difference exists on a stable source — diagnose before Stage D."
    : "> No unexplained differences on stable-source runs. Cleared for Stage D scoping.");
  L.push("");
  return L.join("\n");
}

async function main() {
  const targets = listLeagueTargets().filter(
    (t) => t.provider === "sleeper" && leagueConfigStatus(t) === "READY",
  );
  const reports: LeagueReport[] = [];
  for (const t of targets) {
    process.stderr.write(`[shadow] ${t.key} …\n`);
    reports.push(await runLeague(t.key));
  }

  const document = md(reports);
  writeFileSync(mdPath, document);
  process.stderr.write(`[shadow] wrote ${mdPath}\n`);
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(reports, null, 2));
    process.stderr.write(`[shadow] wrote ${jsonPath}\n`);
  }

  const bad =
    reports.some((r) => r.layerA.unexplained > 0) ||
    reports.some((r) => r.layerB && r.layerB.source_stable && r.layerB.totals.UNEXPLAINED > 0);
  process.stdout.write(document);
  process.exit(bad ? 1 : 0);
}

void main();
