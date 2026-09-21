/**
 * Phase 3.5D — capability-aware researchability. METADATA ONLY: reads the single surface registry, the served manifests
 * and the history-store manifest. It never queries evidence and never runs a model. Contents therefore stays fast and
 * cannot advertise a capability the registry does not declare.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bind, CostClass, EvidenceIdentity, Need, Researchability, ChapterResearchability, BookSubject } from "./schema";
import { TOPIC_META, UNSUPPORTED_CAPABILITIES } from "./topics";

export interface SurfaceCapability { capability_state: string; history_class: string; cadence: string }
export interface CapabilitySnapshot {
  registry_version: string;
  season: number;
  surfaces: Record<string, SurfaceCapability>;
  vintage: Record<string, EvidenceIdentity & { lag_weeks: number | null }>;
  /** distinct preserved COMPLETE through_weeks per surface in the immutable history store */
  history_weeks: Record<string, number>;
  frontier: number | null;
}

const rj = (root: string, rel: string): Record<string, any> | null => { const p = join(root, rel); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; }; // eslint-disable-line @typescript-eslint/no-explicit-any
const ver = (v: string | null) => { const m = /:(\d{4}):w(\d+)/.exec(v ?? ""); return m ? { season: Number(m[1]), week: Number(m[2]) } : { season: null, week: null }; };

export function loadCapabilitySnapshot(root = process.cwd(), season = 2026): CapabilitySnapshot {
  const reg = rj(root, "docs/intelligence-surface-registry.json");
  if (!reg) throw new Error("surface registry missing: the planner cannot infer capabilities without it");
  const surfaces: Record<string, SurfaceCapability> = {};
  for (const s of reg.surfaces) if (s.book_ready) surfaces[s.id] = { capability_state: s.book_ready.capability_state, history_class: s.book_ready.history.class, cadence: s.book_ready.refresh_policy.cadence };
  const fi = rj(root, "lib/football-intel/data/football_intelligence_manifest.json");
  const wc = fi?.week_completion; const frontier: number | null = wc?.latest_week ? (wc.week_state === "COMPLETE" ? wc.latest_week : wc.latest_week - 1) : null;
  const mk = (surface: string, rel: string, key: string, weekKey = "through_week"): [string, EvidenceIdentity & { lag_weeks: number | null }] => {
    const m = rj(root, rel); const version: string | null = m?.[key] ?? null; const v = ver(version); const tw: number | null = m?.[weekKey] ?? v.week;
    const lag = surface === "player-scheme" ? null : frontier === null || tw === null ? null : Math.max(0, frontier - tw);
    return [surface, { surface, version, season: v.season, through_week: tw, week_state: surface === "football-intelligence" ? (wc?.week_state ?? null) : null, lag_weeks: lag }];
  };
  const vintage = Object.fromEntries([
    mk("football-intelligence", "lib/football-intel/data/football_intelligence_manifest.json", "football_intelligence_version"),
    mk("role-opportunity", "lib/player-role-intelligence/data/role_opportunity_manifest.json", "role_opportunity_version"),
    mk("opportunity-propagation", "lib/opportunity-propagation-intelligence/data/opportunity_propagation_manifest.json", "opportunity_propagation_version"),
    mk("player-scheme", "lib/player-scheme-intelligence/data/player_scheme_manifest.json", "player_scheme_version"),
  ]);
  const hist = rj(root, "data/intelligence-history/manifest.json"); const hw: Record<string, Set<number>> = {};
  for (const e of hist?.entries ?? []) if (e.week_state === "COMPLETE") (hw[e.surface] ??= new Set()).add(e.through_week);
  return { registry_version: reg.registry_version, season, surfaces, vintage, history_weeks: Object.fromEntries(Object.entries(hw).map(([k, v]) => [k, v.size])), frontier };
}

export const HISTORY_MIN_POINTS = 3;
const COST_ORDER: CostClass[] = ["FAST", "MODERATE", "EXPENSIVE"];
export const maxCost = (a: CostClass, b: CostClass): CostClass => (COST_ORDER.indexOf(a) >= COST_ORDER.indexOf(b) ? a : b);

/* ------------------------------------------------------------------------------------------------ binding */
export interface Binding { params: Array<Record<string, string>>; missing: string[] }
/** How a Need's parameters derive from the subject. Returns what is missing instead of guessing. */
export function bindNeed(need: Need, s: BookSubject): Binding {
  const missing: string[] = []; const extra = need.params ?? {}; const out: Array<Record<string, string>> = [];
  const push = (p: Record<string, string>) => out.push({ ...p, ...extra });
  const bind: Bind = need.bind;
  const playersFor = need.positions ? s.players.filter((p) => !p.position || need.positions!.includes(p.position)) : s.players;
  const teamOf = (): string[] => [...new Set([s.team, ...s.players.map((p) => p.team)].filter((x): x is string => !!x))];
  if (bind === "self" || bind === "each_player") { const ids = playersFor.filter((p) => p.gsis_id); if (!ids.length) missing.push("player identity (gsis_id)"); for (const p of ids) push({ gsis_id: p.gsis_id! }); }
  else if (bind === "own_team") { const t = teamOf(); if (!t.length) missing.push("team"); if (need.scenario) { for (const team of t) push({ team, season: String(s.season), week: String(s.week ?? ""), unavailable: "$SCENARIO_INPUT" }); if (!s.week) missing.push("week"); } else for (const team of t) push({ team }); }
  else if (bind === "opponent") { const t = [...new Set([s.opponent_team, ...s.players.map((p) => p.opponent)].filter((x): x is string => !!x))]; if (!t.length) missing.push("opponent"); for (const team of t) push({ team }); }
  else if (bind === "both_teams") { const t = [...new Set([...teamOf(), s.opponent_team].filter((x): x is string => !!x))]; if (t.length < 2) missing.push("both teams"); for (const team of t) push({ team }); }
  else if (bind === "team_qb") { const t = teamOf(); const q = t.map((x) => s.team_qb_gsis?.[x]).filter((x): x is string => !!x); if (!q.length) missing.push("team quarterback identity"); for (const g of q) push({ gsis_id: g }); }
  else if (bind === "manager") { if (!s.league || !s.manager) missing.push(s.unresolved.some((u) => u.startsWith("manager:")) ? "manager (unresolved reference)" : "league + manager context"); else push({ league: s.league, manager: s.manager }); }
  return { params: missing.length ? [] : out, missing };
}

/* ------------------------------------------------------------------------------------------------ evaluation */
type NeedEval =
  | { kind: "NOT_APPLICABLE" }
  | { kind: "UNSUPPORTED"; reason: string; need: Need }
  | { kind: "MISSING_CONTEXT"; missing: string[]; need: Need }
  | { kind: "SUPPORTED"; flags: Researchability[]; reasons: string[]; cost: CostClass; need: Need };

export function evaluateNeed(need: Need, s: BookSubject, snap: CapabilitySnapshot): NeedEval {
  if (need.positions) { const known = s.players.filter((p) => p.position); if (known.length && !known.some((p) => need.positions!.includes(p.position!))) return { kind: "NOT_APPLICABLE" }; if (!s.players.length) return { kind: "NOT_APPLICABLE" }; }
  if (need.capability) return { kind: "UNSUPPORTED", reason: `${need.capability}: ${UNSUPPORTED_CAPABILITIES[need.capability] ?? "undeclared capability"}`, need };
  const meta = TOPIC_META[need.topic!]; if (!meta) return { kind: "UNSUPPORTED", reason: `${need.topic}: not a Book-Ready topic`, need };
  const sc = snap.surfaces[meta.surface];
  if (!sc) return { kind: "UNSUPPORTED", reason: `${meta.surface}: not in the surface registry`, need };
  if (sc.capability_state === "UNSUPPORTED" || sc.capability_state === "NOT_A_DATA_SURFACE") return { kind: "UNSUPPORTED", reason: `${meta.surface}: registry capability ${sc.capability_state} (${need.topic})`, need };
  const b = bindNeed(need, s); if (b.missing.length) return { kind: "MISSING_CONTEXT", missing: b.missing, need };
  const flags: Researchability[] = []; const reasons: string[] = [];
  if (need.scenario) { flags.push("CONDITIONAL"); reasons.push("conditional scenario evidence: needs a consumer-supplied scenario; never an unconditional projection"); }
  if (need.history && !meta.history_capable) { flags.push("CURRENT_ONLY"); reasons.push(`${need.topic}: serves no history through /api/evidence (current values only)`); }
  else if (need.history) {
    if (sc.history_class === "NATIVE_HISTORY") { const n = snap.history_weeks[meta.surface] ?? 0; if (n < HISTORY_MIN_POINTS) { flags.push("HISTORY_LIMITED"); reasons.push(`${meta.surface}: only ${n} preserved complete-week state(s) (need ≥${HISTORY_MIN_POINTS} for a series)`); } }
    else { flags.push("CURRENT_ONLY"); reasons.push(`${meta.surface}: history class ${sc.history_class} — no retrievable history through /api/evidence`); }
  }
  if (need.comparisons && !meta.comparison_capable) reasons.push(`${need.topic}: serves no comparison populations through /api/evidence`);
  if (sc.capability_state === "PARTIAL" && !need.scenario) { flags.push("PARTIAL"); reasons.push(`${meta.surface}: registry capability PARTIAL; runtime availability is decided by its readiness contract`); }
  if (meta.flags?.includes("PROVIDER_LIMIT_PARTIAL")) { flags.push("PARTIAL"); reasons.push(meta.flag_reason ?? `${need.topic}: provider-limited`); }
  if (sc.capability_state === "SOURCE_CONFLICT" || meta.flags?.includes("SOURCE_CONFLICT_PARTIAL")) { flags.push("SOURCE_CONFLICT"); reasons.push(meta.flag_reason ?? `${meta.surface}: source conflict`); }
  if (sc.capability_state === "EXPECTED_SOURCE_LAG") flags.push("SOURCE_LAG");
  const v = snap.vintage[meta.surface];
  if (v) {
    if (v.lag_weeks && v.lag_weeks > 0) { flags.push("SOURCE_LAG"); reasons.push(`${meta.surface}: through week ${v.through_week} is ${v.lag_weeks} complete week(s) behind the FI frontier`); }
    if (v.season !== null && v.season < snap.season) { flags.push("SOURCE_LAG"); reasons.push(`${meta.surface}: data is ${v.version} (prior season only; no ${snap.season} signal yet)`); }
  }
  return { kind: "SUPPORTED", flags, reasons, cost: meta.cost, need };
}

/** PARTIAL_NEED (a required need is missing) outranks every degradation; a surface that is merely registry-PARTIAL ranks below the more specific limits. */
type Flag = Researchability | "PARTIAL_NEED";
const PRECEDENCE: Flag[] = ["PARTIAL_NEED", "SOURCE_CONFLICT", "SOURCE_LAG", "CONDITIONAL", "CURRENT_ONLY", "HISTORY_LIMITED", "PARTIAL", "READY"];

export function evaluateChapter(needs: Need[], subject: BookSubject, snap: CapabilitySnapshot, synthesis = false): ChapterResearchability {
  if (synthesis) return { state: "READY", reasons: ["computed from session state; performs no evidence retrieval"], cost: "FAST", unsupported: [], missing_context: [] };
  const evals = needs.map((n) => evaluateNeed(n, subject, snap)).filter((e): e is Exclude<NeedEval, { kind: "NOT_APPLICABLE" }> => e.kind !== "NOT_APPLICABLE");
  const required = evals.filter((e) => e.need.role === "required");
  const enrich = evals.filter((e) => e.need.role === "enrich");
  const unsupported = evals.flatMap((e) => (e.kind === "UNSUPPORTED" ? [e.reason] : [])); const missing = evals.flatMap((e) => (e.kind === "MISSING_CONTEXT" ? e.missing : []));
  const okReq = required.filter((e) => e.kind === "SUPPORTED"); const reasons: string[] = [];
  // cost is what opening the chapter WOULD incur once its context exists (a missing-manager chapter is still EXPENSIVE if it needs Start/Sit)
  let cost: CostClass = "FAST"; for (const e of required) if (e.need.topic && TOPIC_META[e.need.topic]) cost = maxCost(cost, TOPIC_META[e.need.topic]!.cost);
  for (const e of required) { if (e.kind === "UNSUPPORTED") reasons.push(`required evidence unsupported — ${e.reason}`); if (e.kind === "MISSING_CONTEXT") reasons.push(`required evidence needs context: ${e.missing.join(", ")}`); }
  for (const e of enrich) { if (e.kind === "UNSUPPORTED") reasons.push(`enrichment unsupported — ${e.reason}`); if (e.kind === "MISSING_CONTEXT") reasons.push(`enrichment needs context: ${e.missing.join(", ")}`); }
  if (!required.length) return { state: "UNAVAILABLE", reasons: ["no required evidence applies to this subject"], cost, unsupported, missing_context: missing };
  if (!okReq.length) {
    const relatedOk = enrich.filter((e) => e.kind === "SUPPORTED").length; if (relatedOk) reasons.push(`${relatedOk} related enrichment source(s) exist but cannot answer the question alone`);
    const onlyUnsupported = required.every((e) => e.kind === "UNSUPPORTED");
    return { state: onlyUnsupported ? "UNSUPPORTED" : "UNAVAILABLE", reasons, cost, unsupported, missing_context: missing };
  }
  const flags: Flag[] = []; for (const e of okReq) if (e.kind === "SUPPORTED") { flags.push(...e.flags); reasons.push(...e.reasons); }
  for (const e of enrich) if (e.kind === "SUPPORTED") for (const r of e.reasons) reasons.push(`enrichment: ${r}`);
  if (okReq.length < required.length) flags.push("PARTIAL_NEED");
  const top = PRECEDENCE.find((p) => p === "READY" || flags.includes(p)) ?? "READY"; const state: Researchability = top === "PARTIAL_NEED" ? "PARTIAL" : top;
  return { state, reasons: [...new Set(reasons)], cost, unsupported, missing_context: missing };
}
