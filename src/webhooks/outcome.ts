import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db/client.ts";
import { postedComments } from "../db/schema.ts";
import { parseReply } from "../learning/feedback/reply-parser.ts";
import type { OutcomeStatus } from "../learning/feedback/state.ts";
import type { OutcomeQueue } from "../queue/outcome.ts";

export const outcomeEventSchema = z.object({
  repo: z.string().min(1),
  prId: z.string().min(1),
  eventType: z.enum(["comment_created", "comment_resolved", "comment_deleted"]),
  commentId: z.string().min(1),
  resolverUser: z.string().optional(),
  content: z.string().optional(),
});

export type OutcomeEvent = z.infer<typeof outcomeEventSchema>;

export interface OutcomeWebhookDeps {
  db: Db;
  queue: OutcomeQueue;
}

export async function handleOutcomeEvent(deps: OutcomeWebhookDeps, event: OutcomeEvent & { platform: "github" | "bitbucket" }): Promise<{ handled: boolean }> {
  const findingId = await findFindingByCommentId(deps.db, event.platform, event.commentId);
  if (!findingId) {
    // Not one of our comments (another bot or a human's own comment).
    return { handled: false };
  }
  const { to, reason } = classifyOutcomeEvent(event);
  await deps.queue.enqueue({ findingId, repo: event.repo, to, reason, resolverUser: event.resolverUser, source: "webhook" });
  return { handled: true };
}

export interface ClassifiedOutcome {
  to: OutcomeStatus;
  reason?: string;
}

function classifyOutcomeEvent(event: OutcomeEvent): ClassifiedOutcome {
  if (event.eventType === "comment_resolved") {
    return { to: "resolved" };
  }
  if (event.eventType === "comment_deleted") {
    return { to: "dismissed" };
  }
  // comment_created: classify the reply via the feedback protocol.
  const parsed = parseReply(event.content ?? "");
  if (parsed.class === "dismiss") {
    return { to: "dismissed", reason: parsed.reason };
  }
  if (parsed.class === "positive") {
    return { to: "resolved" };
  }
  return { to: "replied" };
}

async function findFindingByCommentId(db: Db, platform: string, commentId: string): Promise<string | null> {
  const rows = await db
    .select({ findingId: postedComments.findingId })
    .from(postedComments)
    .where(and(eq(postedComments.platform, platform), eq(postedComments.commentId, commentId)))
    .limit(1);
  return rows[0]?.findingId ?? null;
}
