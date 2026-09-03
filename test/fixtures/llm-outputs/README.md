# Taxonomy snapshot fixtures — raw LLM review outputs (§5.4, §9).

These are captured outputs from the real review pipeline (`tools/capture-llm-outputs.ts`)
run against real diffs. Regenerate with:

    node tools/capture-llm-outputs.ts > test/fixtures/llm-outputs/security-auth.json

The snapshot test (`test/taxonomy.test.ts`) parses each file and asserts the
canonical taxonomy classification is stable — no free-text drift, no
normalization surprises. Files are named by the diff they reviewed.
