import type { Finding } from "../types.ts";

// §5.12 feedback protocol: the footer teaches humans the reply syntax so
// dismissals can carry a reason — the parser side lives in
// src/learning/feedback/reply-parser.ts.
export function withFeedbackFooter(finding: Finding): string {
  return `⚠️ ${finding.filePath}:${finding.lineStart} — ${finding.message}

_Not useful? Reply \`dismiss: <reason>\` and I'll learn to stop flagging this._`;
}
