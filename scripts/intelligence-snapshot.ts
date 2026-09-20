/**
 * Phase 3.5C — write immutable snapshots of the served intelligence artifacts.
 *
 *   npx tsx scripts/intelligence-snapshot.ts            # snapshot the CURRENTLY served state if the policy allows
 *   npx tsx scripts/intelligence-snapshot.ts --backfill-git   # also preserve previously PUBLISHED states from git
 *   npx tsx scripts/intelligence-snapshot.ts --dry-run
 *
 * Idempotent and append-only. Never rewrites an entry; a snapshot id that would bind to different content THROWS.
 * Backfill reads only states that were genuinely published (git commits of the served artifacts) — it does not
 * reconstruct anything, so the resulting history is real "what the system knew then", not retrospective.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  HISTORY_MANIFEST_VERSION, SNAPSHOT_SURFACES, contentId, historyRoot, loadHistoryManifest, objectPath, sha256, snapshotId,
  type HistoryManifest, type SnapshotEntry, type SurfaceSnapshotSpec,
} from "../lib/book-ready/snapshots";

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");

type Reader = (rel: string) => Buffer | null;
const fsReader: Reader = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel)) : null);
const gitReader = (commit: string): Reader => (rel) => { try { return execFileSync("git", ["show", `${commit}:${rel}`], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };

interface Derived { version: string; season: number; through_week: number; week_state: "PARTIAL" | "COMPLETE"; generated_at: string; cutoff: Record<string, number> | null }

/** Reads the surface's own manifest (single owner of version/week state); throws on a shape it does not understand. */
function derive(spec: SurfaceSnapshotSpec, manifestBytes: Buffer, roleStateFor: (roleVersion: string) => "PARTIAL" | "COMPLETE" | null): Derived | null {
  const m = JSON.parse(manifestBytes.toString("utf8"));
  switch (spec.surface) {
    case "football-intelligence":
      return { version: m.football_intelligence_version, season: m.season, through_week: m.through_week, week_state: m.week_completion?.week_state ?? null, generated_at: m.generated_at, cutoff: m.data_cutoff ?? null };
    case "role-opportunity":
      return { version: m.role_opportunity_version, season: m.season, through_week: m.through_week, week_state: m.week_completion?.week_state ?? null, generated_at: m.generated_at, cutoff: m.source_cutoffs ?? null };
    case "opportunity-propagation": {
      // OPP has no week_completion of its own: it is only as complete as the Role snapshot it was built against.
      const st = roleStateFor(m.role_opportunity_dependency?.role_opportunity_version);
      return st ? { version: m.opportunity_propagation_version, season: m.season, through_week: m.through_week, week_state: st, generated_at: m.generated_at, cutoff: null } : null;
    }
    case "player-scheme":
      return { version: m.player_scheme_version, season: m.current_season, through_week: m.as_of_week, week_state: "COMPLETE", generated_at: m.generated_at, cutoff: m.data_cutoff ?? null };
  }
  return null;
}

function fileList(spec: SurfaceSnapshotSpec, read: Reader, commit?: string): string[] {
  if (spec.files.length) return spec.files;
  if (!commit) return readdirSync(join(ROOT, spec.data_dir)).filter((f) => /\.(csv|json)$/.test(f));
  const out = execFileSync("git", ["ls-tree", "--name-only", commit, `${spec.data_dir}/`], { cwd: ROOT }).toString().trim().split("\n");
  return out.map((p) => p.split("/").pop()!).filter((f) => /\.(csv|json)$/.test(f));
}

let manifest: HistoryManifest = loadHistoryManifest(ROOT);
const written: string[] = []; const skipped: string[] = [];
const objects: Array<{ sha: string; gz: Buffer }> = [];

function consider(spec: SurfaceSnapshotSpec, read: Reader, provenance: SnapshotEntry["provenance"], commit?: string): void {
  const mb = read(spec.manifest_path); if (!mb) return;
  const roleStateFor = (rv: string) => manifest.entries.filter((e) => e.surface === "role-opportunity" && e.version === rv).map((e) => e.week_state)[0] ?? null;
  const d = derive(spec, mb, roleStateFor);
  if (!d || !d.version) { skipped.push(`${spec.surface}: cannot derive state`); return; }
  if (spec.policy === "COMPLETE_WEEK" && d.week_state !== "COMPLETE") { skipped.push(`${spec.surface}@${d.version}: ${d.week_state ?? "week_state unknown (legacy manifest)"} (COMPLETE_WEEK policy stores only complete weeks)`); return; }
  const files = fileList(spec, read, commit).map((name) => { const b = read(`${spec.data_dir}/${name}`); return b ? { name, b } : null; }).filter((x): x is { name: string; b: Buffer } => !!x);
  if (!files.length) { skipped.push(`${spec.surface}: no files`); return; }
  const entryFiles = files.map(({ name, b }) => { const gz = gzipSync(b, { level: 9 }); const sha = sha256(b); objects.push({ sha, gz }); return { name, sha256: sha, bytes: b.length, gz_bytes: gz.length }; });
  const cid = contentId(entryFiles); const id = snapshotId(spec.surface, d.version, cid);
  const existing = manifest.entries.find((e) => e.snapshot_id === id);
  if (existing) { skipped.push(`${id}: already preserved`); return; }
  // Same surface+version but DIFFERENT content would be a rewrite of history under an existing version -> refuse loudly.
  const clash = manifest.entries.find((e) => e.surface === spec.surface && e.version === d.version && e.content_id !== cid);
  if (clash) { skipped.push(`${spec.surface}@${d.version}: content differs from preserved ${clash.snapshot_id} (recorded as a distinct revision)`); }
  manifest.entries.push({ snapshot_id: id, surface: spec.surface, version: d.version, content_id: cid, season: d.season, through_week: d.through_week, week_state: d.week_state, generated_at: d.generated_at, source_cutoff: d.cutoff, provenance, policy: spec.policy, files: entryFiles });
  written.push(id);
}

if (args.has("--backfill-git")) {
  // oldest first so OPP can find its Role dependency state
  for (const spec of SNAPSHOT_SURFACES.filter((s) => s.surface !== "player-scheme")) {
    const log = execFileSync("git", ["log", "--reverse", "--format=%H|%cI", "--", spec.manifest_path], { cwd: ROOT }).toString().trim().split("\n").filter(Boolean);
    for (const line of log) { const [commit, at] = line.split("|"); consider(spec, gitReader(commit!), { kind: "GIT_PUBLICATION", commit: commit!.slice(0, 12), committed_at: at! }, commit); }
  }
}
for (const spec of SNAPSHOT_SURFACES) consider(spec, fsReader, { kind: "LIVE_SNAPSHOT" });

manifest.entries.sort((a, b) => a.surface.localeCompare(b.surface) || a.season - b.season || a.through_week - b.through_week || a.generated_at.localeCompare(b.generated_at));
if (!DRY && written.length) {
  const seen = new Set<string>();
  for (const o of objects) {
    if (seen.has(o.sha)) continue; seen.add(o.sha);
    const p = objectPath(o.sha, ROOT); if (existsSync(p)) continue;
    mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, o.gz);
  }
  mkdirSync(historyRoot(ROOT), { recursive: true });
  writeFileSync(join(historyRoot(ROOT), "manifest.json"), JSON.stringify({ history_manifest_version: HISTORY_MANIFEST_VERSION, entries: manifest.entries }, null, 1) + "\n");
}
console.log(JSON.stringify({ dry_run: DRY, written, skipped: skipped.slice(0, 12), total_entries: manifest.entries.length }, null, 1));
