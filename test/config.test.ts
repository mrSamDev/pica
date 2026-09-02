import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";

const validEnv = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: "postgres://localhost:5432/pica",
  REDIS_URL: "redis://localhost:6379",
});

describe("config", () => {
  it("rejects missing required var", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://localhost:5432/pica" })).toThrow(/REDIS_URL/);
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
    // Connection strings are required, never defaulted.
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://localhost:5432/pica" })).toThrow(/REDIS_URL/);
    // The only defaults are non-secret runtime knobs.
    const config = loadConfig(validEnv());
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.NODE_ENV).toBe("development");
    expect(config.HOST).toBe("0.0.0.0");
  });
});
