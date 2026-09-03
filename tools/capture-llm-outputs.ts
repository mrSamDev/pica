// Regenerate real LLM-output fixtures for the taxonomy snapshot test (§9).
//
//   node --env-file=.env tools/capture-llm-outputs.ts security-auth
//   (a fixture name writes one test/fixtures/llm-outputs/<name>.json;
//    no arg writes every raw output to stdout)
//
// Reads the real review prompt + real diffs, calls OpenRouter. Requires a
// working LLM_API_KEY in the environment (the key lives in .env).
import { writeFileSync } from "node:fs";

import { createOpenRouterLLM } from "../src/llm/openrouter.ts";
import { buildPrompt } from "../src/review/prompts/build.ts";

// Small real-world diffs to review; one fixture per diff.
const DIFFS = {
  "security-auth": `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -40,3 +40,4 @@
 const token = getToken();
+if (!token.exp) { throw new Error("missing exp"); }
+const secret = "super-secret-local-key";
`,
  "concurrency-query": `diff --git a/src/orders/query.ts b/src/orders/query.ts
index 111..222 100644
--- a/src/orders/query.ts
+++ b/src/orders/query.ts
@@ -85,3 +85,7 @@
+const available = await db.select({ qty }).from(inventory).where(id);
+if (available.qty > 0) {
+  await db.update(inventory).set({ qty: available.qty - 1 }).where(id);
+}
+return order;
`,
} satisfies Record<string, string>;

if (!process.env.LLM_API_KEY) {
  throw new Error("LLM_API_KEY is required — run via `node --env-file=.env tools/capture-llm-outputs.ts`");
}

const model = process.env.LLM_MODEL ?? "deepseek/deepseek-chat-v3";
const llm = createOpenRouterLLM({ apiKey: process.env.LLM_API_KEY, model, timeoutMs: 90_000 });
const only = process.argv[2];

for (const [name, diff] of Object.entries(DIFFS)) {
  if (only && name !== only) continue;
  const prompt = buildPrompt({ diff, repo: "owner/repo", prId: "fixture" });
  const raw = await llm.review(prompt);
  if (only) {
    writeFileSync(`test/fixtures/llm-outputs/${name}.json`, raw + "\n");
    process.stdout.write(`wrote test/fixtures/llm-outputs/${name}.json\n`);
  } else {
    process.stdout.write(`=== ${name} ===\n${raw}\n`);
  }
}
