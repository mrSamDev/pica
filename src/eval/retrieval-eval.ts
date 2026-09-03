import { cosineSimilarity, embed } from "../learning/retrieval/embed.ts";
import { V2_THRESHOLD } from "../learning/retrieval/semantic.ts";

export interface CorpusPhrase {
  message: string;
  patternId: string;
}

export interface RetrievalComparison {
  taxonomyRecall: number;
  semanticRecall: number;
}

// §13 Phase 7: semantic vs taxonomy retrieval. Golden pairs are same-issue
// phrasings that must be retrieved as related. Taxonomy recall is the share
// sharing an exact pattern_id; semantic recall the share within embedding
// threshold — so the comparison stays retrieval-only, no LLM call.
export function compareRetrieval(phrases: CorpusPhrase[], goldenPairs: Array<[number, number]>): RetrievalComparison {
  if (goldenPairs.length === 0) return { taxonomyRecall: 0, semanticRecall: 0 };
  const embeddings = phrases.map((p) => embed(p.message));
  let taxonomy = 0;
  let semantic = 0;
  for (const [i, j] of goldenPairs) {
    const a = phrases[i];
    const b = phrases[j];
    if (!a || !b) continue;
    if (a.patternId === b.patternId) taxonomy++;
    if (cosineSimilarity(embeddings[i] ?? [], embeddings[j] ?? []) >= V2_THRESHOLD) semantic++;
  }
  return { taxonomyRecall: taxonomy / goldenPairs.length, semanticRecall: semantic / goldenPairs.length };
}
