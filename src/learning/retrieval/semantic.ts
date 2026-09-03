import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { patterns } from "../../db/schema.ts";
import { embed } from "./embed.ts";

// §5.10 V2 semantic retrieval tier. Exact taxonomy matching (V1) splits
// near-duplicate phrasings that the LLM gave different pattern_ids; embedding
// distance relates them so evidence pools instead of fragmenting (see
// docs/retrieval-problem.md). Tuned on the eval corpus in test/eval-retrieval.
export const V2_THRESHOLD = 0.5;

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

// Nearest same-repo patterns to `message` by cosine distance. The exact-id
// sibling is excluded so this surfaces the *fragmented* copy, not the row
// itself. NULL embeddings (patterns not yet re-embedded) never match.
export async function findRelatedPatterns(db: Db, repo: string, message: string, options: { threshold?: number; limit?: number; excludePatternId?: string } = {}): Promise<string[]> {
  const threshold = options.threshold ?? V2_THRESHOLD;
  const limit = options.limit ?? 10;
  const query = db
    .select({ key: patterns.canonicalMessage })
    .from(patterns)
    .where(
      sql`${patterns.repo} = ${repo}
        and ${patterns.embedding} is not null
        and 1 - (${patterns.embedding} <=> ${vectorLiteral(embed(message))}::vector) >= ${threshold}
        ${options.excludePatternId ? sql`and ${patterns.id} <> ${options.excludePatternId}` : sql``}`,
    )
    .orderBy(sql`${patterns.embedding} <=> ${vectorLiteral(embed(message))}::vector`)
    .limit(limit);
  const rows = await query;
  return rows.map((row) => row.key);
}
