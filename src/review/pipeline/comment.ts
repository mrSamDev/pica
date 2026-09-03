import type { Finding } from "../types.ts";

// §5.12 feedback protocol: the footer teaches humans the reply syntax so
// dismissals can carry a reason — the parser side lives in
// src/learning/feedback/reply-parser.ts.
export function withFeedbackFooter(finding: Finding): string {
  const probeMarker = finding.isProbe ? "\n\n_🔎 learn-probe: re-checking a pattern we learned to ignore, in a new context. If it's still noise, dismiss it again._\n" : "";
  return `⚠️ ${finding.filePath}:${finding.lineStart} — ${finding.message}

_Not useful? Reply \`dismiss: <reason>\` and I'll learn to stop flagging this._${probeMarker}`;
}
