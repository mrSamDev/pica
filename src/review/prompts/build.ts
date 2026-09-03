import { CATEGORIES } from "../../learning/taxonomy/taxonomy.ts";

export const PROMPT_VERSION = "v1";

export interface BuildPromptInput {
  diff: string;
  repo: string;
  prId: string;
  rulesText?: string;
  memoryContext?: string;
}

const OUTPUT_SCHEMA = `[
  {
    "filePath": "src/auth.ts",
    "lineStart": 42,
    "lineEnd": 42,
    "category": "security",
    "patternId": "security:jwt-expiration",
    "severity": "error",
    "message": "JWT expiration isn't validated."
  }
]`;

export function buildPrompt(input: BuildPromptInput): string {
  const sections: string[] = [
    `ROLE: Senior security and correctness reviewer.`,
    `REPO: ${input.repo}`,
    `PR: ${input.prId}`,
    `RULES:`,
    `- Report only evidence-backed findings observable from the diff.`,
    `- Review only added (+) lines.`,
    `- Ignore style, formatting, and naming.`,
    `- severity is one of: error, warning, suggestion.`,
    `- category is one of: ${CATEGORIES.join(", ")}.`,
    `- patternId is a stable canonical key like "security:jwt-expiration".`,
  ];

  if (input.rulesText) {
    sections.push(`REPO RULES:\n${input.rulesText}`);
  }
  if (input.memoryContext) {
    sections.push(`MEMORY:\n${input.memoryContext}`);
  }

  sections.push(`OUTPUT: a JSON array only. No markdown, no prose. Each element matches:`, OUTPUT_SCHEMA, `DIFF:`, input.diff);

  return sections.join("\n\n");
}
