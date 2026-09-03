import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

// A backticked token counts as a path reference when it has a known file
// extension or starts with a top-level dir. Model names (deepseek/deepseek-chat-v3)
// and env values don't qualify, so they can't fail the check.
const KNOWN_DIRS = ["src/", "docs/", "drizzle/", "phases/", "test/", "tools/", "deploy/", ".github/"];
const FILE_RE = /^[\w./@-]+\.(ts|md|yml|yaml|json|sql|sh|example)$/;

function isPathReference(token: string): boolean {
  if (token.includes("=") || token.includes(":")) {
    return false;
  }
  return FILE_RE.test(token) || KNOWN_DIRS.some((dir) => token.startsWith(dir));
}

// Docs must match reality (§0 lesson: README listed dirs that didn't exist).
// Forward: every path a doc references exists in the tree.
// Reverse: every src/ module dir is mentioned in the README.
describe("docs match reality", () => {
  const readmePath = join(ROOT, "README.md");
  const docFiles = [readmePath, ...listDocs(join(ROOT, "docs"))];

  function listDocs(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => join(dir, name));
  }

  it("README.md exists", () => {
    expect(existsSync(readmePath)).toBe(true);
  });

  it("every path referenced in README and docs/ exists in the tree", () => {
    const missing: string[] = [];
    for (const doc of docFiles) {
      if (!existsSync(doc)) continue;
      const tokens = readFileSync(doc, "utf8").match(/`([^`]+)`/g) ?? [];
      for (const raw of tokens) {
        const token = raw.slice(1, -1);
        if (!isPathReference(token)) continue;
        if (!existsSync(join(ROOT, token))) {
          missing.push(`${doc.replace(ROOT, ".")}: \`${token}\``);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every src/ module dir is documented in the README", () => {
    const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
    const srcDirs = readdirSync(join(ROOT, "src"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `src/${entry.name}`);
    const undocumented = srcDirs.filter((dir) => !readme.includes(dir));
    expect(undocumented).toEqual([]);
  });
});
