import { pino, type Logger } from "pino";

import type { Config } from "../config.ts";

export function createLogger(config: Readonly<Config>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "req.body", "*.password", "*.token", "*.secret", "*.apiKey"],
      censor: "[REDACTED]",
    },
  });
}
