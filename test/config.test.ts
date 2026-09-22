import { describe, expect, it } from "vitest";

import { getRepoConfig, loadConfig, getLearnerConfig } from "../src/config.ts";

const validEnv = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: "postgres://localhost:5432/pica",
  REDIS_URL: "redis://localhost:6379",
  WEBHOOK_SECRET: "test-webhook-secret",
  LLM_API_KEY: "test-llm-key",
  PLATFORM_TOKEN: "test-platform-token",
});

describe("config", () => {
  it("rejects missing required var", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://localhost:5432/pica" })).toThrow(/REDIS_URL/);
    expect(() => loadConfig({ ...validEnv(), WEBHOOK_SECRET: undefined })).toThrow(/WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...validEnv(), LLM_API_KEY: undefined })).toThrow(/LLM_API_KEY/);
  });

  it("rejects invalid value", () => {
    expect(() => loadConfig({ ...validEnv(), PORT: "not-a-number" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...validEnv(), DATABASE_URL: "not-a-url" })).toThrow(/DATABASE_URL/);
  });

  it("deepFreezes", () => {
    const config = loadConfig(validEnv());
    expect(Object.isFrozen(config)).toBe(true);
    // SAFETY: test-only cast to prove the frozen object rejects writes
    const mutable = config as { PORT: number };
    expect(() => {
      mutable.PORT = 9999;
    }).toThrow();
  });

  it("has no secrets in defaults", () => {
    // Connection strings and secrets are required, never defaulted.
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://localhost:5432/pica" })).toThrow(/REDIS_URL/);
    // The only defaults are non-secret runtime knobs.
    const config = loadConfig(validEnv());
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.NODE_ENV).toBe("development");
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.PLATFORM).toBe("github");
    expect(config.ALLOWED_HOSTS).toContain("api.github.com");
  });

  it("defaults posting behavior to post mode", () => {
    const config = loadConfig(validEnv());
    expect(config.REVIEW_MODE).toBe("post");
    expect(config.POSTING_CAP).toBe(10);
    expect(config.SUMMARY_COMMENT).toBe(false);
    expect(config.REPO_CONFIG).toEqual({});
  });

  it("defaults LLM to the deepseek v4 flash free model with reasoning on", () => {
    const config = loadConfig(validEnv());
    expect(config.LLM_MODEL).toBe("deepseek/deepseek-v4-flash-0731:free");
    expect(config.LLM_REASONING).toBe(true);
    expect(config.LLM_PROVIDER).toBe("openrouter");
    expect(config.LLM_BASE_URL).toBeUndefined();
    expect(() => loadConfig({ ...validEnv(), LLM_REASONING: "false" })).not.toThrow();
  });

  it("requires LLM_API_KEY for non-ollama providers", () => {
    expect(() => loadConfig({ ...validEnv(), LLM_API_KEY: undefined, LLM_PROVIDER: "openai" })).toThrow(/LLM_API_KEY/);
    expect(() => loadConfig({ ...validEnv(), LLM_API_KEY: undefined, LLM_PROVIDER: "anthropic" })).toThrow(/LLM_API_KEY/);
    expect(() => loadConfig({ ...validEnv(), LLM_API_KEY: undefined, LLM_PROVIDER: "openrouter" })).toThrow(/LLM_API_KEY/);
  });

  it("runs ollama keyless and accepts a provider endpoint override", () => {
    const config = loadConfig({ ...validEnv(), LLM_API_KEY: undefined, LLM_PROVIDER: "ollama", LLM_BASE_URL: "http://gpu-box:11434" });
    expect(config.LLM_PROVIDER).toBe("ollama");
    expect(config.LLM_BASE_URL).toBe("http://gpu-box:11434");
  });

  it("rejects an invalid LLM_PROVIDER and LLM_BASE_URL", () => {
    expect(() => loadConfig({ ...validEnv(), LLM_PROVIDER: "gemini" })).toThrow(/LLM_PROVIDER/);
    expect(() => loadConfig({ ...validEnv(), LLM_BASE_URL: "not-a-url" })).toThrow(/LLM_BASE_URL/);
  });

  it("rejects invalid REPO_CONFIG JSON", () => {
    expect(() => loadConfig({ ...validEnv(), REPO_CONFIG: "not-json" })).toThrow(/REPO_CONFIG/);
    expect(() => loadConfig({ ...validEnv(), REPO_CONFIG: '{"owner/repo":{"mode":"bogus"}}' })).toThrow();
  });

  it("accepts GitHub App credentials instead of a PAT", () => {
    const cfg = loadConfig({
      ...validEnv(),
      PLATFORM_TOKEN: undefined,
      GITHUB_APP_ID: "123456",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----",
      GITHUB_INSTALLATION_ID: "789",
    });
    expect(cfg.GITHUB_APP_ID).toBe("123456");
  });

  it("rejects config with neither a PAT nor complete GitHub App credentials", () => {
    expect(() => loadConfig({ ...validEnv(), PLATFORM_TOKEN: undefined })).toThrow(/PLATFORM_TOKEN/);
    expect(() => loadConfig({ ...validEnv(), PLATFORM_TOKEN: undefined, GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "pem" })).toThrow(/GITHUB_APP_ID/);
  });

  it("rejects partial GitHub App credentials", () => {
    expect(() => loadConfig({ ...validEnv(), PLATFORM_TOKEN: undefined, GITHUB_APP_ID: "1" })).toThrow(/GITHUB_APP_ID/);
  });

  it("rejects GitHub App credentials when PLATFORM is bitbucket", () => {
    expect(() =>
      loadConfig({
        ...validEnv(),
        PLATFORM: "bitbucket",
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "pem",
        GITHUB_INSTALLATION_ID: "2",
      }),
    ).toThrow(/GITHUB_APP_ID/);
  });

  it("treats empty-string auth vars as absent (docker compose passes empties)", () => {
    // GitHub App path with an empty PLATFORM_TOKEN (compose interpolates absent
    // vars as "") must boot, not die on min(1) before the superRefine runs.
    expect(() =>
      loadConfig({
        ...validEnv(),
        PLATFORM_TOKEN: "",
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "pem",
        GITHUB_INSTALLATION_ID: "2",
      }),
    ).not.toThrow();
    // Empty token and no app creds must still fail loudly, naming the field.
    expect(() => loadConfig({ ...validEnv(), PLATFORM_TOKEN: "" })).toThrow(/PLATFORM_TOKEN/);
  });

  it("requires dashboard credentials in production", () => {
    expect(() => loadConfig({ ...validEnv(), NODE_ENV: "production" })).toThrow(/DASHBOARD_USERNAME/);
    expect(() => loadConfig({ ...validEnv(), NODE_ENV: "production", DASHBOARD_USERNAME: "admin" })).toThrow(/DASHBOARD_PASSWORD/);
    // Both set -> valid.
    expect(() => loadConfig({ ...validEnv(), NODE_ENV: "production", DASHBOARD_USERNAME: "admin", DASHBOARD_PASSWORD: "secret" })).not.toThrow();
  });

  it("per-repo override wins over global default", () => {
    const config = loadConfig({
      ...validEnv(),
      REVIEW_MODE: "post",
      POSTING_CAP: "10",
      SUMMARY_COMMENT: "false",
      REPO_CONFIG: '{"owner/repo":{"mode":"observe","postingCap":3,"summaryComment":true}}',
    });
    const repo = getRepoConfig(config, "owner/repo");
    expect(repo.mode).toBe("observe");
    expect(repo.postingCap).toBe(3);
    expect(repo.summaryComment).toBe(true);
    // Unlisted repo falls back to globals.
    const other = getRepoConfig(config, "other/repo");
    expect(other.mode).toBe("post");
    expect(other.postingCap).toBe(10);
    expect(other.summaryComment).toBe(false);
  });

  it("§5.5/§5.7: phase-5 knobs default to protected categories + 90d decay + 30d probe window", () => {
    const learner = getLearnerConfig(loadConfig(validEnv()));
    expect(learner.protectedCategories).toEqual(new Set(["security", "data", "concurrency"]));
    expect(learner.decayDays).toBe(90);
    expect(learner.probeIntervalDays).toBe(30);
  });
});
