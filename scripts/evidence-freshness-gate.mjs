#!/usr/bin/env node

/**
 * Bloodline Bowl — Phase 10 freshness gate.
 *
 * Validates that the post-refresh source audit and served FI/PSI manifests tell
 * one coherent story. This is intentionally a metadata/lineage gate only: it
 * cannot change model weights, projections, recommendations, or transactions.
 *
 * Exit 0: PASS (including a valid NO_NEW_DATA refresh)
 * Exit 2: freshness/lineage invariant failed
 * Exit 64: invalid arguments
 */

import fs from 'node:fs';
import path from 'node:path';

const defaults = {
  audit: 'outputs/player-scheme-intelligence-2026/source_audit.json',
  before: null,
  fi: 'lib/football-intel/data/football_intelligence_manifest.json',
  psi: 'lib/player-scheme-intelligence/data/player_scheme_manifest.json',
  out: 'artifacts/evidence-loop/freshness-latest.json',
};

function parseArgs(argv) {
  const args = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/evidence-freshness-gate.mjs [--audit FILE] [--before FILE] [--fi FILE] [--psi FILE] [--out FILE]');
      process.exit(0);
    }
    if (!['--audit', '--before', '--fi', '--psi', '--out'].includes(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
    if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`);
    args[arg.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

function readRequiredJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} missing: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readOptionalJson(file) {
  if (!file || !fs.existsSync(file) || fs.statSync(file).size === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseSeasonWeek(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-w(\d{1,2})$/i.exec(value.trim());
  if (!match) return null;
  return { season: Number(match[1]), week: Number(match[2]) };
}

function compareSeasonWeek(a, b) {
  if (a.season !== b.season) return a.season - b.season;
  return a.week - b.week;
}

function addCheck(checks, code, pass, detail, severity = 'ERROR') {
  checks.push({ code, pass: Boolean(pass), severity, detail });
}

function sourceRows(source) {
  const value = Number(source?.current_season_rows);
  return Number.isFinite(value) ? value : null;
}

function validate({ audit, before, fi, psi }) {
  const checks = [];
  const currentSeason = Number(audit?.current_season);
  addCheck(checks, 'AUDIT_CURRENT_SEASON_VALID', Number.isInteger(currentSeason) && currentSeason >= 2020,
    `audit.current_season=${audit?.current_season ?? 'missing'}`);

  const sources = audit?.sources && typeof audit.sources === 'object' ? audit.sources : {};
  addCheck(checks, 'AUDIT_SOURCES_PRESENT', Object.keys(sources).length > 0,
    `sources=${Object.keys(sources).join(',') || 'none'}`);

  for (const [name, source] of Object.entries(sources)) {
    const rows = sourceRows(source);
    const state = source?.availability_state;
    const last = parseSeasonWeek(source?.last_available);

    addCheck(checks, `SOURCE_${name}_CURRENT_ROWS_VALID`, rows !== null && rows >= 0,
      `${name}: current_season_rows=${source?.current_season_rows ?? 'missing'}`);

    if (rows !== null) {
      addCheck(checks, `SOURCE_${name}_LIVE_STATE_MATCHES_ROWS`,
        rows > 0 ? state === 'LIVE_CURRENT' : state !== 'LIVE_CURRENT',
        `${name}: rows=${rows}, availability_state=${state ?? 'missing'}`);
    }

    if (rows !== null && rows > 0 && last && Number.isInteger(currentSeason)) {
      addCheck(checks, `SOURCE_${name}_LAST_SEASON_IS_CURRENT`, last.season === currentSeason,
        `${name}: last_available=${source.last_available}, current_season=${currentSeason}`);
    }

    const priorSource = before?.sources?.[name];
    const priorLast = parseSeasonWeek(priorSource?.last_available);
    if (priorLast && last) {
      addCheck(checks, `SOURCE_${name}_NO_CUTOFF_REGRESSION`, compareSeasonWeek(last, priorLast) >= 0,
        `${name}: before=${priorSource.last_available}, after=${source.last_available}`);
    }
    const priorRows = sourceRows(priorSource);
    if (priorRows !== null && rows !== null && priorRows > 0) {
      addCheck(checks, `SOURCE_${name}_NO_CURRENT_ROW_DISAPPEARANCE`, rows > 0,
        `${name}: before current rows=${priorRows}, after current rows=${rows}`);
    }
  }

  const pbp = sources.pbp;
  const pbpRows = sourceRows(pbp);
  const pbpLast = parseSeasonWeek(pbp?.last_available);

  addCheck(checks, 'PSI_SHADOW_NOT_PROMOTED',
    psi?.fantasy_adjustment_enabled === false &&
      psi?.tier_d?.lane === 'SHADOW_ONLY' &&
      Number(psi?.tier_d?.numeric_fantasy_adjustment) === 0,
    `fantasy_adjustment_enabled=${psi?.fantasy_adjustment_enabled}; tier_d.lane=${psi?.tier_d?.lane}; tier_d.numeric_fantasy_adjustment=${psi?.tier_d?.numeric_fantasy_adjustment}`);

  if (pbpRows !== null && Number.isInteger(currentSeason)) {
    if (pbpRows > 0) {
      addCheck(checks, 'PSI_PBP_CURRENT_SEASON_ALIGNMENT',
        Number(psi?.current_season) === currentSeason && psi?.current_season_status === 'LIVE_CURRENT' && psi?.availability_state === 'LIVE_CURRENT',
        `pbp rows=${pbpRows}; psi season=${psi?.current_season}; status=${psi?.current_season_status}; availability=${psi?.availability_state}`);
      addCheck(checks, 'FI_PBP_CURRENT_SEASON_ALIGNMENT', Number(fi?.season) === currentSeason,
        `pbp rows=${pbpRows}; fi.season=${fi?.season}; audit.current_season=${currentSeason}`);
    } else {
      addCheck(checks, 'PSI_DOES_NOT_FAKE_CURRENT_WITHOUT_PBP',
        psi?.current_season_status !== 'LIVE_CURRENT' && psi?.availability_state !== 'LIVE_CURRENT',
        `pbp rows=0; psi status=${psi?.current_season_status}; availability=${psi?.availability_state}`);
    }
  }

  if (pbpLast) {
    if (Number(fi?.season) === pbpLast.season) {
      addCheck(checks, 'FI_WEEK_NOT_AHEAD_OF_PBP', Number(fi?.through_week) <= pbpLast.week,
        `fi=${fi?.season}-w${fi?.through_week}; pbp last=${pbp?.last_available}`);
    }
    if (Number(psi?.current_season) === pbpLast.season) {
      addCheck(checks, 'PSI_WEEK_NOT_AHEAD_OF_PBP', Number(psi?.as_of_week) <= pbpLast.week,
        `psi=${psi?.current_season}-w${psi?.as_of_week}; pbp last=${pbp?.last_available}`);
    }
  }

  const participationRows = sourceRows(sources.participation);
  if (participationRows === 0 && psi?.tier_b) {
    addCheck(checks, 'TIER_B_PARTICIPATION_NOT_FAKE_CURRENT',
      psi.tier_b?.current_season_observed?.participation === false &&
        (psi.tier_b?.families ?? []).filter((f) => f?.source === 'participation').every((f) => f?.current_season_observed === false && f?.availability !== 'LIVE_CURRENT'),
      'participation has 0 current-season rows; Tier B participation families must remain prior-only/not-current');
  }

  const ftnRows = sourceRows(sources.ftn_charting);
  if (ftnRows === 0 && psi?.tier_b) {
    addCheck(checks, 'TIER_B_FTN_NOT_FAKE_CURRENT',
      psi.tier_b?.current_season_observed?.ftn === false &&
        (psi.tier_b?.families ?? []).filter((f) => f?.source === 'ftn').every((f) => f?.current_season_observed === false && f?.availability !== 'LIVE_CURRENT'),
      'FTN has 0 current-season rows; Tier B FTN families must remain descriptive/prior-only/not-current');
  }

  let changeClass = 'BASELINE_UNAVAILABLE';
  if (before?.sources) {
    const names = [...new Set([...Object.keys(before.sources), ...Object.keys(sources)])];
    const changed = names.some((name) => {
      const a = before.sources?.[name];
      const b = sources?.[name];
      return a?.last_available !== b?.last_available || sourceRows(a) !== sourceRows(b) || a?.availability_state !== b?.availability_state;
    });
    changeClass = changed ? 'UPDATED' : 'NO_NEW_DATA';
  }

  const failures = checks.filter((check) => check.severity === 'ERROR' && !check.pass);
  return {
    schema_version: 1,
    gate: 'phase10-evidence-freshness',
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    change_class: changeClass,
    current_season: Number.isInteger(currentSeason) ? currentSeason : null,
    generated_at: new Date().toISOString(),
    checks,
    failures: failures.map(({ code, detail }) => ({ code, detail })),
  };
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(64);
}

let result;
try {
  const audit = readRequiredJson(args.audit, 'source audit');
  const fi = readRequiredJson(args.fi, 'Football Intelligence manifest');
  const psi = readRequiredJson(args.psi, 'Player Scheme manifest');
  const before = readOptionalJson(args.before);
  result = validate({ audit, before, fi, psi });
} catch (error) {
  result = {
    schema_version: 1,
    gate: 'phase10-evidence-freshness',
    status: 'FAIL',
    change_class: 'UNKNOWN',
    generated_at: new Date().toISOString(),
    checks: [],
    failures: [{ code: 'GATE_INPUT_ERROR', detail: error instanceof Error ? error.message : String(error) }],
  };
}

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n');
console.log(`Freshness gate: ${result.status} (${result.change_class}) -> ${args.out}`);
for (const failure of result.failures ?? []) console.error(`  ${failure.code}: ${failure.detail}`);
process.exit(result.status === 'PASS' ? 0 : 2);
