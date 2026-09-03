import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createMetrics } from "../src/observability/metrics.ts";
import { createLogger } from "../src/observability/logger.ts";
import { createFakeDashboardQueries, createFakeLlm, createFakePlatform, createUnusedDb, createUnusedQueue } from "./helpers/fakes.ts";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

const REQUIRED_SECRETS = ["DATABASE_URL", "REDIS_URL", "WEBHOOK_SECRET", "LLM_API_KEY", "PLATFORM_TOKEN"] as const;

// Strips comments and string contents so a comment mentioning "console.log"
// (or a URL containing "//") can't fool the scanner.
function codeOnly(source: string): string {
  const out: string[] = [];
  let state: "code" | "line" | "block" | "string" = "code";
  let quote = "";
  for (let i = 0; i < source.length; i++) {
    const two = source.slice(i, i + 2);
    if (state === "code") {
      if (two === "//") {
        state = "line";
        i++;
      } else if (two === "/*") {
        state = "block";
        i++;
      } else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
        state = "string";
        quote = source.charAt(i);
      } else {
        out.push(source.charAt(i));
      }
    } else if (state === "line") {
      if (source[i] === "\n") {
        state = "code";
        out.push("\n");
      }
    } else if (state === "block") {
      if (two === "*/") {
        state = "code";
        i++;
      }
    } else if (state === "string") {
      if (source[i] === quote) {
        state = "code";
      }
    }
  }
  return out.join("");
}

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    files.push(...(entry.isDirectory() ? listFiles(path) : [path]));
  }
  return files;
}

describe("security audit", () => {
  it("no console.* calls anywhere in src", () => {
    const offenders: string[] = [];
    for (const file of listFiles(SRC)) {
      if (codeOnly(readFileSync(file, "utf8")).match(/\bconsole\.\w+\s*\(/)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no secrets in config defaults — every secret is required, fail-fast", () => {
    // Behavioral proof: a config with a secret missing must throw, naming it.
    // If a secret ever gains a default, this test catches it before prod does.
    const baseEnv = {
      DATABASE_URL: "postgres://localhost:5432/pica",
      REDIS_URL: "redis://localhost:6379",
      WEBHOOK_SECRET: "s",
      LLM_API_KEY: "s",
      PLATFORM_TOKEN: "s",
    };
    for (const secret of REQUIRED_SECRETS) {
      const env = Object.fromEntries(REQUIRED_SECRETS.filter((key) => key !== secret).map((key) => [key, baseEnv[key]]));
      expect(() => loadConfig(env), `${secret} must be required`).toThrow(new RegExp(secret));
    }

    // Source scan: no secret-named config key may carry a .default(...).
    const configSource = readFileSync(join(SRC, "config.ts"), "utf8");
    for (const secret of REQUIRED_SECRETS) {
      const line = configSource.split("\n").find((l) => l.includes(`${secret}:`));
      expect(line, `${secret} must be declared in config.ts`).toBeDefined();
      expect(line, `${secret} must not have a default`).not.toMatch(/\.default\(/);
    }

    // Compose must not embed secret values either (KavalX lesson: postgres:postgres).
    // Accept any form of env interpolation (${VAR}, ${VAR:-default}, ${VAR:?...});
    // the guard is against a hardcoded value, not against the `?` suffix.
    const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
    const secretLines = compose.split("\n").filter((l) => /secret|password|token|api_key/i.test(l) && !l.trimStart().startsWith("#"));
    for (const line of secretLines) {
      expect(line, `compose secret must use env interpolation, got: ${line}`).toMatch(/\$\{[A-Z_]+(?::[^}]*)?\}/);
    }
  });

  it("/metrics is gated by Basic auth but /health stays open for the compose healthcheck", async () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost:5432/pica",
      REDIS_URL: "redis://localhost:6379",
      WEBHOOK_SECRET: "s",
      LLM_API_KEY: "s",
      PLATFORM_TOKEN: "s",
      LOG_LEVEL: "silent",
    });
    const app = buildApp(config, createLogger(config), {
      db: createUnusedDb(),
      queue: createUnusedQueue(),
      platform: createFakePlatform(),
      llm: createFakeLlm(),
      dashboardQueries: createFakeDashboardQueries(),
      metrics: createMetrics(),
      getLearningLag: async () => null,
      getDismissalRate: async () => null,
      auth: { username: "ops", password: "correct-horse" },
    });

    const noCreds = await app.inject({ method: "GET", url: "/metrics" });
    expect(noCreds.statusCode).toBe(401);

    const wrongCreds = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Basic ${Buffer.from("ops:wrong").toString("base64")}` },
    });
    expect(wrongCreds.statusCode).toBe(401);

    const rightCreds = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Basic ${Buffer.from("ops:correct-horse").toString("base64")}` },
    });
    expect(rightCreds.statusCode).toBe(200);

    // The compose healthcheck hits /health without credentials.
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    await app.close();
  });

  it("docs referenced by the audit checklist exist", () => {
    const audit = readFileSync(join(ROOT, "docs", "security-audit.md"), "utf8");
    const references = audit.match(/`([\w./-]+\.(?:ts|md|yml|sql))`/g) ?? [];
    for (const raw of references) {
      const path = raw.slice(1, -1);
      const exists = statSync(join(ROOT, path), { throwIfNoEntry: false });
      if (!exists) {
        throw new Error(`security-audit.md references missing file: ${path}`);
      }
    }
    expect(references.length).toBeGreaterThan(0);
  });
});
