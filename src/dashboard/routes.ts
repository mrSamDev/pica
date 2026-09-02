import type { FastifyPluginAsync, FastifyTypeProviderDefault, RawServerDefault } from "fastify";
import type { Logger } from "pino";

const dashboardHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pica — control room</title>
    <style>
      body { font-family: ui-monospace, monospace; background: #0b0e11; color: #d7dde3; margin: 0; padding: 2rem; }
      h1 { font-size: 1.25rem; color: #e8edf2; }
      .panel { border: 1px solid #2a3138; border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
      .panel h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #8b98a5; margin: 0 0 0.5rem; }
      .empty { color: #5b6672; font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <h1>Pica — control room</h1>
    <div class="panel"><h2>System health</h2><p class="empty">No data yet.</p></div>
    <div class="panel"><h2>Review behavior</h2><p class="empty">No data yet.</p></div>
    <div class="panel"><h2>Learning</h2><p class="empty">No data yet.</p></div>
    <div class="panel"><h2>Recent activity</h2><p class="empty">No data yet.</p></div>
  </body>
</html>`;

const dashboardSchema = {
  response: {
    200: {
      type: "object",
      properties: {
        system: {
          type: "object",
          properties: {
            reviewsRunning: { type: "integer" },
            reviewsCompleted: { type: "integer" },
            reviewsFailed: { type: "integer" },
            queueDepth: { type: "integer" },
          },
        },
        reviewBehavior: {
          type: "object",
          properties: {
            findingsPerPr: { type: "integer" },
            posted: { type: "integer" },
            suppressed: { type: "integer" },
            duplicate: { type: "integer" },
          },
        },
        learning: {
          type: "object",
          properties: {
            activeRules: { type: "integer" },
            candidateRules: { type: "integer" },
            retiredRules: { type: "integer" },
            learningLagMs: { type: ["integer", "null"] },
            dismissalRateTrend: { type: "array", items: { type: "number" } },
          },
        },
        recentActivity: { type: "array" },
      },
    },
  },
};

export const dashboardPlugin: FastifyPluginAsync<Record<never, never>, RawServerDefault, FastifyTypeProviderDefault, Logger> = async (app) => {
  app.get("/dashboard", async (_request, reply) => {
    return reply.type("text/html").send(dashboardHtml);
  });

  app.get("/api/dashboard", { schema: dashboardSchema }, async () => {
    return {
      system: {
        reviewsRunning: 0,
        reviewsCompleted: 0,
        reviewsFailed: 0,
        queueDepth: 0,
      },
      reviewBehavior: {
        findingsPerPr: 0,
        posted: 0,
        suppressed: 0,
        duplicate: 0,
      },
      learning: {
        activeRules: 0,
        candidateRules: 0,
        retiredRules: 0,
        learningLagMs: null,
        dismissalRateTrend: [],
      },
      recentActivity: [],
    };
  });
};
