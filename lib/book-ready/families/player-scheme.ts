/** Phase 3.5C — Player-Scheme evidence (descriptive distributions; source-native labels; source conflict preserved). */
import { playerSchemeContentIdentity } from "@/lib/player-scheme-intelligence/query";
import { loadFootballIntelligence } from "@/lib/football-intel/read";
import { buildFootballIntelligenceLineage } from "@/lib/football-intel/lineage";
import { analysisClassFor, categoryFor, sampleSupportFor } from "../vocabulary";
import { classifyIdentity } from "../identity";
import { unitFor } from "../units";
import { phaseRef } from "../phase-namespaces";
import type { Component, EvidenceBlock, TemporalIdentity } from "../schema";
import { PHASE7, mk, notAvailable, num, readCurrentCsv, type QueryContext } from "../common";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SURFACE = "player-scheme";
const BUILT_IN = phaseRef("TEAM_MANAGEMENT_PHASE", "9");
const DEPLOYMENT = { state: "SHARED_DESCRIPTIVE", may_influence_production: false } as const;
const DIR = "lib/player-scheme-intelligence/data";
/** FTN read_thrown named buckets that ARE source-supported; numeric RAW_* stay unverified. */
const VERIFIED_NAMED = new Set(["CHECKDOWN", "DESIGNED", "SCRAMBLE_DRILL", "OTHER"]);

export interface SchemeQuery { gsis_id?: string; team?: string; window?: string; comparisons?: boolean }

function meta(ctx: QueryContext) {
  const m = JSON.parse(readFileSync(join(ctx.root, DIR, "player_scheme_manifest.json"), "utf8"));
  const cid = playerSchemeContentIdentity(m);
  const fi = loadFootballIntelligence(); const fiLineage = fi ? buildFootballIntelligenceLineage(fi) : null;
  const temporal: TemporalIdentity = { season: m.current_season, week: null, through_week: m.as_of_week, as_of: m.generated_at, generated_at: m.generated_at, source_cutoff: m.data_cutoff, point_kind: "CUMULATIVE", as_of_kind: "CURRENT_SNAPSHOT", week_state: "COMPLETE", snapshot_id: null, player_team_temporal_identity: PHASE7 };
  return { m, cid, fiLineage, temporal };
}
const commonLimits = (m: { current_season_status: string; as_of_week: number; current_season: number }) => [`current_season_status=${m.current_season_status}: data runs through ${m.current_season} week ${m.as_of_week}; there is no live in-season signal for the following season`];

function identityFor(gsis: string, ctx: QueryContext) {
  const r = readCurrentCsv(ctx.root, `${DIR}/player_directory.csv`).find((x) => x.gsis_id === gsis);
  return classifyIdentity({ canonical_player_id: `player:gsis:${gsis}`, source_player_id: gsis, source_id_type: "gsis", name: r?.full_name ?? null, position: r?.position ?? null, team: r?.nfl_team ?? null });
}

function base(topic: string, metric: string, subject: EvidenceBlock["subject"], mm: ReturnType<typeof meta>, artifact: string, extra: string[] = []) {
  return { surface: SURFACE, topic, metric, subject, deployment: DEPLOYMENT,
    freshness: { as_of: mm.m.generated_at, through_week: mm.m.as_of_week, generated_at: mm.m.generated_at, week_completion: null },
    temporal: mm.temporal,
    lineage: { surface_version: mm.m.player_scheme_version, content_identity: mm.cid.served_content_id, canonical: { player_scheme_content_identity: mm.cid, football_intelligence: mm.fiLineage } },
    source: { artifact: `${DIR}/${artifact}`, built_in: BUILT_IN }, limitations: [...commonLimits(mm.m), ...extra] };
}

/** QB progression: raw FTN read_thrown buckets. Numeric codes are SOURCE_CONFLICT and stay RAW_*. */
export function schemeQbProgressionEvidence(q: SchemeQuery, ctx: QueryContext): EvidenceBlock[] {
  const mm = meta(ctx); const gsis = q.gsis_id ?? ""; const window = q.window ?? "career";
  const identity = identityFor(gsis, ctx); const subject = { kind: "PLAYER" as const, id: gsis, identity };
  const all = readCurrentCsv(ctx.root, `${DIR}/qb_progression_profile.csv`).filter((r) => r.window === window);
  const rows = all.filter((r) => r.gsis_id === gsis);
  if (!rows.length) return [notAvailable(base("scheme.qb_progression", "*", subject, mm, "qb_progression_profile.csv"), "UNAVAILABLE", `no FTN-charted progression rows for ${gsis} in window '${window}'`)];
  return rows.map((r) => {
    const raw = r.bucket!; const numeric = raw.startsWith("RAW_");
    const cat = numeric ? { raw, normalized: null, mapping_status: "SOURCE_CONFLICT" as const } : { ...categoryFor(raw, VERIFIED_NAMED.has(raw) ? { [raw]: raw } : undefined) };
    const lims = [...(numeric ? ["numeric read_thrown semantics are UNVERIFIED_SOURCE_CONFLICT: the code is exposed raw and is NOT first/second/third read"] : []), "the bucket is the raw code on the target that was thrown; it does not reveal the full or unthrown progression", ...(identity.resolution !== "RESOLVED" ? [`identity ${identity.resolution}: ${identity.limitations.join("; ")}`] : [])];
    const cls = numeric ? "SOURCE_CONFLICT" as const : analysisClassFor("SCHEME", r.availability === "DESCRIPTIVE_ONLY" ? "DESCRIPTIVE_ONLY" : "OBSERVED");
    const share = num(r.read_share);
    const components: Component[] = [
      { key: "plays", value: num(r.plays), unit: unitFor("scheme.count") }, { key: "completion_pct", value: num(r.completion_pct), unit: unitFor("scheme.fraction"), note: "fraction 0-1 despite the '_pct' name" },
      { key: "epa_per_play", value: num(r.epa_per_play), unit: unitFor("scheme.epa") }, { key: "success_rate", value: num(r.success_rate), unit: unitFor("scheme.rate") },
      { key: "sack_rate", value: num(r.sack_rate), unit: unitFor("scheme.rate") }, { key: "time_to_throw", value: num(r.time_to_throw), unit: unitFor("scheme.seconds") },
    ];
    const ev = mk({ ...base("scheme.qb_progression", `${raw}.read_share`, subject, mm, "qb_progression_profile.csv", lims), availability: share === null ? { state: "INSUFFICIENT_SAMPLE", reason: "no share" } : { state: "AVAILABLE" }, ...(share === null ? {} : { value: share, unit: unitFor("scheme.fraction") }),
      category: cat, origin: { source_class: numeric ? "UNVERIFIED_SOURCE_CONFLICT" : "DESCRIPTIVE_ONLY", analysis_class: cls },
      sample_support: sampleSupportFor("scheme.evidence_class", r.evidence_class, num(r.plays)), predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" },
      components, relationships: [{ type: "DERIVED_FROM", target: { surface: "football-intelligence", topic: "fi.receiver_progression", note: "same FTN read_thrown source" } }],
      history: { class: "CURRENT_ONLY", points: [], note: `single served content identity (${mm.cid.served_content_id}); window '${window}' is cumulative` },
      chart: [{ form: "stacked_distribution", x: "category.raw", y: "value", group: "window", unit: "share of charted plays" }] }, [window, raw]);
    if (q.comparisons) {
      const pop = all.filter((x) => x.bucket === raw).map((x) => num(x.read_share)).filter((v): v is number => v !== null);
      if (share !== null && pop.length > 1) ev.comparison = [{ population: { id: `NFL_QB_FTN_${window.toUpperCase()}`, season: mm.m.current_season, through_week: mm.m.as_of_week, n: pop.length, definition: `QBs with FTN-charted ${raw} plays in window ${window}` }, rank: { position: 1 + pop.filter((v) => v > share).length, of: pop.length, order: "VALUE_DESCENDING" } }];
    }
    return ev;
  });
}

/** QB spatial matrix as ONE heatmap-ready block: 12 depth x field-third cells, each with its own sample support. */
export function schemeQbSpatialEvidence(q: SchemeQuery, ctx: QueryContext): EvidenceBlock[] {
  const mm = meta(ctx); const gsis = q.gsis_id ?? ""; const window = q.window ?? "career";
  const identity = identityFor(gsis, ctx); const subject = { kind: "PLAYER" as const, id: gsis, identity };
  const cells = readCurrentCsv(ctx.root, `${DIR}/qb_spatial_matrix.csv`).filter((r) => r.gsis_id === gsis && r.window === window);
  if (!cells.length) return [notAvailable(base("scheme.qb_spatial", "attempt_share_matrix", subject, mm, "qb_spatial_matrix.csv"), "UNAVAILABLE", `no spatial rows for ${gsis} in window '${window}'`)];
  const components: Component[] = cells.map((r) => ({ key: `${r.depth_bin}|${r.field_third}`, label: `${r.depth_bin} x ${r.field_third}`, value: num(r.attempt_share), unit: unitFor("scheme.fraction"), analysis_class: "OBSERVED", source_class: "OBSERVED", note: `attempts=${r.attempts}, evidence_class=${r.evidence_class} (sample support), epa_per_attempt=${r.epa_per_attempt}` }));
  const total = num(cells[0]!.attempts_total);
  return [mk({ ...base("scheme.qb_spatial", "attempt_share_matrix", subject, mm, "qb_spatial_matrix.csv", identity.resolution !== "RESOLVED" ? [`identity ${identity.resolution}`] : []), availability: { state: "AVAILABLE" },
    origin: { source_class: "OBSERVED", analysis_class: "OBSERVED" }, sample_support: { basis: "scheme.attempts_total", n: total }, predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" },
    components, history: { class: "CURRENT_ONLY", points: [], note: `window '${window}' is cumulative through ${mm.m.current_season} week ${mm.m.as_of_week}` },
    chart: [{ form: "heatmap", x: "field_third", y: "depth_bin", group: "component.value", unit: "share of attempts", domain: [0, 1] }] }, [window])];
}

/** Formation: source-native categories (incl. 'UNDER CENTER') retained; no verified taxonomy => normalized null. */
export function schemeQbFormationEvidence(q: SchemeQuery, ctx: QueryContext): EvidenceBlock[] {
  const mm = meta(ctx); const gsis = q.gsis_id ?? ""; const window = q.window ?? "career";
  const identity = identityFor(gsis, ctx); const subject = { kind: "PLAYER" as const, id: gsis, identity };
  const rows = readCurrentCsv(ctx.root, `${DIR}/qb_formation_profile.csv`).filter((r) => r.gsis_id === gsis && r.window === window);
  if (!rows.length) return [notAvailable(base("scheme.qb_formation", "*", subject, mm, "qb_formation_profile.csv"), "UNAVAILABLE", `no formation rows for ${gsis} in window '${window}'`)];
  return rows.map((r) => {
    const v = num(r.formation_share); // explicit column (verified against the served header), never guessed
    return mk({ ...base("scheme.qb_formation", `${r.bucket}.formation_share`, subject, mm, "qb_formation_profile.csv"), availability: v === null ? { state: "INSUFFICIENT_SAMPLE", reason: "no share column value" } : { state: "AVAILABLE" }, ...(v === null ? {} : { value: v, unit: unitFor("scheme.fraction") }),
      category: categoryFor(r.bucket!), origin: { source_class: "DESCRIPTIVE_ONLY", analysis_class: "DESCRIPTIVE" }, sample_support: sampleSupportFor("scheme.evidence_class", r.evidence_class, num(r.plays)),
      predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" }, components: [{ key: "plays", value: num(r.plays), unit: unitFor("scheme.count") }],
      history: { class: "CURRENT_ONLY", points: [], note: "single served content identity" }, chart: [{ form: "stacked_distribution", x: "category.raw", y: "value" }] }, [window, r.bucket]);
  });
}

/** Team defense coverage (man / zone rates), compared against the 32-team population. */
export function schemeDefenseCoverageEvidence(q: SchemeQuery, ctx: QueryContext): EvidenceBlock[] {
  const mm = meta(ctx); const team = (q.team ?? "").toUpperCase(); const subject = { kind: "TEAM" as const, id: team, team };
  const rows = readCurrentCsv(ctx.root, `${DIR}/defense_team_profile.csv`);
  const row = rows.find((r) => r.team === team && (!("window" in r) || r.window === (q.window ?? r.window)));
  if (!row) return [notAvailable(base("scheme.defense_coverage", "*", subject, mm, "defense_team_profile.csv"), "UNAVAILABLE", `no defense profile for ${team}`)];
  const out: EvidenceBlock[] = [];
  for (const [metric, col] of [["man_rate", "man_zone__man_rate"], ["zone_rate", "man_zone__zone_rate"]] as const) {
    const v = num(row[col]); if (v === null) continue;
    const b = mk({ ...base("scheme.defense_coverage", metric, subject, mm, "defense_team_profile.csv"), availability: { state: "AVAILABLE" }, value: v, unit: unitFor("scheme.rate"),
      origin: { source_class: "OBSERVED", analysis_class: "OBSERVED" }, sample_support: { basis: "scheme.charted_man_zone_plays", n: num(row.man_zone__charted_mz) }, predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" },
      components: [{ key: "charted_man_zone_plays", value: num(row.man_zone__charted_mz), unit: unitFor("scheme.count") }],
      history: { class: "CURRENT_ONLY", points: [], note: "single served content identity" }, chart: [{ form: "bar", x: "metric", y: "value", domain: [0, 1] }] }, [metric]);
    if (q.comparisons) { const pop = rows.map((r) => num(r[col])).filter((x): x is number => x !== null); b.comparison = [{ population: { id: "NFL_DEFENSES", season: mm.m.current_season, through_week: mm.m.as_of_week, n: pop.length, definition: "all 32 NFL defenses with charted man/zone plays" }, rank: { position: 1 + pop.filter((x) => x > v).length, of: pop.length, order: "VALUE_DESCENDING" } }]; }
    out.push(b);
  }
  return out.length ? out : [notAvailable(base("scheme.defense_coverage", "*", subject, mm, "defense_team_profile.csv"), "INSUFFICIENT_SAMPLE", "no charted man/zone plays")];
}
