/**
 * Bloodline Bowl MCP tool catalog.
 *
 * Every tool is read-only and maps onto existing bridge routes (lib/mcp/invoke.ts).
 * Tool handlers resolve identity, call the route(s), compact the body and wrap
 * it in the shared envelope (lib/mcp/envelope.ts). They never compute fantasy
 * analytics themselves.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { absoluteUrl } from "@/lib/discovery";
import { MCP_ACCESS_MODE, MCP_CONTRACT_VERSION, MCP_SERVER_VERSION } from "./contract";
import {
  compactEvidence,
  compactHistoryWeek,
  compactLeague,
  compactLeagues,
  compactLineup,
  compactManagers,
  compactMatchup,
  compactRosterAnalysis,
  compactScoring,
  compactScoringFromState,
  compactTeam,
  compactTrade,
  compactW2r1,
  compactWaivers,
  compactWeekly,
  type Compacted,
} from "./compact";
import {
  bridgeStatus,
  deriveActionability,
  failEnvelope,
  isRouteSuccess,
  newEnvelope,
  provenanceOf,
  resultDetail,
  routeFailure,
  toToolResult,
  type Envelope,
} from "./envelope";
import {
  buildDirectory,
  loadDirectory,
  resolveLeagueInput,
  resolveManagerInput,
  resolvePlayerInput,
  resolveWeek,
  type LeagueDirectory,
  type LeagueRef,
} from "./identity";
import { callRoute, ROUTES, type RouteResult } from "./invoke";
import { obj, objs, str, strs, type J } from "./json";
import { DOC_KINDS, parseDocId, searchDocuments } from "./search";

/* --------------------------------- inputs --------------------------------- */

const league = z.string().trim().min(1).max(100).describe('League slug or exact league name, e.g. "devoted-to-the-game" or "Devoted to the Game". See bloodline_list_leagues.');
const manager = z.string().trim().min(1).max(100).describe('Manager slug, Sleeper username, display name, or exact team name, e.g. "darthmarker" or "The JSN Bourne Supremacy". See bloodline_list_managers.');
const week = z.number().int().min(1).max(18).optional().describe("NFL week. Omit for the league's current week. Weekly tools serve ONLY the current week; use bloodline_week_history for past weeks.");
const includeShadow = z.boolean().optional().describe("Also return SHADOW_ONLY research output, clearly labelled. Default false. Never present shadow numbers as production predictions.");
const detail = z.enum(["standard", "full"]).optional().describe('"standard" (default) is compact. "full" also returns the untouched bridge route body when it fits the size limit.');
const assets = z.array(z.string().trim().min(1).max(80)).min(1).max(5);

/* ------------------------------ shared plumbing ------------------------------ */

interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  run: (args: Record<string, unknown>, env: Envelope) => Promise<void>;
}

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Apply a Compacted block + its route result to the envelope. */
function applyCompacted(env: Envelope, result: Extract<RouteResult, { ok: true }>, c: Compacted, opts: { informational?: boolean; fullBody?: boolean } = {}): void {
  env.status = bridgeStatus(result);
  env.status_source = "bridge";
  env.data = c.data;
  env.deployment = { ...env.deployment, ...c.deployment };
  env.limitations.push(...c.limitations);
  env.warnings.push(...c.warnings);
  env.provenance.league_snapshot_id ??= c.snapshot_id;
  env.provenance.scoring_fingerprint ??= c.scoring_fingerprint;
  env.provenance.source_generated_at ??= c.generated_at;
  env.actionability = deriveActionability(env.status, { limited: c.limited, ...(opts.informational ? { informational: true } : {}) });
  if (c.shadow) {
    env.shadow_evidence = { deployment: "SHADOW_ONLY", may_influence_production: false, ...c.shadow };
    env.deployment.shadow_evidence = "SHADOW_ONLY";
  }
  if (opts.fullBody) env.data = { ...env.data, full_route_body: result.body };
}

async function requireLeague(env: Envelope, input: unknown): Promise<LeagueRef | null> {
  const r = resolveLeagueInput(String(input ?? ""));
  if (!r.ok) {
    failEnvelope(env, r.code, r.detail, { ...(r.candidates ? { candidates: r.candidates } : {}), next_steps: ["Call bloodline_list_leagues for the configured leagues."] });
    return null;
  }
  env.identity = { league_slug: r.league_slug, league_name: r.league_name, provider: r.provider, season: r.season };
  return r;
}

/** League + manager. The directory is optional: when the league state is unreachable the slug passes through to the route, which verifies membership itself. */
async function requireManager(env: Envelope, leagueInput: unknown, managerInput: unknown): Promise<{ league: LeagueRef; managerSlug: string; directory: LeagueDirectory | null } | null> {
  const lg = await requireLeague(env, leagueInput);
  if (!lg) return null;
  const dir = await loadDirectory(lg.league_slug);
  env.provenance.routes.push(dir.provenance);
  const directory = dir.ok ? dir.directory : null;
  if (!dir.ok) env.limitations.push(`league directory unavailable (${dir.detail}); manager names are not resolved, player ids may be unlabelled`);
  const m = resolveManagerInput(String(managerInput ?? ""), directory);
  if (!m.ok) {
    failEnvelope(env, m.code, m.detail, { ...(m.candidates ? { candidates: m.candidates } : {}), next_steps: [`Call bloodline_list_managers with league "${lg.league_slug}".`] });
    return null;
  }
  env.identity = { ...env.identity, manager_slug: m.manager_slug, matched_on: m.matched_on, display_name: m.display_name, team_name: m.team_name };
  return { league: lg, managerSlug: m.manager_slug, directory };
}

const WEEK_HINT = ["Weekly tools serve only the current week. For a past week call bloodline_week_history."];

async function weeklyCall(env: Envelope, args: Record<string, unknown>, route: "intelligence" | "lineup" | "matchup" | "waivers") {
  const ctx = await requireManager(env, args.league, args.manager);
  if (!ctx) return null;
  const wk = await resolveWeek(args.week as number | undefined, ctx.directory);
  env.request = { ...env.request, resolved_week: wk.week, week_source: wk.source };
  if (wk.week == null) {
    failEnvelope(env, "WEEK_UNRESOLVED", "The current NFL week could not be resolved; pass week explicitly.");
    return null;
  }
  const result = await callRoute({ route, params: { league: ctx.league.league_slug, manager: ctx.managerSlug, week: String(wk.week) } });
  if (!isRouteSuccess(result)) {
    routeFailure(env, result, bridgeStatus(result) === "NON_CURRENT_WEEK_UNSUPPORTED" ? WEEK_HINT : undefined);
    return null;
  }
  env.provenance.routes.push(provenanceOf(result));
  return { ...ctx, week: wk.week, result };
}

/* ---------------------------------- tools ---------------------------------- */

export const TOOLS: ToolSpec[] = [
  {
    name: "bloodline_capabilities",
    title: "Bloodline Bowl capabilities",
    description:
      "What this connector can answer, which analytics are production vs shared-context vs SHADOW_ONLY, data refresh status, and version info. Call when unsure which tool fits or to explain limitations.",
    inputSchema: z.object({}),
    run: async (_args, env) => {
      const cap = await callRoute({ route: "evidence", query: { capabilities: "1" } });
      if (isRouteSuccess(cap)) env.provenance.routes.push(provenanceOf(cap));
      const body = obj(isRouteSuccess(cap) ? cap.body : null);
      env.data = {
        server: { contract_version: MCP_CONTRACT_VERSION, server_version: MCP_SERVER_VERSION, access_mode: MCP_ACCESS_MODE },
        tools: TOOLS.map((t) => ({ name: t.name, title: t.title })),
        model_deployment: {
          weekly_engine: { deployment: "PRODUCTION", covers: "lineup, start/sit, production matchup projection, waivers, weekly summary" },
          roster_health_and_schedule_planning: { deployment: "SHARED_CONTEXT" },
          team_management_orchestrator: { deployment: "ADVISORY_ONLY" },
          competitive_trade_intelligence: { deployment: "PRODUCTION", note: "read-only analytics; NO_ACTION and REVIEW_REQUIRED are valid results" },
          matchup_simulation_ri_matchup: { deployment: "SHADOW_ONLY" },
          football_intelligence_start_sit: { deployment: "SHADOW_ONLY" },
          w2r1_current_intelligence: { deployment: "CURRENT_INTELLIGENCE", covers: "Dynamic VOR (weekly roster / league / ROS / hold / streaming / scarcity), roster+replacement simulation, D/ST + K components, upside likelihood", note: "per-component qualification: D/ST QUALIFIED_SHADOW in Devoted, Sporty's, Maclin; Rogers Park EXPLORATORY_POST_DEFECT; Bloodline D/ST and all K DIAGNOSTIC_ONLY; TE upside INSUFFICIENT_FINAL_SAMPLE; QB/RB upside DIAGNOSTIC_ONLY; WR upside and the S5 tactical layer NO_RELIABLE_SIGNAL" },
          playoff_probability: { deployment: "NOT_IMPLEMENTED", note: "no playoff-odds model exists; standings bands only" },
        },
        // Research surfaces the evidence registry reports with a lifecycle state (read generically, so a new surface needs no connector change).
        research_surfaces: Object.fromEntries(
          Object.entries(body)
            .filter(([, v]) => str(obj(v).lifecycle_state))
            .map(([k, v]) => [k, { deployment: str(obj(v).lifecycle_state), may_influence_production: obj(v).may_influence_production === true }]),
        ),
        refresh_status: body.refresh_status ?? null,
        evidence_topics: Object.keys(obj(body.topics)),
        limitations: [
          "Weekly tools serve the league's current week only.",
          "Kicker weekly projections are provider standard points (K component forecasts are DIAGNOSTIC_ONLY); defense weekly projections use W2.R1 exact-scoring component forecasts only in QUALIFIED leagues (Devoted, Sporty's, Maclin) when a frozen pregame capture exists for the week.",
          "No write actions: nothing can be submitted to Sleeper/Yahoo or sent to another manager.",
        ],
      };
      env.status = "OK";
      env.actionability = "INFORMATIONAL";
    },
  },
  {
    name: "bloodline_list_leagues",
    title: "List leagues",
    description: "List every league this service covers (slug, name, provider, season, readiness) and the current NFL week. Start here when the league is not yet known.",
    inputSchema: z.object({}),
    run: async (_args, env) => {
      const res = await callRoute({ route: "leagues" });
      if (!isRouteSuccess(res)) return void routeFailure(env, res);
      env.provenance.routes.push(provenanceOf(res));
      const wk = await resolveWeek(undefined, null);
      applyCompacted(env, res, compactLeagues(res.body, wk), { informational: true });
    },
  },
  {
    name: "bloodline_get_league",
    title: "League overview",
    description: "One league: settings (roster slots, playoff format, waivers), full standings with team and manager names, this week's matchups and scores, and snapshot freshness. Use for league-wide comparisons.",
    inputSchema: z.object({ league }),
    run: async (args, env) => {
      const lg = await requireLeague(env, args.league);
      if (!lg) return;
      const dir = await loadDirectory(lg.league_slug);
      env.provenance.routes.push(dir.provenance);
      if (!dir.ok) return void failEnvelope(env, "LEAGUE_STATE_UNAVAILABLE", dir.detail, { http_status: dir.http_status });
      const c = compactLeague(dir.directory);
      env.status = str(dir.directory.state_body.status) ?? "OK";
      env.status_source = "bridge";
      env.data = c.data;
      env.deployment = c.deployment;
      env.limitations.push(...c.limitations);
      env.warnings.push(...c.warnings);
      env.provenance.league_snapshot_id = c.snapshot_id;
      env.provenance.scoring_fingerprint = c.scoring_fingerprint;
      env.provenance.source_generated_at = c.generated_at;
      env.actionability = deriveActionability(env.status, { informational: true });
    },
  },
  {
    name: "bloodline_list_managers",
    title: "List managers",
    description: "Every manager in a league with manager_slug, display name, username, team name, rank and record. Use to find the user's own manager_slug.",
    inputSchema: z.object({ league }),
    run: async (args, env) => {
      const lg = await requireLeague(env, args.league);
      if (!lg) return;
      const dir = await loadDirectory(lg.league_slug);
      env.provenance.routes.push(dir.provenance);
      if (!dir.ok) return void failEnvelope(env, "LEAGUE_STATE_UNAVAILABLE", dir.detail, { http_status: dir.http_status });
      const c = compactManagers(dir.directory);
      env.status = str(dir.directory.state_body.status) ?? "OK";
      env.status_source = "bridge";
      env.data = c.data;
      env.deployment = c.deployment;
      env.provenance.league_snapshot_id = c.snapshot_id;
      env.actionability = "INFORMATIONAL";
    },
  },
  {
    name: "bloodline_get_team",
    title: "Team, roster and record",
    description: "A manager's team: record, standing, starters (with slots), bench, IR, injuries, this week's opponent, waiver position and data freshness.",
    inputSchema: z.object({ league, manager }),
    run: async (args, env) => {
      const ctx = await requireManager(env, args.league, args.manager);
      if (!ctx) return;
      const res = await callRoute({ route: "manager_context", params: { league: ctx.league.league_slug, manager: ctx.managerSlug } });
      if (!isRouteSuccess(res)) return void routeFailure(env, res);
      env.provenance.routes.push(provenanceOf(res));
      applyCompacted(env, res, compactTeam(res.body, ctx.directory), { informational: true });
    },
  },
  {
    name: "bloodline_get_scoring",
    title: "League scoring rules",
    description: "The league's actual scoring rules (every rule with points), derived values (e.g. points per reception, TD values), classification and example stat lines. Use instead of assuming PPR.",
    inputSchema: z.object({ league }),
    run: async (args, env) => {
      const lg = await requireLeague(env, args.league);
      if (!lg) return;
      if (lg.provider === "sleeper") {
        const res = await callRoute({ route: "scoring", params: { leagueSlug: lg.league_slug } });
        if (!isRouteSuccess(res)) return void routeFailure(env, res);
        env.provenance.routes.push(provenanceOf(res));
        return void applyCompacted(env, res, compactScoring(res.body), { informational: true });
      }
      const dir = await loadDirectory(lg.league_slug);
      env.provenance.routes.push(dir.provenance);
      if (!dir.ok) return void failEnvelope(env, "LEAGUE_STATE_UNAVAILABLE", dir.detail, { http_status: dir.http_status });
      const c = compactScoringFromState(dir.directory);
      env.status = str(dir.directory.state_body.status) ?? "OK";
      env.status_source = "bridge";
      env.data = c.data;
      env.deployment = c.deployment;
      env.provenance.scoring_fingerprint = c.scoring_fingerprint;
      env.actionability = "INFORMATIONAL";
    },
  },
  {
    name: "bloodline_weekly_analysis",
    title: "Weekly team analysis",
    description:
      "The bridge's full weekly intelligence for a manager: summary, top actions, optimal lineup, start/sit calls, production matchup projection and win probability, positional needs, top waiver moves, plus the advisory team-management action plan. Best first call for 'analyze my team this week'.",
    inputSchema: z.object({ league, manager, week, include_shadow: includeShadow }),
    run: async (args, env) => {
      const call = await weeklyCall(env, args, "intelligence");
      if (!call) return;
      const orch = await callRoute({ route: "orchestrate", params: { leagueSlug: call.league.league_slug, managerSlug: call.managerSlug } });
      env.provenance.routes.push(provenanceOf(orch));
      const orchBody = isRouteSuccess(orch) ? orch.body : null;
      if (!orchBody) env.limitations.push(`action_plan unavailable (${bridgeStatus(orch)})`);
      applyCompacted(env, call.result, compactWeekly(call.result.body, orchBody, call.directory, args.include_shadow === true));
    },
  },
  {
    name: "bloodline_start_sit",
    title: "Start/sit and lineup",
    description: "Lineup recommendation for the current week: every starting slot with recommended vs current player, projection, floor/ceiling, confidence and reason; head-to-head start/sit decisions; injuries and bye problems.",
    inputSchema: z.object({ league, manager, week, detail }),
    run: async (args, env) => {
      const call = await weeklyCall(env, args, "lineup");
      if (!call) return;
      applyCompacted(env, call.result, compactLineup(call.result.body, call.directory), { fullBody: args.detail === "full" });
    },
  },
  {
    name: "bloodline_matchup_analysis",
    title: "Matchup analysis",
    description: "This week's matchup: both projected lineups, projected margin, production win probability (with its confidence), positional edges, swing and high-leverage players, bench depth.",
    inputSchema: z.object({ league, manager, week, include_shadow: includeShadow, detail }),
    run: async (args, env) => {
      const call = await weeklyCall(env, args, "matchup");
      if (!call) return;
      let shadowSource: unknown = null;
      if (args.include_shadow === true) {
        const intel = await callRoute({ route: "intelligence", params: { league: call.league.league_slug, manager: call.managerSlug, week: String(call.week) } });
        env.provenance.routes.push(provenanceOf(intel));
        shadowSource = isRouteSuccess(intel) ? intel.body : null;
      }
      applyCompacted(env, call.result, compactMatchup(call.result.body, call.directory, shadowSource), { fullBody: args.detail === "full" });
    },
  },
  {
    name: "bloodline_waiver_analysis",
    title: "Waiver wire",
    description: "Waiver/free-agent recommendations for the current week: add/drop pairs with net roster gain, priority, confidence and reasons, FAAB/priority context, and players not to add. States explicitly when the free-agent pool is unavailable.",
    inputSchema: z.object({ league, manager, week, detail }),
    run: async (args, env) => {
      const call = await weeklyCall(env, args, "waivers");
      if (!call) return;
      applyCompacted(env, call.result, compactWaivers(call.result.body, args.detail === "full"), { fullBody: args.detail === "full" });
    },
  },
  {
    name: "bloodline_analyze_roster",
    title: "Roster health and season outlook",
    description: "Roster strength and depth by position (this week and rest of season), league-relative percentiles, bye-week exposure and schedule plan through the fantasy playoffs, plus season position (standings, playoff position band, contender/rebuild archetype). Use for 'how good is my team' and playoff outlook.",
    inputSchema: z.object({ league, manager }),
    run: async (args, env) => {
      const ctx = await requireManager(env, args.league, args.manager);
      if (!ctx) return;
      const p = { leagueSlug: ctx.league.league_slug, managerSlug: ctx.managerSlug };
      const [rh, sp, sc] = await Promise.all([
        callRoute({ route: "roster_health", params: p }),
        callRoute({ route: "schedule_planning", params: p }),
        callRoute({ route: "strategic_context", params: p }),
      ]);
      if (!isRouteSuccess(rh)) return void routeFailure(env, rh);
      for (const r of [rh, sp, sc]) env.provenance.routes.push(provenanceOf(r));
      if (!isRouteSuccess(sp)) env.limitations.push(`schedule planning unavailable (${bridgeStatus(sp)})`);
      if (!isRouteSuccess(sc)) env.limitations.push(`season position unavailable (${bridgeStatus(sc)})`);
      applyCompacted(env, rh, compactRosterAnalysis(rh.body, isRouteSuccess(sp) ? sp.body : null, isRouteSuccess(sc) ? sc.body : null, ctx.directory));
      // roster-health has no top-level status field; its degradation drives actionability.
      env.actionability = deriveActionability("OK", { limited: env.limitations.length > 0 });
    },
  },
  {
    name: "bloodline_trade_evaluation",
    title: "Evaluate a trade",
    description:
      "Evaluate one explicit trade between the manager and a counterparty using the bridge's competitive trade engine (league scoring, replacement value, horizons, acceptance plausibility). Player names are fine. Read-only: never proposes or submits anything. NO_ACTION and REVIEW_REQUIRED are valid answers.",
    inputSchema: z.object({
      league,
      manager,
      counterparty: z.string().trim().min(1).max(100).describe("The other manager (slug, username, display or team name)."),
      give: assets.describe("Players the manager would send (names or Sleeper ids), 1-5."),
      receive: assets.describe("Players the manager would get (names or Sleeper ids), 1-5."),
      mode: z.enum(["evaluate", "negotiate"]).optional().describe('"evaluate" (default) or "negotiate" (adds the negotiation envelope).'),
    }),
    run: async (args, env) => {
      const ctx = await requireManager(env, args.league, args.manager);
      if (!ctx) return;
      const cp = resolveManagerInput(String(args.counterparty), ctx.directory);
      if (!cp.ok) return void failEnvelope(env, cp.code, `counterparty: ${cp.detail}`, cp.candidates ? { candidates: cp.candidates } : {});
      if (cp.manager_slug === ctx.managerSlug) return void failEnvelope(env, "INVALID_INPUT", "counterparty must be a different manager.");
      env.identity = { ...env.identity, counterparty_slug: cp.manager_slug };
      const res = await callRoute({
        route: "competitive_trade",
        body: { league: ctx.league.league_slug, manager: ctx.managerSlug, mode: args.mode ?? "evaluate", counterparty: cp.manager_slug, give_assets: args.give, receive_assets: args.receive },
        timeoutMs: 80_000,
      });
      if (!isRouteSuccess(res)) return void routeFailure(env, res);
      env.provenance.routes.push(provenanceOf(res));
      applyCompacted(env, res, compactTrade(res.body));
    },
  },
  {
    name: "bloodline_trade_discovery",
    title: "Find trades",
    description:
      'Search for trades that improve the manager\'s championship equity while staying plausibly acceptable to the other side ("discover"), or compare direct trade vs hold vs multi-step paths ("strategy_path"). Read-only. Returns candidates with transaction readiness and confidence; NO_ACTION is a valid answer.',
    inputSchema: z.object({ league, manager, mode: z.enum(["discover", "strategy_path"]).optional().describe('Default "discover".') }),
    run: async (args, env) => {
      const ctx = await requireManager(env, args.league, args.manager);
      if (!ctx) return;
      const res = await callRoute({ route: "competitive_trade", body: { league: ctx.league.league_slug, manager: ctx.managerSlug, mode: args.mode ?? "discover" }, timeoutMs: 80_000 });
      if (!isRouteSuccess(res)) return void routeFailure(env, res);
      env.provenance.routes.push(provenanceOf(res));
      applyCompacted(env, res, compactTrade(res.body));
    },
  },
  {
    name: "bloodline_week_history",
    title: "Past week results",
    description: "A completed (or captured) past week: league scoreboard, standings after that week and, with a manager, both lineups with every player's actual points and the result. Use for 'why did I lose last week'.",
    inputSchema: z.object({ league, week: z.number().int().min(1).max(18).describe("The past NFL week."), manager: manager.optional() }),
    run: async (args, env) => {
      const lg = await requireLeague(env, args.league);
      if (!lg) return;
      let managerSlug: string | null = null;
      if (args.manager) {
        const dir = await loadDirectory(lg.league_slug);
        const m = resolveManagerInput(String(args.manager), dir.ok ? dir.directory : null);
        if (!m.ok) return void failEnvelope(env, m.code, m.detail, m.candidates ? { candidates: m.candidates } : {});
        managerSlug = m.manager_slug;
        env.identity = { ...env.identity, manager_slug: m.manager_slug, display_name: m.display_name, team_name: m.team_name };
      }
      const res = await callRoute({ route: "history_week", params: { league: lg.league_slug, week: String(args.week) } });
      if (!isRouteSuccess(res)) return void routeFailure(env, res);
      env.provenance.routes.push(provenanceOf(res));
      if (!obj(res.body).snapshot) {
        env.status = bridgeStatus(res);
        env.status_source = "bridge";
        env.actionability = "NOT_ACTIONABLE";
        env.data = { week: args.week, detail: str(obj(res.body).detail) };
        return;
      }
      applyCompacted(env, res, compactHistoryWeek(res.body, lg.league_slug, managerSlug, buildDirectory), { informational: true });
    },
  },
  {
    name: "bloodline_player_analysis",
    title: "Player analysis",
    description: "One NFL player: observed usage (snap share, routes, targets, carries), role/opportunity profile and, with a league, the season projection under that league's scoring and which team rosters him. Accepts a name or Sleeper id.",
    inputSchema: z.object({
      player: z.string().trim().min(1).max(80).describe('Player name (exact full name, e.g. "Bucky Irving") or Sleeper player id.'),
      league: league.optional(),
      position: z.string().trim().max(4).optional().describe("Disambiguate a shared name, e.g. WR."),
      nfl_team: z.string().trim().max(4).optional().describe("Disambiguate a shared name, e.g. TB."),
    }),
    run: async (args, env) => {
      const p = await resolvePlayerInput(String(args.player), { ...(args.position ? { position: String(args.position) } : {}), ...(args.nfl_team ? { nfl_team: String(args.nfl_team) } : {}) });
      if (!p.ok) return void failEnvelope(env, p.code, p.detail, p.candidates ? { candidates: p.candidates } : {});
      env.identity = { player: { sleeper_id: p.sleeper_id, name: p.name, position: p.position, nfl_team: p.nfl_team, injury_status: p.injury_status, matched_on: p.matched_on } };
      let lg: LeagueRef | null = null;
      if (args.league) {
        const r = resolveLeagueInput(String(args.league));
        if (!r.ok) return void failEnvelope(env, r.code, r.detail, r.candidates ? { candidates: r.candidates } : {});
        lg = r;
        env.identity.league_slug = r.league_slug;
      }
      const [usage, role, proj, dir] = await Promise.all([
        callRoute({ route: "evidence", query: { topic: "fi.player_usage", sleeper_id: p.sleeper_id } }),
        callRoute({ route: "evidence", query: { topic: "role.player_profile", sleeper_id: p.sleeper_id } }),
        lg ? callRoute({ route: "player_projection", params: { leagueSlug: lg.league_slug, playerId: p.sleeper_id } }) : Promise.resolve(null),
        lg ? loadDirectory(lg.league_slug) : Promise.resolve(null),
      ]);
      const data: J = {};
      for (const [key, res] of [["observed_usage", usage], ["role_profile", role]] as const) {
        env.provenance.routes.push(provenanceOf(res));
        if (isRouteSuccess(res)) {
          const c = compactEvidence(res.body);
          data[key] = c.data;
          env.deployment[key] = c.deployment.blocks ?? "DESCRIPTIVE";
          env.limitations.push(...c.limitations.map((l) => `${key}: ${l}`));
        } else {
          data[key] = { status: bridgeStatus(res), detail: resultDetail(res) };
          env.limitations.push(`${key} unavailable (${bridgeStatus(res)})`);
        }
      }
      if (proj) {
        env.provenance.routes.push(provenanceOf(proj));
        if (isRouteSuccess(proj)) {
          const b = obj(proj.body);
          data.season_projection = { meta: b.meta ?? null, league_projection: b.league_projection ?? null, scoring_hash: b.scoring_hash ?? null };
          env.deployment.season_projection = "PRODUCTION";
        } else {
          data.season_projection = { status: bridgeStatus(proj), detail: resultDetail(proj) };
        }
      }
      if (dir) env.provenance.routes.push(dir.provenance);
      if (dir && dir.ok) {
        // Canonical ids may be gsis-keyed through the crosswalk; match via the snapshot's own identifiers.
        const id = dir.directory.by_sleeper_id.get(p.sleeper_id) ?? `player:sleeper:${p.sleeper_id}`;
        const rosters = objs(obj(dir.directory.state_body.state).rosters);
        const owner = rosters.find((r) => strs(r.all_players).includes(id));
        const team = owner ? dir.directory.teams.get(str(owner.canonical_team_id) ?? "") : undefined;
        data.league_roster_status = owner
          ? { rostered: true, team_id: str(owner.canonical_team_id), team_name: team?.team_name ?? null, managers: team?.manager_names ?? [] }
          : { rostered: false, note: "Not on any roster in the league snapshot. This is not a waiver-eligibility verdict; use bloodline_waiver_analysis." };
      }
      env.data = data;
      env.status = "OK";
      env.actionability = "INFORMATIONAL";
    },
  },
  {
    name: "bloodline_dynamic_vor",
    title: "Dynamic VOR and current W2.R1 intelligence",
    description:
      "Current W2.R1 intelligence on the manager's real roster: Dynamic VOR (weekly roster, league, ROS, hold, streaming, scarcity) with replacement chain, acquisition uncertainty and FAAB context; D/ST and K components under exact league scoring; upside likelihood; per-component qualification. views: roster, player/drop (need player), add, kdst|dst, upside, qualification, compare. Read-only; unknown is never 0.",
    inputSchema: z.object({
      league, manager,
      view: z.enum(["roster", "player", "drop", "add", "kdst", "dst", "upside", "qualification", "compare"]).optional().describe('Which view. Default "roster".'),
      player: z.string().trim().min(1).max(100).optional().describe('Canonical player id or name — required for views "player" and "drop".'),
      pos: z.enum(["QB", "RB", "WR", "TE"]).optional().describe('upside view: also list the top frozen upside rows for this position.'),
      week, detail,
    }),
    run: async (args, env) => {
      const ctx = await requireManager(env, args.league, args.manager);
      if (!ctx) return;
      const wk = await resolveWeek(args.week as number | undefined, ctx.directory);
      env.request = { ...env.request, resolved_week: wk.week, week_source: wk.source };
      if (wk.week == null) return void failEnvelope(env, "WEEK_UNRESOLVED", "The current NFL week could not be resolved; pass week explicitly.");
      const view = String(args.view ?? "roster");
      if ((view === "player" || view === "drop") && !args.player) return void failEnvelope(env, "INVALID_INPUT", `view "${view}" requires the player argument.`);
      const res = await callRoute({ route: "w2r1", params: { league: ctx.league.league_slug, manager: ctx.managerSlug, view }, query: { week: String(wk.week), ...(args.player ? { player: String(args.player) } : {}), ...(args.pos ? { pos: String(args.pos) } : {}) } });
      if (!isRouteSuccess(res)) return void routeFailure(env, res, bridgeStatus(res) === "NON_CURRENT_WEEK_UNSUPPORTED" ? WEEK_HINT : undefined);
      env.provenance.routes.push(provenanceOf(res));
      applyCompacted(env, res, compactW2r1(res.body), { fullBody: args.detail === "full" });
    },
  },
  {
    name: "bloodline_evidence",
    title: "Analytical evidence",
    description:
      "Advanced: structured evidence by topic (football-intelligence team metrics and player usage, role profiles, scheme, matchup-2 coverage, league week summary, model audit). Every block keeps its unit, confidence, sample size, freshness and deployment label. Call bloodline_capabilities for topics.",
    inputSchema: z.object({
      topic: z.string().trim().min(3).max(60).describe('Evidence topic, e.g. "fi.team_metric", "league.week_summary".'),
      params: z.record(z.string().regex(/^[a-z_]{1,32}$/), z.string().max(100)).optional().describe('Topic parameters, e.g. {"team":"KC"} or {"league":"bloodline-bowl","manager":"supyo29"}.'),
      detail,
    }),
    run: async (args, env) => {
      const params = obj(args.params) as Record<string, string>;
      for (const banned of ["topic", "capabilities"]) delete params[banned];
      const res = await callRoute({ route: "evidence", query: { topic: String(args.topic), ...params } });
      if (!isRouteSuccess(res)) return void routeFailure(env, res, ["Call bloodline_capabilities for valid topics and required params."]);
      env.provenance.routes.push(provenanceOf(res));
      applyCompacted(env, res, compactEvidence(res.body), { informational: true, fullBody: args.detail === "full" });
    },
  },
];

/* ------------------------------ registration ------------------------------ */

function logCall(entry: J): void {
  // One structured line per tool call. Arguments are league/manager/week/topic
  // identifiers only — never tokens, headers or response bodies.
  console.log(JSON.stringify({ evt: "mcp_tool_call", ...entry }));
}

export async function runTool(spec: ToolSpec, args: Record<string, unknown>) {
  const requestId = randomUUID();
  const started = Date.now();
  const env = newEnvelope(spec.name, { ...args });
  try {
    await spec.run(args, env);
  } catch (error) {
    failEnvelope(env, "CONNECTOR_ERROR", error instanceof Error ? error.message.slice(0, 300) : "unknown error");
  }
  (env.provenance as J).request_id = requestId;
  const result = toToolResult(env);
  const finalEnv = result.structuredContent as unknown as Envelope;
  logCall({
    request_id: requestId,
    tool: spec.name,
    league: args.league ?? null,
    manager: args.manager ?? null,
    week: env.request.resolved_week ?? args.week ?? null,
    status: finalEnv.status,
    actionability: finalEnv.actionability,
    ms: Date.now() - started,
    response_bytes: finalEnv.provenance.response_bytes ?? null,
    upstream: finalEnv.provenance.routes.map((r) => `${r.route}:${r.http_status ?? "x"}:${r.ms}ms`),
  });
  return result;
}

/** ChatGPT deep-research retrieval pair. Shapes follow OpenAI's search/fetch contract. */
function registerRetrievalTools(server: McpServer): void {
  server.registerTool(
    "search",
    {
      title: "Search Bloodline Bowl",
      description: "Find Bloodline Bowl analyses (league standings, a manager's weekly analysis, lineup, matchup, waivers, roster outlook, trades, scoring) for a question that names a league, manager or team. Returns document ids for fetch.",
      inputSchema: z.object({ query: z.string().trim().min(1).max(300).describe("A natural-language question, e.g. \"DarthMarker waivers in Devoted to the Game\".") }),
      annotations: { title: "Search Bloodline Bowl", ...READ_ONLY_ANNOTATIONS },
    },
    async (args: { query: string }) => {
      const started = Date.now();
      const results = await searchDocuments(args.query);
      logCall({ tool: "search", status: "OK", ms: Date.now() - started, results: results.length });
      const payload = { results };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
    },
  );
  server.registerTool(
    "fetch",
    {
      title: "Fetch a Bloodline Bowl analysis",
      description: "Fetch one document returned by search. The text is the full JSON result of the matching Bloodline Bowl tool, including status, limitations and deployment labels.",
      inputSchema: z.object({ id: z.string().trim().min(4).max(200).describe('A document id from search, e.g. "bb:weekly:devoted-to-the-game:darthmarker".') }),
      annotations: { title: "Fetch a Bloodline Bowl analysis", ...READ_ONLY_ANNOTATIONS },
    },
    async (args: { id: string }) => {
      const parsed = parseDocId(args.id);
      if (!parsed) {
        const err = { id: args.id, title: "Unknown document", text: JSON.stringify({ status: "INVALID_INPUT", detail: "Unknown document id; call search first." }), url: null, metadata: { status: "INVALID_INPUT" } };
        return { content: [{ type: "text" as const, text: JSON.stringify(err) }], structuredContent: err, isError: true };
      }
      const kind = DOC_KINDS[parsed.kind];
      const spec = TOOLS.find((t) => t.name === kind.tool)!;
      const result = await runTool(spec, { league: parsed.league, ...(parsed.manager ? { manager: parsed.manager } : {}) });
      const env = result.structuredContent as unknown as Envelope;
      const doc = {
        id: args.id,
        title: `${kind.title} — ${parsed.manager ? `${parsed.manager}, ` : ""}${parsed.league}`,
        text: result.content[0]!.text,
        url: absoluteUrl(kind.route(parsed.league, parsed.manager)),
        metadata: { tool: kind.tool, status: env.status, actionability: env.actionability, league_snapshot_id: env.provenance.league_snapshot_id },
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(doc) }], structuredContent: doc, ...(result.isError ? { isError: true } : {}) };
    },
  );
}

export function registerTools(server: McpServer): void {
  registerRetrievalTools(server);
  for (const spec of TOOLS) {
    server.registerTool(
      spec.name,
      { title: spec.title, description: spec.description, inputSchema: spec.inputSchema, annotations: { title: spec.title, ...READ_ONLY_ANNOTATIONS } },
      async (args: Record<string, unknown>) => runTool(spec, args),
    );
  }
}

/** Route templates each tool may call, for docs and the capability catalog. */
export const ROUTE_TEMPLATES = Object.fromEntries(Object.entries(ROUTES).map(([k, v]) => [k, v.template]));
