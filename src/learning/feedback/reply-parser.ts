// §5.12 feedback protocol on the bot's comments. A tiny deterministic parser
// classifies a human reply without an LLM call. Word-boundary anchors so
// "dismissing users is bad" is not read as a dismissal.

export type ReplyClass = "dismiss" | "positive" | "neutral";

export interface ParsedReply {
  class: ReplyClass;
  reason?: string;
}

export function parseReply(text: string): ParsedReply {
  const normalized = text.trim().toLowerCase();

  const dismissReason = /^dismiss\s*:\s*(.*)$/.exec(normalized);
  if (dismissReason) {
    return { class: "dismiss", reason: dismissReason[1]?.trim() || undefined };
  }

  if (/^(dismiss|not useful|false positive)\b/.test(normalized)) {
    return { class: "dismiss" };
  }

  if (/^(good catch|fixed|resolved)\b/.test(normalized)) {
    return { class: "positive" };
  }

  return { class: "neutral" };
}
