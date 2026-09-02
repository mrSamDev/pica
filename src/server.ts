import { loadConfig } from "./config.ts";
import { buildApp } from "./app.ts";
import { createLogger } from "./observability/logger.ts";

const config = loadConfig(process.env);
const logger = createLogger(config);
const app = buildApp(config, logger);

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  logger.fatal({ err: error }, "failed to start server");
  process.exit(1);
}
