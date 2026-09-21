/**
 * Phase 4.5 — canonical LEAGUE MARKET-STATE evidence, Book-Ready BY CONSTRUCTION. League-level availability facts (who can be acquired, why
 * others cannot, what the rules are) expressed in the shared EvidenceBlock contract. It deliberately does NOT duplicate `waiver2.market`
 * (per-action FAAB ranges, scarcity, competitors): this topic states the substrate those consume.
 *
 * Every block carries the market CONTENT id as its identity (so a stale chapter is detected by content, not by clock), the readiness reason
 * codes, and the permanent provider limits. A market that is not actionable yields UNAVAILABLE pool blocks with the precise codes — never a
 * count presented as current.
 */
import type { MarketSnapshot } from "@/lib/market-state/contract";
import { MARKET_STATE_VERSION, PROVIDER_LIMITATIONS } from "@/lib/market-state/contract";
import { managerAcquisitionContext } from "@/lib/market-state/pool";
import { unitFor } from "../units";
import { phaseRef } from "../phase-namespaces";
import type { Component, EvidenceBlock, TemporalIdentity } from "../schema";
import { PHASE7, mk as mkRaw, notAvailable } from "../common";

export const MARKET_SURFACE = "league-market-state";
const BUILT_IN = phaseRef("INTELLIGENCE_MODERNIZATION_PHASE", "4.5");
const mk = (b: Omit<EvidenceBlock, "evidence_id" | "contract_version">, key: unknown[] = []): EvidenceBlock => {
  let x = b;
  if (x.availability.state !== "AVAILABLE") { const { predictive: _p, ...rest } = x; void _p; x = { ...rest, origin: { source_class: x.availability.state, analysis_class: "UNAVAILABLE" } }; }
  return mkRaw(x, key);
};
const temporal = (s: MarketSnapshot): TemporalIdentity => ({ season: s.season, week: s.week, through_week: null, as_of: s.as_of, generated_at: s.as_of, source_cutoff: null, point_kind: "CURRENT", as_of_kind: "CURRENT_SNAPSHOT", week_state: null, snapshot_id: null, player_team_temporal_identity: PHASE7 });
const count = (key: string, value: number, note?: string): Component => ({ key, value, unit: unitFor("market.count"), ...(note ? { note } : {}) });

export function marketStateEvidence(s: MarketSnapshot, manager?: { team_id: string; manager_slug: string }): EvidenceBlock[] {
  const subject = { kind: "LEAGUE" as const, id: s.league_slug, league_slug: s.league_slug };
  const codes = [...s.readiness.blocks, ...s.readiness.limitations];
  const base = {
    surface: MARKET_SURFACE, topic: "market.state", subject, deployment: { state: "SHARED_DESCRIPTIVE" as const, may_influence_production: false }, temporal: temporal(s),
    freshness: { as_of: s.as_of, through_week: null, generated_at: s.as_of },
    lineage: { surface_version: MARKET_STATE_VERSION, content_identity: s.identities.market_content_id, canonical: { market_content_id: s.identities.market_content_id, acquisition_context_id: s.acquisition.context_id, history_class: s.history_class, readiness_status: s.readiness.status, readiness_codes: codes, actionable: s.readiness.pool_actionable, sources: Object.fromEntries(Object.entries(s.sources).map(([k, v]) => [k, v.status])) } },
    source: { built_in: BUILT_IN, source_data: "provider league rules + rosters + player universe + transaction window + NFL schedule (derived, never a provider free-agent endpoint)" },
    limitations: Object.values(PROVIDER_LIMITATIONS), predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" as const }, origin: { source_class: "DERIVED_FROM_STATE", analysis_class: "DESCRIPTIVE" as const },
  };
  const out: EvidenceBlock[] = [];
  out.push(mk({ ...base, metric: "readiness.status", availability: { state: "AVAILABLE" }, value: s.readiness.status, unit: unitFor("category"), category: { raw: s.readiness.status, normalized: s.readiness.status, mapping_status: "VERIFIED" },
    limitations: [...base.limitations, ...s.readiness.reasons.filter((r) => r.severity !== "INFO").map((r) => `${r.code} (${r.severity}): ${r.detail}`)] }, ["readiness"]));
  const rules = s.acquisition.rules;
  out.push(mk({ ...base, metric: "rules.acquisition_system", availability: rules.system === "UNKNOWN" ? { state: "UNAVAILABLE", reason: "ACQUISITION_RULES_UNKNOWN: league waiver rules could not be established" } : { state: "AVAILABLE" }, value: rules.system, unit: unitFor("category"), category: { raw: rules.system, normalized: rules.system, mapping_status: "VERIFIED" } }, ["system"]));
  out.push(mk({ ...base, metric: "rules.waiver_clear_days", availability: rules.waiver_clear_days == null ? { state: "UNAVAILABLE", reason: "waiver_clear_days not established" } : { state: "AVAILABLE" }, value: rules.waiver_clear_days, unit: unitFor("market.days") }, ["clear"]));
  out.push(mk({ ...base, metric: "rules.faab_budget", availability: rules.system === "FAAB" && rules.faab_budget != null ? { state: "AVAILABLE" } : rules.system === "FAAB" ? { state: "UNAVAILABLE", reason: "FAAB budget not established" } : { state: "NOT_APPLICABLE", reason: "this league does not use FAAB (any stray budget value in its settings is not a currency)" }, value: rules.faab_budget, unit: unitFor("waiver2.faab_dollars") }, ["faab"]));

  const { origin: _o, predictive: _p, ...noClass } = base; void _o; void _p;
  const blocked = !s.readiness.pool_actionable; const why = `FREE_AGENT_POOL_UNAVAILABLE: ${s.readiness.blocks.join(", ")}`;
  const pool = (metric: string, value: number, components: Component[]): EvidenceBlock => (blocked
    ? notAvailable({ ...noClass, metric, limitations: [...noClass.limitations, ...s.readiness.reasons.filter((r) => r.severity === "BLOCKING").map((r) => `${r.code}: ${r.detail}`)] }, "UNAVAILABLE", why)
    : mk({ ...base, metric, availability: { state: "AVAILABLE" }, value, unit: unitFor("market.count"), components, chart: components.length ? [{ form: "bar", x: "components.key", y: "components.value" }] : undefined }, [metric]));
  const byPos: Record<string, number> = {}; for (const p of s.players) if (p.status === "AVAILABLE_FREE_AGENT") byPos[p.position ?? "UNKNOWN"] = (byPos[p.position ?? "UNKNOWN"] ?? 0) + 1;
  const unkBy: Record<string, number> = {}; for (const p of s.players) if (p.status === "UNKNOWN_AVAILABILITY" || p.status === "SOURCE_UNAVAILABLE") unkBy[p.reason ?? "UNSPECIFIED"] = (unkBy[p.reason ?? "UNSPECIFIED"] ?? 0) + 1;
  out.push(pool("pool.available_count", s.counts.AVAILABLE_FREE_AGENT, Object.entries(byPos).sort().map(([k, v]) => count(k, v))));
  out.push(pool("pool.on_waivers_count", s.counts.ON_WAIVERS, []));
  out.push(pool("pool.unknown_availability_count", s.counts.UNKNOWN_AVAILABILITY + s.counts.SOURCE_UNAVAILABLE, Object.entries(unkBy).sort().map(([k, v]) => count(k, v))));
  out.push(pool("pool.rostered_count", s.counts.ROSTERED, []));
  out.push(pool("pool.ineligible_count", Object.values(s.ineligible_counts).reduce((a, b) => a + b, 0), Object.entries(s.ineligible_counts).sort().map(([k, v]) => count(k, v))));
  // Manager acquisition context: an OVERLAY on the same league pool (the league pool identity is unchanged by who is asking).
  if (manager) {
    const c = managerAcquisitionContext(s, manager.team_id); const subj = { kind: "MANAGER_TEAM" as const, id: `${s.league_slug}/${manager.manager_slug}`, league_slug: s.league_slug, manager_slug: manager.manager_slug };
    const mb = { ...base, subject: subj, limitations: [...base.limitations, "manager overlay: league pool identity (content_identity) is identical for every manager; only these acquisition facts differ"] };
    const one = (metric: string, value: number | boolean | null, unit: string, na?: string) => out.push(mk({ ...mb, metric, availability: !c ? { state: "UNAVAILABLE", reason: "manager team not found in the market snapshot" } : value == null ? { state: na ? "NOT_APPLICABLE" : "UNAVAILABLE", reason: na ?? "not established" } : { state: "AVAILABLE" }, value: typeof value === "boolean" ? String(value) : value, unit: unitFor(unit) }, [metric, manager.manager_slug]));
    one("manager.faab_remaining", c?.faab_remaining ?? null, "waiver2.faab_dollars", s.acquisition.rules.system === "FAAB" ? undefined : "this league does not use FAAB");
    one("manager.waiver_priority", c?.waiver_priority ?? null, "market.count");
    one("manager.roster_size", c?.roster_size ?? null, "market.count"); one("manager.open_roster_slots", c?.open_roster_slots ?? null, "market.count"); one("manager.add_requires_drop", c?.requires_drop ?? null, "category");
  }
  return out;
}
