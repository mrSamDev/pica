export const EMBED_DIM = 256;

// Deterministic local embedding (§5.10 V2). Near-duplicate phrasing shares
// character n-grams, so hashing tokens + trigrams into a signed 256-dim vector
// puts the pair close in cosine space without a hosted model. This is the one
// swap point if a real embedding API replaces it later — callers never touch
// the internals.
export function embed(text: string): number[] {
  const vector = Array.from({ length: EMBED_DIM }, () => 0);
  for (const feature of tokenFeatures(text)) {
    // Hashing-trick sign: randomize feature sign so collisions average out
    // instead of piling up.
    const hash = fnv1a(feature);
    const index = hash % EMBED_DIM;
    vector[index] = (vector[index] ?? 0) + ((hash & 1) === 0 ? 1 : -1);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  for (let i = 0; i < EMBED_DIM; i++) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < EMBED_DIM; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

// FNV-1a: fast, stable across processes, no external deps.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function tokenFeatures(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const features = [...tokens];
  for (const token of tokens) {
    if (token.length < 3) continue;
    for (let i = 0; i <= token.length - 3; i++) features.push(token.slice(i, i + 3));
  }
  return features;
}
