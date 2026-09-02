#!/usr/bin/env bash
# pre-commit gate: review comments in the staged diff against AGENTS.md rules.
#
# Behavior:
#   - Extracts added comment lines from the staged diff.
#   - Runs pi (deepseek-v4-flash:cloud) to validate them against AGENTS.md.
#   - Blocks (exit 1) when the review flags comment violations.
#
# Config (env):
#   COMMENT_SKIP        set to 1 to skip this gate.
#   COMMENT_MODEL       pi model pattern. Default: deepseek-v4-flash:cloud.
#   COMMENT_TIMEOUT     seconds to allow the review before aborting. Default 90.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT="$ROOT/tools/comment-review-prompt.md"
TIMEOUT="${COMMENT_TIMEOUT:-90}"

if [[ "${COMMENT_SKIP:-0}" == "1" ]]; then
  echo "comment-gate: COMMENT_SKIP=1, skipping"
  exit 0
fi

# --- 1. Extract added comment lines from the staged diff ---------------------
# Only added lines (start with '+'), strip the '+', keep lines that look like comments.
COMMENTS_FILE="$(mktemp)"
trap 'rm -f "$COMMENTS_FILE"' EXIT

git diff --cached --unified=0 \
  | grep -E '^\+' \
  | grep -vE '^\+\+\+' \
  | sed 's/^\+//' \
  | grep -E '(//|/\*|\*|#|<!--|--|;)' \
  > "$COMMENTS_FILE" || true

if [[ ! -s "$COMMENTS_FILE" ]]; then
  echo "comment-gate: no comment lines in staged diff, nothing to review"
  exit 0
fi

echo "comment-gate: reviewing $(wc -l < "$COMMENTS_FILE" | tr -d ' ') comment line(s) against AGENTS.md"

# --- 2. Run the comment review -------------------------------------------------
MODEL_FLAG=""
if [[ -n "${COMMENT_MODEL:-}" ]]; then
  MODEL_FLAG="--model $COMMENT_MODEL"
else
  MODEL_FLAG="--model deepseek-v4-flash:cloud"
fi

REVIEW_OUT="$(mktemp)"
trap 'rm -f "$COMMENTS_FILE" "$REVIEW_OUT"' EXIT

set +e
set +m
pi -p --no-session $MODEL_FLAG \
  --append-system-prompt "$PROMPT" \
  "@$COMMENTS_FILE" \
  "Review these comments against AGENTS.md. End with the required JSON verdict." > "$REVIEW_OUT" 2>&1 &
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
  echo "comment-gate: review timed out after ${TIMEOUT}s. Not blocking."
  exit 0
fi

cat "$REVIEW_OUT"

if [[ $PI_EXIT -ne 0 ]]; then
  echo "comment-gate: review failed (exit $PI_EXIT). Not blocking."
  exit 0
fi

# --- 3. Parse verdict -----------------------------------------------------------
VERDICT="$(grep -E '^\{"block"' "$REVIEW_OUT" | tail -1 || true)"
if [[ -z "$VERDICT" ]]; then
  echo "comment-gate: no JSON verdict found; not blocking."
  exit 0
fi

BLOCK="$(echo "$VERDICT" | grep -oE '"block"[[:space:]]*:[[:space:]]*(true|false)' | grep -oE '(true|false)$' | head -1)"

# --- 4. Decide ------------------------------------------------------------------
if [[ "$BLOCK" == "true" ]]; then
  echo ""
  echo "comment-gate: BLOCKED — comment(s) violate AGENTS.md rules."
  echo "Fix the flagged comments, then retry. To bypass: git commit --no-verify"
  exit 1
fi

echo "comment-gate: passed"
exit 0
