import { describe, expect, it } from "vitest";

import { getRepoConfig, loadConfig } from "../src/config.ts";

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

  it("rejects invalid REPO_CONFIG JSON", () => {
    expect(() => loadConfig({ ...validEnv(), REPO_CONFIG: "not-json" })).toThrow(/REPO_CONFIG/);
    expect(() => loadConfig({ ...validEnv(), REPO_CONFIG: '{"owner/repo":{"mode":"bogus"}}' })).toThrow();
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
});
