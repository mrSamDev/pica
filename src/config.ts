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

const severityWeightsSchema = z.object({
  error: z.coerce.number().positive(),
  warning: z.coerce.number().positive(),
  suggestion: z.coerce.number().positive(),
});

export type SeverityWeights = z.infer<typeof severityWeightsSchema>;

// docker compose renders an absent optional var as "" in the container. Treat a
// blanked string as unset so superRefine can enforce "token OR app creds"
// instead of failing min(1) on a value the operator never actually provided.
const unsetIfBlank = (value: string | undefined): string | undefined => (value && value.trim().length > 0 ? value : undefined);

const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    // Required, no defaults: connection strings and secrets are deployment config.
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    WEBHOOK_SECRET: z.string().min(1),
    LLM_PROVIDER: z.enum(["openrouter", "ollama", "openai", "anthropic"]).default("openrouter"),
    // Required for openrouter/openai/anthropic; unused for ollama (superRefine below).
    LLM_API_KEY: z.string().min(1).optional().transform(unsetIfBlank),
    // Optional endpoint override; each provider client has its own default
    // (openrouter.ai/api/v1, api.openai.com/v1, localhost:11434, api.anthropic.com/v1).
    LLM_BASE_URL: z.url().optional().transform(unsetIfBlank),
    PLATFORM_TOKEN: z.string().optional().transform(unsetIfBlank),
    // GitHub App server-to-server auth (GitHub only): App ID + private key + an
    // installation ID. Replaces PLATFORM_TOKEN when set; install tokens expire
    // hourly, so they are minted/refreshed at request time, not read once. The
    // private key may be raw PEM or its base64 encoding. At least one auth path
    // is required (see superRefine below).
    GITHUB_APP_ID: z.string().optional().transform(unsetIfBlank),
    GITHUB_APP_PRIVATE_KEY: z.string().optional().transform(unsetIfBlank),
    GITHUB_INSTALLATION_ID: z.string().optional().transform(unsetIfBlank),
    PLATFORM: z.enum(["github", "bitbucket"]).default("github"),
    LLM_MODEL: z.string().default("deepseek/deepseek-v4-flash-0731:free"),
    // OpenRouter-only chain-of-thought param; other providers ignore it. Some
    // reasoning models return the answer under `reasoning` and leave `content`
    // empty, which fails the strict content schema — turn this off for
    // non-reasoning or free-tier models.
    LLM_REASONING: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    // Abort an LLM call that exceeds this budget; a hung provider must not hold
    // a review worker forever.
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    // Abort a hung platform fetch (diff/comments/comment POST) so a stuck
    // endpoint cannot hold a review or outcome worker forever (H3).
    PLATFORM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    // HTTP Basic credentials for the dashboard + /metrics endpoints. Required in
    // production; empty in dev disables auth.
    DASHBOARD_USERNAME: z.string().min(1).optional(),
    DASHBOARD_PASSWORD: z.string().min(1).optional(),
    // Comma-separated host allowlist for outbound fetches (SSRF guard).
    ALLOWED_HOSTS: z
      .string()
      .default("api.github.com,github.com,api.bitbucket.org,bitbucket.org,openrouter.ai,api.openai.com,api.anthropic.com,localhost")
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
    // Learner (§5.6). Config, not magic numbers. Defaults tuned so a pattern
    // dismissed 3+ times forms an active rule, matching §14. Tests pin explicit
    // min_evidence / threshold values to exercise the gate progression.
    LEARNER_MIN_EVIDENCE: z.coerce.number().int().positive().default(3),
    LEARNER_ACTIVATION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
    // §5.5 protected categories: auto-ignore rules never suppress severity=error
    // findings in these taxonomy categories. secrets/auth/crypto/injection live
    // under `security`, data loss under `data`, concurrency is its own.
    LEARNER_PROTECTED_CATEGORIES: z
      .string()
      .default("security,data,concurrency")
      .transform(
        (value) =>
          new Set(
            value
              .split(",")
              .map((c) => c.trim().toLowerCase())
              .filter(Boolean),
          ),
      ),
    // §5.7 falsifiability: decay retires a rule after this many days without
    // supporting dismissals; ε-probing re-flags a suppressed pattern in a new
    // glob context at most once per pattern per this window.
    LEARNER_DECAY_DAYS: z.coerce.number().int().positive().default(90),
    LEARNER_PROBE_INTERVAL_DAYS: z.coerce.number().int().positive().default(30),
    // Severity weighting (§5.6): a dismissed error counts more than a dismissed
    // suggestion, in both the generated and negative counts.
    LEARNER_SEVERITY_WEIGHTS: z
      .string()
      .default('{"error":3,"warning":2,"suggestion":1}')
      .transform((value) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          throw new Error("LEARNER_SEVERITY_WEIGHTS must be valid JSON");
        }
        return severityWeightsSchema.parse(parsed);
      }),
  })
  .superRefine((data, ctx) => {
    const appCredsComplete = Boolean(data.GITHUB_APP_ID && data.GITHUB_APP_PRIVATE_KEY && data.GITHUB_INSTALLATION_ID);
    const hasToken = Boolean(data.PLATFORM_TOKEN);
    if (!hasToken && !appCredsComplete) {
      ctx.addIssue({
        code: "custom",
        path: ["PLATFORM_TOKEN"],
        message: "set PLATFORM_TOKEN, or the GitHub App credentials (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_INSTALLATION_ID)",
      });
    }
    const appCredsPartial = [data.GITHUB_APP_ID, data.GITHUB_APP_PRIVATE_KEY, data.GITHUB_INSTALLATION_ID].some(Boolean) && !appCredsComplete;
    if (appCredsPartial) {
      ctx.addIssue({
        code: "custom",
        path: ["GITHUB_APP_ID"],
        message: "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_INSTALLATION_ID must be set together",
      });
    }
    if (data.LLM_PROVIDER !== "ollama" && !data.LLM_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["LLM_API_KEY"],
        message: `LLM_API_KEY is required for provider "${data.LLM_PROVIDER}" (only ollama runs keyless)`,
      });
    }
    if (appCredsComplete && data.PLATFORM === "bitbucket") {
      ctx.addIssue({
        code: "custom",
        path: ["GITHUB_APP_ID"],
        message: "GitHub App credentials are only valid when PLATFORM is github",
      });
    }
  });

export type Config = z.infer<typeof configSchema>;

export interface LearnerConfig {
  minEvidence: number;
  activationThreshold: number;
  severityWeights: SeverityWeights;
  protectedCategories: ReadonlySet<string>;
  decayDays: number;
  probeIntervalDays: number;
}

/** Learner knobs from config, shape the learner consumes directly. */
export function getLearnerConfig(config: Readonly<Config>): LearnerConfig {
  return {
    minEvidence: config.LEARNER_MIN_EVIDENCE,
    activationThreshold: config.LEARNER_ACTIVATION_THRESHOLD,
    severityWeights: config.LEARNER_SEVERITY_WEIGHTS,
    protectedCategories: config.LEARNER_PROTECTED_CATEGORIES,
    decayDays: config.LEARNER_DECAY_DAYS,
    probeIntervalDays: config.LEARNER_PROBE_INTERVAL_DAYS,
  };
}

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
  // The operational endpoints must not be exposed unauthenticated in prod.
  if (parsed.data.NODE_ENV === "production" && (!parsed.data.DASHBOARD_USERNAME || !parsed.data.DASHBOARD_PASSWORD)) {
    throw new Error("DASHBOARD_USERNAME and DASHBOARD_PASSWORD are required when NODE_ENV=production");
  }
  return deepFreeze(parsed.data);
}
