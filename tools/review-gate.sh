#!/usr/bin/env bash
# pre-commit gate: run pi review on every commit; block medium/large commits with blocking issues.
# Also validates added comments against AGENTS.md rules.
#
# Behavior:
#   - Always runs the pi review on the staged diff (prints findings).
#   - Blocks (exit 1) when the commit is medium/large AND the review flags a blocking issue.
#   - Small commits are never blocked, but the review still runs so issues are visible.
#   - Blocks (exit 1) when added comments violate AGENTS.md comment rules.
#
# Config (env):
#   REVIEW_THRESHOLD   total changed lines (added+deleted) that counts as medium/large. Default 200.
#   REVIEW_SKIP        set to 1 to skip the whole gate (e.g. CI, --no-verify already bypasses).
#   REVIEW_TIMEOUT      seconds to allow the pi review before aborting. Default 900.
#   REVIEW_MODEL       pi model pattern. Default: glm-5.3:cloud.
#   COMMENT_MODEL       pi model pattern for the comment review. Default: deepseek-v4-flash:cloud.
#   COMMENT_TIMEOUT     seconds to allow the comment review before aborting. Default 90.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REVIEW_PROMPT="$ROOT/tools/review-prompt.md"
COMMENT_PROMPT="$ROOT/tools/comment-review-prompt.md"
THRESHOLD="${REVIEW_THRESHOLD:-200}"
REVIEW_TIMEOUT="${REVIEW_TIMEOUT:-900}"
COMMENT_TIMEOUT="${COMMENT_TIMEOUT:-90}"

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

DIFF_FILE="$(mktemp)"
trap 'rm -f "$DIFF_FILE"' EXIT
git diff --cached > "$DIFF_FILE"

if [[ ! -s "$DIFF_FILE" ]]; then
  echo "review-gate: no staged diff, nothing to review"
  exit 0
fi

# --- 2. Run a pi review; writes output to $out_file, returns pi's exit code ---
run_pi() {
  local prompt="$1" input="$2" timeout="$3" out_file="$4" model="${5:-}"
  local model_flag=""
  if [[ -n "$model" ]]; then
    model_flag="--model $model"
  fi
  set +e
  set +m  # disable job-control notifications (suppresses "Terminated" noise)
  pi -p --no-session $model_flag \
    --append-system-prompt "$prompt" \
    "@$input" \
    "Review the entire attached git diff. Cover every file and every hunk — do not sample or skip any part. End with the required JSON verdict." > "$out_file" 2>&1 &
  local pid=$!
  ( sleep "$timeout" && kill "$pid" 2>/dev/null ) &
  local watcher=$!
  wait "$pid"
  local exit_code=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  set -m
  set -e
  return $exit_code
}

REVIEW_MODEL_FLAG=""
if [[ -n "${REVIEW_MODEL:-}" ]]; then
  REVIEW_MODEL_FLAG="$REVIEW_MODEL"
elif [[ -n "${REVIEW_DEFAULT_MODEL:-}" ]]; then
  REVIEW_MODEL_FLAG="$REVIEW_DEFAULT_MODEL"
else
  REVIEW_MODEL_FLAG="glm-5.3:cloud"
fi

echo "review-gate: running pi review..."
REVIEW_OUT="$(mktemp)"
trap 'rm -f "$DIFF_FILE" "$REVIEW_OUT"' EXIT
set +e
run_pi "$REVIEW_PROMPT" "$DIFF_FILE" "$REVIEW_TIMEOUT" "$REVIEW_OUT" "$REVIEW_MODEL_FLAG"
REVIEW_EXIT=$?
set -e
cat "$REVIEW_OUT"

if [[ "$REVIEW_EXIT" -eq 143 ]]; then
  echo "review-gate: pi review timed out after ${REVIEW_TIMEOUT}s. Not blocking, but review was skipped."
elif [[ "$REVIEW_EXIT" -ne 0 ]]; then
  echo "review-gate: pi review failed (exit $REVIEW_EXIT). Not blocking on review failure, but inspect output above."
fi

# --- 3. Parse the main review verdict -----------------------------------------
# Verdict is the last line that is a JSON object.
REVIEW_BLOCK=false
VERDICT="$(grep -E '^\{"block"' "$REVIEW_OUT" | tail -1 || true)"
if [[ -n "$VERDICT" ]]; then
  REVIEW_BLOCK="$(echo "$VERDICT" | grep -oE '"block"[[:space:]]*:[[:space:]]*(true|false)' | grep -oE '(true|false)$' | head -1)"
fi

# --- 4. If the main review blocked, skip the comment review -------------------
# No point validating comments when the change already fails the code review.
COMMENT_BLOCK=false
if [[ "$REVIEW_BLOCK" == "true" ]]; then
  echo "review-gate: main review blocked, skipping comment review"
else
  # Extract added comment lines and review them.
  # Only added lines (start with '+'), strip the '+', keep lines that look like comments.
  COMMENTS_FILE="$(mktemp)"
  trap 'rm -f "$DIFF_FILE" "$REVIEW_OUT" "$COMMENTS_FILE"' EXIT

  git diff --cached --unified=0 \
    | grep -E '^\+' \
    | grep -vE '^\+\+\+' \
    | sed 's/^\+//' \
    | grep -E '(//|/\*|\*|#|<!--|--|;)' \
    > "$COMMENTS_FILE" || true

  if [[ -s "$COMMENTS_FILE" ]]; then
    echo "review-gate: reviewing $(wc -l < "$COMMENTS_FILE" | tr -d ' ') comment line(s) against AGENTS.md"
    COMMENT_MODEL_FLAG=""
    if [[ -n "${COMMENT_MODEL:-}" ]]; then
      COMMENT_MODEL_FLAG="$COMMENT_MODEL"
    else
      COMMENT_MODEL_FLAG="deepseek-v4-flash:cloud"
    fi
    COMMENT_OUT="$(mktemp)"
    trap 'rm -f "$DIFF_FILE" "$REVIEW_OUT" "$COMMENTS_FILE" "$COMMENT_OUT"' EXIT
    set +e
    run_pi "$COMMENT_PROMPT" "$COMMENTS_FILE" "$COMMENT_TIMEOUT" "$COMMENT_OUT" "$COMMENT_MODEL_FLAG"
    COMMENT_EXIT=$?
    set -e
    cat "$COMMENT_OUT"
    if [[ "$COMMENT_EXIT" -eq 143 ]]; then
      echo "review-gate: comment review timed out after ${COMMENT_TIMEOUT}s. Not blocking."
    elif [[ "$COMMENT_EXIT" -ne 0 ]]; then
      echo "review-gate: comment review failed (exit $COMMENT_EXIT). Not blocking."
    else
      COMMENT_VERDICT="$(grep -E '^\{"block"' "$COMMENT_OUT" | tail -1 || true)"
      if [[ -n "$COMMENT_VERDICT" ]]; then
        COMMENT_BLOCK="$(echo "$COMMENT_VERDICT" | grep -oE '"block"[[:space:]]*:[[:space:]]*(true|false)' | grep -oE '(true|false)$' | head -1)"
      fi
    fi
  else
    echo "review-gate: no comment lines in staged diff"
  fi
fi

# --- 5. Decide -----------------------------------------------------------------
if [[ "$REVIEW_BLOCK" == "true" && "$TOTAL" -ge "$THRESHOLD" ]]; then
  echo ""
  echo "review-gate: BLOCKED — medium/large commit ($TOTAL lines) with blocking issues from review."
  echo "Split the change into smaller commits or fix the flagged issues, then retry."
  echo "To bypass (not recommended): git commit --no-verify"
  exit 1
fi

if [[ "$REVIEW_BLOCK" == "true" ]]; then
  echo ""
  echo "review-gate: review flagged blocking issues, but commit is small (< $THRESHOLD lines) so not blocked."
  echo "Fix these before they compound:"
  echo "$VERDICT"
fi

if [[ "$COMMENT_BLOCK" == "true" ]]; then
  echo ""
  echo "review-gate: BLOCKED — comment(s) violate AGENTS.md rules."
  echo "Fix the flagged comments, then retry. To bypass: git commit --no-verify"
  exit 1
fi

echo "review-gate: passed"
exit 0
