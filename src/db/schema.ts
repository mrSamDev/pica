import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  repo: text("repo").notNull(),
  prId: text("pr_id").notNull(),
  commitSha: text("commit_sha").notNull(),
  status: text("status").notNull(),
  model: text("model"),
  promptVersion: text("prompt_version"),
  rulesVersion: text("rules_version"),
  retrievalVersion: text("retrieval_version"),
  mode: text("mode").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
});

export const patterns = pgTable(
  "patterns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repo: text("repo").notNull(),
    category: text("category").notNull(),
    canonicalMessage: text("canonical_message").notNull(),
    glob: text("glob"),
    patternVersion: text("pattern_version").notNull(),
    status: text("status").notNull(),
    mergedInto: uuid("merged_into"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex("patterns_repo_category_message_unique").on(table.repo, table.category, table.canonicalMessage)],
);

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id").references(() => reviews.id),
    repo: text("repo").notNull(),
    prId: text("pr_id").notNull(),
    commitSha: text("commit_sha").notNull(),
    filePath: text("file_path").notNull(),
    lineStart: integer("line_start"),
    lineEnd: integer("line_end"),
    category: text("category").notNull(),
    patternId: uuid("pattern_id").references(() => patterns.id),
    severity: text("severity").notNull(),
    message: text("message").notNull(),
    messageHash: text("message_hash").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex("findings_unique").on(table.repo, table.prId, table.commitSha, table.filePath, table.lineStart, table.lineEnd, table.message)],
);

export const postedComments = pgTable(
  "posted_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: uuid("finding_id").references(() => findings.id),
    platform: text("platform").notNull(),
    commentId: text("comment_id").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex("posted_comments_unique").on(table.platform, table.commentId)],
);

export const findingOutcomes = pgTable(
  "finding_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: uuid("finding_id")
      .references(() => findings.id, { onDelete: "cascade" })
      .notNull(),
    status: text("status").notNull(),
    dismissalReason: text("dismissal_reason"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    reason: text("reason"),
    resolverUser: text("resolver_user"),
    replyCount: integer("reply_count").default(0),
    pollCount: integer("poll_count").default(0),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  // One outcome row per finding. The poller and webhook both write here; the
  // unique index makes the invariant hold in the DB, not just in code.
  (table) => [uniqueIndex("finding_outcomes_finding_id_unique").on(table.findingId)],
);

export const learningEvents = pgTable(
  "learning_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventKey: text("event_key").notNull().unique(),
    repo: text("repo").notNull(),
    eventType: text("event_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("learning_events_repo_created_at_idx").on(table.repo, table.createdAt)],
);

export const repoRules = pgTable(
  "repo_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repo: text("repo").notNull(),
    ruleType: text("rule_type").notNull(),
    patternId: uuid("pattern_id").references(() => patterns.id),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    glob: text("glob"),
    status: text("status").notNull(),
    confidence: numeric("confidence"),
    evidenceCount: integer("evidence_count").default(0),
    positiveCount: integer("positive_count").default(0),
    negativeCount: integer("negative_count").default(0),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("repo_rules_unique").on(table.repo, table.ruleType, table.patternId)],
);

// Links every rule to the findings that produced it. Unique per (rule, finding)
// makes the learner's audit-trail insert idempotent across retries.
export const ruleEvidence = pgTable(
  "rule_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id").references(() => repoRules.id),
    findingId: uuid("finding_id").references(() => findings.id),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex("rule_evidence_rule_finding_unique").on(table.ruleId, table.findingId)],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platform: text("platform").notNull(),
    eventKey: text("event_key").notNull(),
    deliveryId: text("delivery_id"),
    validated: boolean("validated").notNull(),
    processed: boolean("processed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex("webhook_events_event_key_unique").on(table.eventKey)],
);

export const llmCalls = pgTable("llm_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  reviewId: uuid("review_id"),
  model: text("model"),
  provider: text("provider"),
  promptHash: text("prompt_hash"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  latencyMs: integer("latency_ms"),
  status: text("status"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
