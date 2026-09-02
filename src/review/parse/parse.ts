import { z } from "zod";

import type { Finding } from "../types.ts";

const findingSchema = z.object({
  filePath: z.string().min(1),
  lineStart: z.number().int(),
  lineEnd: z.number().int(),
  category: z.string().min(1),
  patternId: z.string().min(1),
  severity: z.enum(["error", "warning", "suggestion"]),
  message: z.string().min(1),
});

export function stripFences(raw: string): string {
  return raw
    .replace(/```(?:json)?\s*\n?/gi, "")
    .replace(/\n?```/g, "")
    .trim();
}

/**
 * Strictly parse the LLM's review output into findings. Throws on malformed
 * JSON or any finding that does not match the contract, so a bad model response
 * never silently produces partial or wrong findings.
 */
export function parseReviewOutput(raw: string): Finding[] {
  const cleaned = stripFences(raw);
  if (!cleaned) {
    throw new Error("Empty LLM output");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("LLM output is not valid JSON");
  }

  const result = z.array(findingSchema).safeParse(parsed);
  if (!result.success) {
    throw new Error("LLM output does not match finding schema");
  }

  // patternUuid is unresolved here; the pipeline resolves it via ensurePattern
  // before the postfilter runs.
  return result.data.map((finding) => ({ ...finding, patternUuid: "" }));
}
