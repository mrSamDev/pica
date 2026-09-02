export const dashboardSchema = {
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
