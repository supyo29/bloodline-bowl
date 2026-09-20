/**
 * Phase 3.5C — immutable, content-addressed HISTORY of the served intelligence artifacts.
 *
 * Why: Football Intelligence, Role, Opportunity Propagation and Player-Scheme each serve only "whatever the latest
 * build was". A trend or "what did the system know before Week 3" question needs the prior states preserved.
 *
 * Design (simplest that preserves truthful history):
 *   data/intelligence-history/manifest.json     append-only index of snapshots (never edited in place)
 *   data/intelligence-history/objects/xx/<sha256>.gz   content-addressed FILE objects, deduplicated across snapshots
 * A snapshot = { surface, version, season, through_week, week_state, generated_at, files:[{name, sha256}] }.
 * `content_id` = sha256 over the sorted file hashes, so identical content is one identity and any change is a new one.
 *
 * Retention policy (enforced by the writer, asserted by tests):
 *   COMPLETE_WEEK  (FI, Role, Opportunity Propagation): a snapshot is stored ONLY when the published state's
 *                  week_state is COMPLETE. Intra-week PARTIAL states are not stored (they are provisional and
 *                  would multiply storage ~7x); "what the system knew before Week W" = the COMPLETE state of W-1.
 *   CONTENT_CHANGE (Player-Scheme): stored only when the all-tier content identity changes (seasonal rebuild).
 * Entries are append-only; a snapshot id can never be re-bound to different content (writer throws).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const HISTORY_MANIFEST_VERSION = "intelligence-history-2026.1";
export const HISTORY_DIR = ["data", "intelligence-history"] as const;

export type RetentionPolicy = "COMPLETE_WEEK" | "CONTENT_CHANGE";

export interface SnapshotFile { name: string; sha256: string; bytes: number; gz_bytes: number }
export interface SnapshotEntry {
  snapshot_id: string;
  surface: string;
  version: string;
  content_id: string;
  season: number;
  through_week: number;
  week_state: "PARTIAL" | "COMPLETE";
  generated_at: string;
  source_cutoff: Record<string, number> | null;
  /** how the state came to be preserved */
  provenance: { kind: "LIVE_SNAPSHOT" | "GIT_PUBLICATION"; commit?: string; committed_at?: string };
  policy: RetentionPolicy;
  files: SnapshotFile[];
}
export interface HistoryManifest { history_manifest_version: string; entries: SnapshotEntry[] }

export interface SurfaceSnapshotSpec {
  surface: string;
  policy: RetentionPolicy;
  manifest_path: string;
  data_dir: string;
  files: string[];
}
export const SNAPSHOT_SURFACES: SurfaceSnapshotSpec[] = [
  { surface: "football-intelligence", policy: "COMPLETE_WEEK", manifest_path: "lib/football-intel/data/football_intelligence_manifest.json", data_dir: "lib/football-intel/data",
    files: ["football_intelligence_manifest.json", "team_profile.csv", "player_usage_profile.csv", "unit_coverage_profile.csv", "contextual_matchup_feature.csv", "ftn_descriptive.csv", "receiver_progression.csv"] },
  { surface: "role-opportunity", policy: "COMPLETE_WEEK", manifest_path: "lib/player-role-intelligence/data/role_opportunity_manifest.json", data_dir: "lib/player-role-intelligence/data",
    files: ["role_opportunity_manifest.json", "player_game_role.csv", "player_role_profile.csv", "player_role_change.csv"] },
  { surface: "opportunity-propagation", policy: "COMPLETE_WEEK", manifest_path: "lib/opportunity-propagation-intelligence/data/opportunity_propagation_manifest.json", data_dir: "lib/opportunity-propagation-intelligence/data",
    files: ["opportunity_propagation_manifest.json", "inheritance_priors_league.csv", "inheritance_priors_position.csv", "inheritance_priors_team.csv", "position_relationship_weights.csv", "supported_dimensions.csv"] },
  { surface: "player-scheme", policy: "CONTENT_CHANGE", manifest_path: "lib/player-scheme-intelligence/data/player_scheme_manifest.json", data_dir: "lib/player-scheme-intelligence/data", files: [] /* every file in the dir */ },
];

export const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
export const contentId = (files: Array<{ name: string; sha256: string }>): string =>
  sha256([...files].sort((a, b) => a.name.localeCompare(b.name)).map((f) => `${f.name}:${f.sha256}`).join("\n"));
export const snapshotId = (surface: string, version: string, cid: string): string => `${surface}@${version}#${cid.slice(0, 12)}`;

export const historyRoot = (root = process.cwd()): string => join(root, ...HISTORY_DIR);
export const objectPath = (sha: string, root = process.cwd()): string => join(historyRoot(root), "objects", sha.slice(0, 2), `${sha}.gz`);

export function loadHistoryManifest(root = process.cwd()): HistoryManifest {
  const p = join(historyRoot(root), "manifest.json");
  if (!existsSync(p)) return { history_manifest_version: HISTORY_MANIFEST_VERSION, entries: [] };
  return JSON.parse(readFileSync(p, "utf8")) as HistoryManifest;
}

export function listSnapshots(surface: string, root = process.cwd()): SnapshotEntry[] {
  return loadHistoryManifest(root).entries
    .filter((e) => e.surface === surface)
    .sort((a, b) => a.season - b.season || a.through_week - b.through_week || a.generated_at.localeCompare(b.generated_at));
}

/** Reads one file of a snapshot and VERIFIES its hash — a tampered/rotted object throws rather than yielding a value. */
export function readSnapshotFile(entry: SnapshotEntry, name: string, root = process.cwd()): Buffer {
  const f = entry.files.find((x) => x.name === name);
  if (!f) throw new Error(`snapshot ${entry.snapshot_id} has no file ${name}`);
  const gz = readFileSync(objectPath(f.sha256, root));
  const raw = gunzipSync(gz);
  if (sha256(raw) !== f.sha256) throw new Error(`snapshot object ${f.sha256} failed verification (${entry.snapshot_id}/${name})`);
  return raw;
}

/** Full integrity check: every entry's content_id, every object present and hash-correct, ids unique. */
export function verifyHistoryStore(root = process.cwd()): string[] {
  const bad: string[] = []; const ids = new Set<string>();
  for (const e of loadHistoryManifest(root).entries) {
    if (ids.has(e.snapshot_id)) bad.push(`duplicate snapshot id ${e.snapshot_id}`); ids.add(e.snapshot_id);
    if (contentId(e.files) !== e.content_id) bad.push(`${e.snapshot_id}: content_id does not match its files`);
    if (e.snapshot_id !== snapshotId(e.surface, e.version, e.content_id)) bad.push(`${e.snapshot_id}: id is not derived from surface/version/content`);
    if (e.policy === "COMPLETE_WEEK" && e.week_state !== "COMPLETE") bad.push(`${e.snapshot_id}: COMPLETE_WEEK policy stored a ${e.week_state} state`);
    for (const f of e.files) {
      try { if (sha256(gunzipSync(readFileSync(objectPath(f.sha256, root)))) !== f.sha256) bad.push(`${e.snapshot_id}/${f.name}: hash mismatch`); }
      catch { bad.push(`${e.snapshot_id}/${f.name}: object missing`); }
    }
  }
  return bad;
}
