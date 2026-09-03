import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

// Comment-hygiene gate (§13 Phase 6). Enforced against src/ the same way the
// `no console.log` guard is (security-audit.test.ts): a deterministic tree
// scan, not a lint plugin. It catches what is mechanically decidable:
// duplicated comment text, decorative banner lines, and comments that merely
// echo the identifiers of the line they annotate. It deliberately does NOT
// catch a paraphrase like `// increment count` above `count++` — the verb is
// not in the code line — because pinning that down needs a model, and a
// fuzzy heuristic would false-positive on the why-comments this gate protects.
// Restatements without a code-echo are caught by human review (AGENTS.md
// §Comments), the same place they have always lived.

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    files.push(...(entry.isDirectory() ? listFiles(path) : [path]));
  }
  return files;
}

// Lowercase alphanumeric words; strips §, punctuation, and whitespace so
// `§5.7` and `learning_lag` both normalize without surprising the scan.
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

// Split an identifier into its camelCase / snake / kebab parts so the
// token-echo check can compare `payloadHash` against `payload` + `hash`.
function identifierParts(id: string): string[] {
  const parts: string[] = [];
  for (const piece of id.split(/[^a-zA-Z0-9]/)) {
    if (!piece) continue;
    const pieces = piece
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(" ")
      .map((s) => s.toLowerCase())
      .filter((s) => s.length >= 2);
    parts.push(...pieces);
  }
  return parts;
}

interface Comment {
  file: string;
  line: number;
  body: string;
}

// Full-line `//` comments across src. `/** */` jsdoc blocks are out of scope:
// multi-line prose rarely duplicates verbatim, and a deterministic line scanner
// would under-read it — those are for human review (AGENTS.md §Comments).
function srcComments(files: string[]): Comment[] {
  const comments: Comment[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = (lines[i] ?? "").trim();
      if (!trimmed.startsWith("//")) continue;
      comments.push({ file, line: i + 1, body: trimmed.slice(2).trim() });
    }
  }
  return comments;
}

describe("comment hygiene (Phase 6)", () => {
  const files = listFiles(SRC);

  it("no comment line is duplicated (normalized) across different files", () => {
    const byText = new Map<string, Comment[]>();
    for (const comment of srcComments(files)) {
      const commentWords = words(comment.body);
      if (commentWords.length < 6) continue;
      const key = commentWords.join(" ");
      byText.set(key, [...(byText.get(key) ?? []), comment]);
    }
    const offenders: string[] = [];
    for (const group of byText.values()) {
      const distinctFiles = new Set(group.map((c) => c.file));
      if (distinctFiles.size < 2) continue;
      for (const comment of group) {
        offenders.push(`${comment.file}:${comment.line}: ${comment.body}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no decorative banner comment lines (---, ===, *** separators)", () => {
    const offenders = srcComments(files)
      .filter((comment) => comment.body && /^[\s*=._+-]{3,}$/.test(comment.body))
      .map((comment) => `${comment.file}:${comment.line}: ${comment.body}`);
    expect(offenders).toEqual([]);
  });

  it("no full-line comment merely echoes the identifiers of its code", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const trimmed = (lines[i] ?? "").trim();
        if (!trimmed.startsWith("//")) continue;
        const body = trimmed.slice(2).trim();
        const commentWords = words(body);
        if (commentWords.length === 0 || commentWords.length > 8) continue;
        // Reference code: text before the comment (trailing) or the next
        // non-comment line (leading).
        let reference = (lines[i] ?? "").split("//")[0] ?? "";
        let j = i + 1;
        while (j < lines.length && (lines[j] ?? "").trim().startsWith("//")) j++;
        if (!reference.trim() && j < lines.length) reference = lines[j] ?? "";
        const codeIds = new Set(words(reference).flatMap(identifierParts));
        if (commentWords.every((word) => codeIds.has(word))) {
          offenders.push(`${file}:${i + 1}: ${body}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
