#!/usr/bin/env bash
# pre-commit gate: run pi review on every commit; block medium/large commits with blocking issues.
#
# Behavior:
#   - Always runs the pi review on the staged diff (prints findings).
#   - Blocks (exit 1) only when the commit is medium/large AND the review flags a blocking issue.
#   - Small commits are never blocked, but the review still runs so issues are visible.
#
# Config (env):
#   REVIEW_THRESHOLD   total changed lines (added+deleted) that counts as medium/large. Default 200.
#   REVIEW_SKIP        set to 1 to skip the review entirely (e.g. CI, --no-verify already bypasses).
#   REVIEW_TIMEOUT      seconds to allow the pi review before aborting. Default 120.
#   REVIEW_MODEL       pi model pattern. Default: glm-5.3:cloud.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT="$ROOT/tools/review-prompt.md"
THRESHOLD="${REVIEW_THRESHOLD:-200}"
TIMEOUT="${REVIEW_TIMEOUT:-120}"

if [[ "${REVIEW_SKIP:-0}" == "1" ]]; then
  echo "review-gate: REVIEW_SKIP=1, skipping"
  exit 0
fi

# --- 1. Measure staged diff size (added + deleted lines) ---------------------
# numstat: <added>\t<deleted>\t<path> per file. Sum both columns.
TOTAL=0
while IFS=$'\t' read -r added deleted _path; do
  # binary files report "-" for added/deleted
  [[ "$added" == "-" ]] && added=0
  [[ "$deleted" == "-" ]] && deleted=0
  TOTAL=$((TOTAL + added + deleted))
done < <(git diff --cached --numstat)

echo "review-gate: staged change = $TOTAL changed lines (threshold $THRESHOLD)"

# --- 2. Run the pi review on the staged diff ---------------------------------
DIFF_FILE="$(mktemp)"
trap 'rm -f "$DIFF_FILE"' EXIT
git diff --cached > "$DIFF_FILE"

if [[ ! -s "$DIFF_FILE" ]]; then
  echo "review-gate: no staged diff, nothing to review"
  exit 0
fi

MODEL_FLAG=""
if [[ -n "${REVIEW_MODEL:-}" ]]; then
  MODEL_FLAG="--model $REVIEW_MODEL"
elif [[ -n "${REVIEW_DEFAULT_MODEL:-}" ]]; then
  MODEL_FLAG="--model $REVIEW_DEFAULT_MODEL"
else
  MODEL_FLAG="--model glm-5.3:cloud"
fi

echo "review-gate: running pi review..."
REVIEW_OUT="$(mktemp)"
trap 'rm -f "$DIFF_FILE" "$REVIEW_OUT"' EXIT

# -p = non-interactive, --no-session = don't persist, @file = include diff contents
set +e
# portable timeout (macOS lacks GNU `timeout`): run pi in background, kill after TIMEOUT
set +m  # disable job-control notifications (suppresses "Terminated" noise)
pi -p --no-session $MODEL_FLAG \
  --append-system-prompt "$PROMPT" \
  "@$DIFF_FILE" \
  "Review this staged diff. End with the required JSON verdict." > "$REVIEW_OUT" 2>&1 &
PI_PID=$!
( sleep "$TIMEOUT" && kill "$PI_PID" 2>/dev/null ) &
WATCHER_PID=$!
wait "$PI_PID"
PI_EXIT=$?
kill "$WATCHER_PID" 2>/dev/null
wait "$WATCHER_PID" 2>/dev/null
set -m
set -e

if [[ $PI_EXIT -eq 143 ]]; then
  echo "review-gate: pi review timed out after ${TIMEOUT}s. Not blocking, but review was skipped."
  exit 0
fi

cat "$REVIEW_OUT"

if [[ $PI_EXIT -ne 0 ]]; then
  echo "review-gate: pi review failed (exit $PI_EXIT). Not blocking on review failure, but inspect output above."
  exit 0
fi

# --- 3. Parse the JSON verdict -------------------------------------------------
# Verdict is the last line that is a JSON object.
VERDICT="$(grep -E '^\{"block"' "$REVIEW_OUT" | tail -1 || true)"
if [[ -z "$VERDICT" ]]; then
  echo "review-gate: no JSON verdict found in review output; not blocking."
  exit 0
fi

BLOCK="$(echo "$VERDICT" | grep -oE '"block"[[:space:]]*:[[:space:]]*(true|false)' | grep -oE '(true|false)$' | head -1)"

# --- 4. Decide ----------------------------------------------------------------
if [[ "$BLOCK" == "true" && "$TOTAL" -ge "$THRESHOLD" ]]; then
  echo ""
  echo "review-gate: BLOCKED — medium/large commit ($TOTAL lines) with blocking issues from review."
  echo "Split the change into smaller commits or fix the flagged issues, then retry."
  echo "To bypass (not recommended): git commit --no-verify"
  exit 1
fi

if [[ "$BLOCK" == "true" ]]; then
  echo ""
  echo "review-gate: review flagged blocking issues, but commit is small (< $THRESHOLD lines) so not blocked."
  echo "Fix these before they compound:"
  echo "$VERDICT"
fi

echo "review-gate: passed"
exit 0
