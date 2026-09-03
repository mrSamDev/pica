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
            failedJobs: { type: "integer" },
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
        outcomes: {
          type: "object",
          properties: {
            posted: { type: "integer" },
            replied: { type: "integer" },
            resolved: { type: "integer" },
            dismissed: { type: "integer" },
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
            probes: {
              type: "array",
              items: {
                type: "object",
                properties: { patternId: { type: "string" }, filePath: { type: "string" }, at: { type: "string" } },
              },
            },
          },
        },
        recentActivity: { type: "array" },
      },
    },
  },
};

export const rulesSchema = {
  response: {
    200: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          repo: { type: "string" },
          ruleType: { type: "string" },
          status: { type: "string" },
          pattern: { type: ["string", "null"] },
          confidence: { type: ["number", "null"] },
          evidenceCount: { type: "integer" },
          positiveCount: { type: "integer" },
          negativeCount: { type: "integer" },
          createdAt: { type: ["string", "null"] },
        },
      },
    },
  },
};

export const whySchema = {
  querystring: {
    type: "object",
    properties: { findingId: { type: "string" } },
    required: ["findingId"],
  },
  response: {
    200: {
      type: ["object", "null"],
      properties: {
        finding: {
          type: "object",
          properties: { status: { type: "string" }, filePath: { type: "string" }, message: { type: "string" }, severity: { type: "string" }, prId: { type: "string" } },
        },
        pattern: { type: "object", properties: { canonicalMessage: { type: "string" }, category: { type: "string" } } },
        rule: {
          type: ["object", "null"],
          properties: { status: { type: "string" }, confidence: { type: ["number", "null"] }, evidenceCount: { type: "integer" }, positiveCount: { type: "integer" }, negativeCount: { type: "integer" } },
        },
        evidence: { type: "array", items: { type: "object", properties: { prId: { type: "string" }, outcome: { type: "string" } } } },
        lastProbe: { type: ["string", "null"] },
      },
    },
  },
};
