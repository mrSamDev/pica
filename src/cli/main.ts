import { Pool } from "pg";

import { parseArgs } from "./args.ts";
import { runCommand, type CliDeps } from "./commands.ts";
import { loadConfig } from "../config.ts";
import { createDb } from "../db/client.ts";
import { createOpenRouterLLM } from "../llm/openrouter.ts";
import { createMetrics } from "../observability/metrics.ts";
import { createBitbucketClient } from "../platform/bitbucket.ts";
import { createGitHubClient } from "../platform/github.ts";
import { createPlatformTokenProvider } from "../platform/token.ts";

// review-agent CLI entry (§11). Builds real deps from the environment and
// prints what runCommand returns. No console.log anywhere in src — this
// process writes through stdout/stderr directly.

async function main(): Promise<number> {
  let pool: Pool | undefined;
  try {
    const config = loadConfig(process.env);
    pool = new Pool({ connectionString: config.DATABASE_URL });
    const platformTokenProvider = createPlatformTokenProvider(config);
    const deps: CliDeps = {
      db: createDb(pool),
      platform:
        config.PLATFORM === "bitbucket"
          ? createBitbucketClient({ tokenProvider: platformTokenProvider, allowedHosts: new Set(config.ALLOWED_HOSTS), maxDiffBytes: config.MAX_DIFF_BYTES })
          : createGitHubClient({ tokenProvider: platformTokenProvider, allowedHosts: new Set(config.ALLOWED_HOSTS), maxDiffBytes: config.MAX_DIFF_BYTES }),
      llm: createOpenRouterLLM({ apiKey: config.LLM_API_KEY, model: config.LLM_MODEL, timeoutMs: config.LLM_TIMEOUT_MS, reasoning: config.LLM_REASONING }),
      config,
      metrics: createMetrics(),
      now: () => new Date(),
    };

    const command = parseArgs(process.argv.slice(2));
    const output = await runCommand(deps, command);
    process.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`review-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await pool?.end();
  }
}

const exitCode = await main();
process.exitCode = exitCode;
