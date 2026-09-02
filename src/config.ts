import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Required, no defaults: connection strings are deployment secrets.
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
});

export type Config = z.infer<typeof configSchema>;

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
