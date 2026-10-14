#!/usr/bin/env bash
# usage: first-bad.sh <test-file> [good-commit]   (run from a throwaway worktree with node_modules; the good commit defaults to the commit that ADDED the test file)
# Prints the first commit (in first-parent order bounded by <good>..<bad>) at which <test-file> fails with the repo as it was then. The bad end is the PR #44 head.
set -uo pipefail
F="$1"; BAD="${BAD:-af72022}"
GOOD="${2:-$(git log --diff-filter=A --format=%h -1 "$BAD" -- "$F")}"
git checkout -q --detach "$GOOD" 2>/dev/null || { echo "cannot checkout $GOOD"; exit 2; }
PAT="${PATTERN:+--test-name-pattern=$PATTERN}"
green() { node --import tsx --test $PAT "$1" > /tmp/fb.run 2>&1; grep -q "^# fail 0" /tmp/fb.run; }
if ! green "$F"; then echo "NOT GREEN AT ADDING COMMIT $GOOD (test was red from the start in a clean checkout)"; exit 0; fi
git bisect start "$BAD" "$GOOD" >/dev/null 2>&1
git bisect run bash -c "node --import tsx --test $PAT $F > /tmp/fb.run 2>&1; grep -q '^# fail 0' /tmp/fb.run" > /tmp/fb.log 2>&1
SHA=$(grep -m1 "is the first bad commit" /tmp/fb.log | awk '{print $1}'); git bisect reset >/dev/null 2>&1
echo "added=$GOOD first_bad=$SHA $(git log --format='%ad %an: %s' --date=short -1 $SHA | cut -c1-110)"
