import { z } from "zod";

export type ReviewMode = "observe" | "post" | "dry-run";

const repoConfigSchema = z.record(
  z.string(),
  z.object({
    mode: z.enum(["observe", "post", "dry-run"]).optional(),
    postingCap: z.coerce.number().int().positive().optional(),
    summaryComment: z.boolean().optional(),
  }),
);

type RepoConfigOverride = z.infer<typeof repoConfigSchema>[string];

export interface RepoConfig {
  mode: ReviewMode;
  postingCap: number;
  summaryComment: boolean;
}

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Required, no defaults: connection strings and secrets are deployment config.
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  WEBHOOK_SECRET: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
  PLATFORM_TOKEN: z.string().min(1),
  PLATFORM: z.enum(["github", "bitbucket"]).default("github"),
  LLM_MODEL: z.string().default("deepseek/deepseek-chat-v3"),
  // Abort an LLM call that exceeds this budget; a hung provider must not hold
  // a review worker forever.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Comma-separated host allowlist for outbound fetches (SSRF guard).
  ALLOWED_HOSTS: z
    .string()
    .default("api.github.com,github.com,api.bitbucket.org,bitbucket.org,openrouter.ai")
    .transform((value) =>
      value
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean),
    ),
  MAX_DIFF_BYTES: z.coerce.number().int().positive().default(2_000_000),
  // Posting behavior. Per-repo overrides win over these globals.
  REVIEW_MODE: z.enum(["observe", "post", "dry-run"]).default("post"),
  POSTING_CAP: z.coerce.number().int().positive().default(10),
  SUMMARY_COMMENT: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // JSON object mapping repo -> { mode?, postingCap?, summaryComment? }.
  REPO_CONFIG: z
    .string()
    .default("{}")
    .transform((value) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error("REPO_CONFIG must be valid JSON");
      }
      return repoConfigSchema.parse(parsed);
    }),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Effective posting behavior for a repo: per-repo override, else global default.
 */
export function getRepoConfig(config: Readonly<Config>, repo: string): RepoConfig {
  const override: RepoConfigOverride | undefined = config.REPO_CONFIG[repo];
  return {
    mode: override?.mode ?? config.REVIEW_MODE,
    postingCap: override?.postingCap ?? config.POSTING_CAP,
    summaryComment: override?.summaryComment ?? config.SUMMARY_COMMENT,
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (Object(value) !== value) {
    return value;
  }
  // SAFETY: Object(value) === value above guarantees value is a non-null object here
  for (const [, child] of Object.entries(value as object)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export function loadConfig(env: NodeJS.ProcessEnv): Readonly<Config> {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid configuration: ${detail}`);
  }
  return deepFreeze(parsed.data);
}
