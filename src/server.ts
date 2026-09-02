import { loadConfig } from "./config.ts";
import { buildApp } from "./app.ts";
import { createLogger } from "./observability/logger.ts";

const config = loadConfig(process.env);
const logger = createLogger(config);
const app = buildApp(config, logger);

// Graceful shutdown: stop accepting new connections, drain in-flight requests.
// Docker/Kubernetes send SIGTERM on deploy/scale-down.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    app
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        logger.error({ err: error }, "error during shutdown");
        process.exit(1);
      });
  });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  logger.fatal({ err: error }, "failed to start server");
  process.exit(1);
}
