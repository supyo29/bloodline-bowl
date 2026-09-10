#!/usr/bin/env bash
set -Eeuo pipefail

# Bloodline Bowl — Phase 10: 2026 Evidence Loop
#
# One dependency-ordered, fail-closed runner for the existing R intelligence
# stacks. This script DOES NOT change scoring, projection formulas, model
# weights, deployment lanes, or transaction behavior. It only refreshes source
# data, rebuilds already-defined artifacts, runs their validation, and records
# lineage for review.
#
# Usage:
#   bash scripts/weekly-evidence-refresh.sh
#   bash scripts/weekly-evidence-refresh.sh --full-regression
#
# --full-regression additionally runs the complete TypeScript test/type/lint
# gates. The default weekly data refresh runs the R evidence gates only.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FULL_REGRESSION=0
for arg in "$@"; do
  case "$arg" in
    --full-regression) FULL_REGRESSION=1 ;;
    -h|--help)
      sed -n '1,24p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 64
      ;;
  esac
done

for required in Rscript node git; do
  command -v "$required" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $required" >&2
    exit 127
  }
done
if [[ "$FULL_REGRESSION" -eq 1 ]]; then
  command -v npm >/dev/null 2>&1 || {
    echo "Required command is unavailable for --full-regression: npm" >&2
    exit 127
  }
fi

RUN_ID="$(date -u +'%Y%m%dT%H%M%SZ')"
STARTED_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
REPORT_DIR="${EVIDENCE_REPORT_DIR:-artifacts/evidence-loop}"
REPORT_PATH="$REPORT_DIR/$RUN_ID.json"
LATEST_PATH="$REPORT_DIR/latest.json"
mkdir -p "$REPORT_DIR"

STAGES_FILE="$(mktemp)"
BEFORE_AUDIT_FILE="$(mktemp)"
CURRENT_STAGE="bootstrap"

cleanup() {
  rm -f "$STAGES_FILE" "$BEFORE_AUDIT_FILE"
}

# Preserve the previously published source audit before the refresh overwrites
# it. A clean checkout may not have one; that is valid and recorded as null.
if [[ -f outputs/player-scheme-intelligence-2026/source_audit.json ]]; then
  cp outputs/player-scheme-intelligence-2026/source_audit.json "$BEFORE_AUDIT_FILE"
fi

record_stage() {
  local name="$1" status="$2" started="$3" ended="$4" exit_code="$5"
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$status" "$started" "$ended" "$exit_code" >> "$STAGES_FILE"
}

run_stage() {
  local name="$1"
  shift
  local started ended rc
  CURRENT_STAGE="$name"
  started="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  echo
  echo "==> $name"
  set +e
  "$@"
  rc=$?
  set -e
  ended="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  if [[ "$rc" -eq 0 ]]; then
    record_stage "$name" "PASS" "$started" "$ended" "$rc"
    return 0
  fi
  record_stage "$name" "FAIL" "$started" "$ended" "$rc"
  echo "Phase 10 evidence refresh failed at: $name (exit $rc)" >&2
  return "$rc"
}

finalize_report() {
  local overall_status="$1" exit_code="$2"
  local ended_at git_sha
  ended_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  git_sha="$(git rev-parse HEAD 2>/dev/null || printf 'UNKNOWN')"

  RUN_ID="$RUN_ID" \
  STARTED_AT="$STARTED_AT" \
  ENDED_AT="$ended_at" \
  OVERALL_STATUS="$overall_status" \
  EXIT_CODE="$exit_code" \
  FAILED_STAGE="${CURRENT_STAGE:-}" \
  GIT_SHA="$git_sha" \
  FULL_REGRESSION="$FULL_REGRESSION" \
  STAGES_FILE="$STAGES_FILE" \
  BEFORE_AUDIT_FILE="$BEFORE_AUDIT_FILE" \
  REPORT_PATH="$REPORT_PATH" \
  LATEST_PATH="$LATEST_PATH" \
  node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const env = process.env;
const readJson = (file) => {
  try {
    if (!file || !fs.existsSync(file) || fs.statSync(file).size === 0) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { _read_error: error instanceof Error ? error.message : String(error), _path: file };
  }
};

const stages = fs.existsSync(env.STAGES_FILE)
  ? fs.readFileSync(env.STAGES_FILE, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const [name, status, started_at, ended_at, exit_code] = line.split('\t');
      return { name, status, started_at, ended_at, exit_code: Number(exit_code) };
    })
  : [];

const report = {
  schema_version: 1,
  phase: 'team-management-phase10-2026-evidence-loop',
  run_id: env.RUN_ID,
  overall_status: env.OVERALL_STATUS,
  exit_code: Number(env.EXIT_CODE),
  failed_stage: env.OVERALL_STATUS === 'PASS' ? null : env.FAILED_STAGE || null,
  started_at: env.STARTED_AT,
  ended_at: env.ENDED_AT,
  git_sha: env.GIT_SHA,
  full_regression: env.FULL_REGRESSION === '1',
  invariants: {
    changes_production_scoring: false,
    changes_projection_formula: false,
    changes_model_weights: false,
    promotes_shadow_models: false,
    executes_transactions: false,
  },
  stages,
  source_audit_before: readJson(env.BEFORE_AUDIT_FILE),
  source_audit_after: readJson('outputs/player-scheme-intelligence-2026/source_audit.json'),
  football_intelligence_manifest: readJson('lib/football-intel/data/football_intelligence_manifest.json'),
  player_scheme_manifest: readJson('lib/player-scheme-intelligence/data/player_scheme_manifest.json'),
};

fs.mkdirSync(path.dirname(env.REPORT_PATH), { recursive: true });
fs.writeFileSync(env.REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
fs.copyFileSync(env.REPORT_PATH, env.LATEST_PATH);
console.log(`Evidence-loop report: ${env.REPORT_PATH}`);
NODE
}

on_exit() {
  local rc=$?
  trap - EXIT
  if [[ "$rc" -eq 0 ]]; then
    finalize_report "PASS" 0 || true
  else
    finalize_report "FAIL" "$rc" || true
  fi
  cleanup
  exit "$rc"
}
trap on_exit EXIT

# -------------------------------------------------------------------------
# Dependency order. Each stage must succeed before the next is allowed to run.
# -------------------------------------------------------------------------
run_stage "football_intel.fetch_raw" \
  Rscript analysis/football_intel/fetch_raw.R --refresh

run_stage "football_intel.targets" \
  Rscript -e 'targets::tar_make()'

run_stage "player_scheme.source_audit" \
  Rscript analysis/player_scheme_intelligence/source_audit.R

run_stage "player_scheme.tierA" \
  Rscript analysis/player_scheme_intelligence/build_tierA.R

run_stage "player_scheme.tierB" \
  Rscript analysis/player_scheme_intelligence/build_tierB.R

run_stage "player_scheme.tierC" \
  Rscript analysis/player_scheme_intelligence/build_tierC.R

run_stage "player_scheme.tierD_shadow" \
  Rscript analysis/player_scheme_intelligence/build_tierD.R

# Run the child tests directly. Phase 9's convenience runner currently does
# not propagate system2() child exit codes, so it is not a sufficient fail-
# closed gate for an automated evidence pipeline.
run_stage "player_scheme.test_tierA" \
  Rscript analysis/player_scheme_intelligence/tests/test_tierA.R

run_stage "player_scheme.test_tierD_synthetic" \
  Rscript analysis/player_scheme_intelligence/tests/test_tierD_synthetic.R

run_stage "manifest.football_intel_present" \
  test -s lib/football-intel/data/football_intelligence_manifest.json

run_stage "manifest.player_scheme_present" \
  test -s lib/player-scheme-intelligence/data/player_scheme_manifest.json

if [[ "$FULL_REGRESSION" -eq 1 ]]; then
  run_stage "typescript.test" npm test
  run_stage "typescript.typecheck" npm run typecheck
  run_stage "typescript.lint" npm run lint
fi

CURRENT_STAGE="complete"
echo
echo "Phase 10 evidence refresh completed successfully."
