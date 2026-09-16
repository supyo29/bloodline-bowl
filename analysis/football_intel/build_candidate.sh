#!/usr/bin/env bash
# ===========================================================================
# Football Intelligence — build a snapshot into an isolated candidate root.
#
#   analysis/football_intel/build_candidate.sh <candidate_root> [season] [through_week]
#
# Symlinks <candidate_root>/analysis/football_intel to the real one so
# build_snapshot.R (invoked with FI_ROOT=<candidate_root>) reads the real,
# already-fetched cache and coordinators.yaml but writes its served files and
# internal RDS snapshot under <candidate_root>/{lib/football-intel/data,
# outputs/football-intel-2026} instead of the real repo's served directory.
# No model/build code is modified to achieve this isolation.
# ===========================================================================
set -euo pipefail

CANDIDATE_ROOT="$1"; shift || true
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

mkdir -p "$CANDIDATE_ROOT/analysis"
ln -sfn "$REPO_ROOT/analysis/football_intel" "$CANDIDATE_ROOT/analysis/football_intel"

# Invoked with a path relative to REPO_ROOT (matching every other entrypoint's
# invocation convention) rather than an absolute path: Rscript encodes spaces
# in an absolute --file= path as "~+~", which config.R's own --file= sniffing
# does not decode -- relative invocation from repo root sidesteps that
# entirely instead of teaching every script a workaround for one path style.
(cd "$REPO_ROOT" && FI_ROOT="$CANDIDATE_ROOT" Rscript analysis/football_intel/build_snapshot.R "$@")

echo "candidate built -> $CANDIDATE_ROOT/lib/football-intel/data"
