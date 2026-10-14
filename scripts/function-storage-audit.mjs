#!/usr/bin/env node
/**
 * Vercel Function Storage regression audit.
 *
 * Run after a clean `vercel build` (reads .vercel/output/functions). Resolves the symlinked `.func` aliases to physical
 * bundles, sizes each bundle from its `.vc-config.json` filePathMap (+ files stored in the bundle directory), estimates
 * compressed size, and reports duplicated bytes across bundles. Exits 1 when a ceiling is breached.
 *
 * CEILINGS ARE PROVISIONAL AND MUST NOT BE RAISED SILENTLY: a legitimate change needs an explicit, reviewed edit of
 * CEILINGS below plus a note in docs/VERCEL_FUNCTION_STORAGE.md.
 *
 * Usage: node scripts/function-storage-audit.mjs [--root <repo>] [--json <out.json>] [--no-gzip]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import { skippableFilesInBundles } from "./vercel-ignore-build.mjs";

export const CEILINGS = Object.freeze({
  maxPhysicalFunctions: 6,
  maxTotalUncompressedBytes: 600 * 1024 * 1024,
  /** Vercel's documented per-function bundle limit for Node functions is 250 MB uncompressed. */
  vercelFunctionLimitBytes: 250 * 1024 * 1024,
  /** "near" the limit = >= 80% of it. */
  nearLimitFraction: 0.8,
});

/** Files that must be present in specific functions (guards `turbopackIgnore` / tracing fixes against silently dropping runtime data). */
export const REQUIRED_IN_FUNCTION = Object.freeze([
  { route: "api/trades/competitive", file: "lib/trades/data/competitive_market_calibration.json" },
  { route: "api/trades/analyze", file: "lib/trades/data/competitive_market_calibration.json" },
]);

/** Research caches/outputs that must never be shipped in a function (gitignored, so they only appear in dirty working-tree builds). */
export const FORBIDDEN = Object.freeze([/^analysis\/[^/]+\/cache\//, /^analysis\/phase3_cache\//, /^outputs\//, /\.rds$/, /\.parquet$/]);

function walkFuncs(dir, out = { physical: [], links: [] }) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.name.endsWith(".func")) {
      if (e.isSymbolicLink()) out.links.push({ link: p, target: fs.realpathSync(p) });
      else if (e.isDirectory()) out.physical.push(p);
    } else if (e.isDirectory()) walkFuncs(p, out);
  }
  return out;
}

function dirFiles(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) dirFiles(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

export function analyze({ root = process.cwd(), gzip = true } = {}) {
  const fdir = path.join(root, ".vercel", "output", "functions");
  if (!fs.existsSync(fdir)) throw new Error(`no build output at ${fdir} (run a clean \`vercel build\` first)`);
  const { physical, links } = walkFuncs(fdir);
  const sizeCache = new Map();
  const info = (key, abs) => {
    if (sizeCache.has(key)) return sizeCache.get(key);
    let r = { size: 0, gz: 0 };
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) r = { size: st.size, gz: gzip ? zlib.gzipSync(fs.readFileSync(abs), { level: 6 }).length : Math.round(st.size * 0.3) };
    } catch { /* missing traced file counts as 0 */ }
    sizeCache.set(key, r);
    return r;
  };
  const functions = [];
  const fileUse = new Map(); // key -> {size, users:Set}
  const missing = [];
  for (const f of physical) {
    const rel = path.relative(fdir, f);
    const files = new Map(); // key -> abs
    const cfgPath = path.join(f, ".vc-config.json");
    const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
    for (const v of new Set(Object.values(cfg.filePathMap ?? {}))) {
      const abs = path.resolve(root, v);
      if (!fs.existsSync(abs)) missing.push({ fn: rel, file: v });
      files.set(v, abs);
    }
    for (const abs of dirFiles(f)) files.set("bundle:" + path.relative(f, abs) + "@" + rel, abs); // launcher/config/own files are per-bundle, not shared
    let size = 0, gz = 0;
    for (const [k, abs] of files) {
      const i = info(k, abs);
      size += i.size; gz += i.gz;
      const u = fileUse.get(k) ?? { size: i.size, users: new Set() };
      u.users.add(rel); fileUse.set(k, u);
    }
    const aliases = links.filter((l) => l.target === f).length;
    functions.push({ fn: rel, files: files.size, bytes: size, gzipBytes: gz, aliases, maxDuration: cfg.maxDuration ?? null, fileKeys: [...files.keys()] });
  }
  functions.sort((a, b) => b.bytes - a.bytes);
  // duplication: bytes beyond the first copy of each shared file
  let duplicatedBytes = 0;
  const dupDirs = new Map();
  for (const [k, u] of fileUse) {
    if (u.users.size < 2) continue;
    const extra = u.size * (u.users.size - 1);
    duplicatedBytes += extra;
    const parts = k.split("/");
    const d = k.startsWith("node_modules/") ? parts.slice(0, 2).join("/") : parts.slice(0, 3).join("/");
    dupDirs.set(d, (dupDirs.get(d) ?? 0) + extra);
  }
  const uniqueBytes = [...fileUse.values()].reduce((a, u) => a + u.size, 0);
  const totalBytes = functions.reduce((a, f) => a + f.bytes, 0);
  const forbidden = [];
  for (const f of functions) for (const k of f.fileKeys) if (FORBIDDEN.some((re) => re.test(k)) && fileUse.get(k).size > 0) forbidden.push({ fn: f.fn, file: k });
  const requiredMissing = [];
  for (const r of REQUIRED_IN_FUNCTION) {
    const aliasTarget = links.find((l) => path.relative(fdir, l.link) === r.route + ".func");
    const target = aliasTarget ? path.relative(fdir, aliasTarget.target) : r.route + ".func";
    const phys = functions.find((f) => f.fn === target);
    if (!phys || !phys.fileKeys.includes(r.file)) requiredMissing.push({ route: r.route, file: r.file, resolvedFunction: phys?.fn ?? null });
  }
  return {
    physicalFunctions: functions.length,
    aliasSymlinks: links.length,
    totalUncompressedBytes: totalBytes,
    totalEstimatedCompressedBytes: functions.reduce((a, f) => a + f.gzipBytes, 0),
    uniqueFileBytes: uniqueBytes,
    duplicatedBytes,
    largestFunction: functions[0] ? { fn: functions[0].fn, bytes: functions[0].bytes } : null,
    topDuplicatedDirectories: [...dupDirs].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([dir, bytes]) => ({ dir, bytes })),
    functions: functions.map(({ fileKeys, ...rest }) => rest),
    missingTracedFiles: missing,
    forbiddenFiles: forbidden,
    requiredMissing,
    skippableFilesInBundles: skippableFilesInBundles([...new Set(functions.flatMap((f) => f.fileKeys.filter((k) => !k.startsWith("bundle:"))))]),
  };
}

export function checkCeilings(report, c = CEILINGS) {
  const v = [];
  if (report.physicalFunctions > c.maxPhysicalFunctions) v.push(`physical functions ${report.physicalFunctions} > ${c.maxPhysicalFunctions}`);
  if (report.totalUncompressedBytes > c.maxTotalUncompressedBytes) v.push(`total uncompressed ${mb(report.totalUncompressedBytes)} MB > ${mb(c.maxTotalUncompressedBytes)} MB`);
  for (const f of report.functions) if (f.bytes >= c.vercelFunctionLimitBytes * c.nearLimitFraction) v.push(`${f.fn} is ${mb(f.bytes)} MB, within ${Math.round((1 - c.nearLimitFraction) * 100)}% of the ${mb(c.vercelFunctionLimitBytes)} MB function limit`);
  for (const x of report.forbiddenFiles) v.push(`forbidden research/dev file shipped in ${x.fn}: ${x.file}`);
  for (const x of report.requiredMissing) v.push(`required runtime file missing from ${x.route} (${x.resolvedFunction}): ${x.file}`);
  for (const f of report.skippableFilesInBundles ?? []) v.push(`ignoreCommand would skip a build for a file that ships in a function: ${f} (fix scripts/vercel-ignore-build.mjs)`);
  return v;
}

const mb = (b) => (b / 1048576).toFixed(1);

export function formatReport(r) {
  const L = [];
  L.push(`physical .func bundles : ${r.physicalFunctions} (+${r.aliasSymlinks} symlink aliases)`);
  L.push(`total uncompressed     : ${mb(r.totalUncompressedBytes)} MB`);
  L.push(`est. compressed (gzip) : ${mb(r.totalEstimatedCompressedBytes)} MB`);
  L.push(`unique file bytes      : ${mb(r.uniqueFileBytes)} MB`);
  L.push(`duplicated bytes       : ${mb(r.duplicatedBytes)} MB`);
  L.push(`largest function       : ${r.largestFunction?.fn} (${mb(r.largestFunction?.bytes ?? 0)} MB)`);
  L.push("functions:");
  for (const f of r.functions) L.push(`  ${mb(f.bytes).padStart(7)} MB unc ${mb(f.gzipBytes).padStart(7)} MB gz ${String(f.files).padStart(5)} files aliases=${String(f.aliases).padStart(3)} maxDuration=${f.maxDuration ?? "-"}  ${f.fn}`);
  L.push("top duplicated directories (bytes beyond first copy):");
  for (const d of r.topDuplicatedDirectories) L.push(`  ${mb(d.bytes).padStart(7)} MB  ${d.dir}`);
  if (r.missingTracedFiles.length) L.push(`WARNING: ${r.missingTracedFiles.length} traced files missing on disk`);
  return L.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const report = analyze({ root: path.resolve(arg("--root") ?? process.cwd()), gzip: !process.argv.includes("--no-gzip") });
  console.log(formatReport(report));
  if (arg("--json")) fs.writeFileSync(arg("--json"), JSON.stringify(report, null, 2));
  const violations = checkCeilings(report);
  if (violations.length) { console.error("\nFUNCTION STORAGE CEILING VIOLATIONS:\n - " + violations.join("\n - ")); process.exit(1); }
  console.log("\nfunction storage ceilings: OK");
}
