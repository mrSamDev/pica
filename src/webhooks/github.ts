import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { WebhookPayload } from "./controller.ts";
import { handleOutcomeEvents, handleReviewRequest } from "./handlers.ts";
import type { OutcomeEvent } from "./outcome.ts";
import type { WebhookDeps } from "./types.ts";

// GitHub native webhook events → the normalized payloads the rest of the
// system speaks. GitHub delivers its own event shapes under the
// x-github-event header; this file is the only place that knows them.

const repositorySchema = z.object({ full_name: z.string().min(1) });
const pullRequestRefSchema = z.object({ number: z.number() });
const commentIdSchema = z.union([z.number(), z.string()]);

// Only these actions start (or restart) a review. closed/edited/labeled etc.
// carry no new diff worth reviewing.
const reviewActions: ReadonlySet<string> = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export const pullRequestEventSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    head: z.object({ sha: z.string().min(1) }),
    diff_url: z.string().url(),
  }),
  repository: repositorySchema,
});

export const reviewCommentEventSchema = z.object({
  action: z.string(),
  comment: z.object({
    id: commentIdSchema,
    body: z.string().optional(),
    in_reply_to_id: z.number().nullable().optional(),
    user: z.object({ login: z.string() }).optional(),
  }),
  pull_request: pullRequestRefSchema,
  repository: repositorySchema,
});

export const reviewThreadEventSchema = z.object({
  action: z.string(),
  thread: z.object({
    comments: z.array(z.object({ id: commentIdSchema, in_reply_to_id: z.number().nullable().optional() })),
  }),
  pull_request: pullRequestRefSchema,
  repository: repositorySchema,
});

function parentCommentId(comment: { in_reply_to_id?: number | null }): string | undefined {
  return comment.in_reply_to_id === null || comment.in_reply_to_id === undefined ? undefined : String(comment.in_reply_to_id);
}

export function handleGitHubDelivery(deps: WebhookDeps, platform: "github" | "bitbucket", eventName: string, request: FastifyRequest, reply: FastifyReply) {
  switch (eventName) {
    case "ping":
      return { received: true, pinged: true };
    case "push":
      return { received: true, ignored: true };
    case "pull_request": {
      const parsed = pullRequestEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid GitHub webhook payload" });
      }
      const payload = toReviewRequestFromPullRequest(parsed.data);
      if (!payload) {
        return { received: true, ignored: true };
      }
      return handleReviewRequest(deps, platform, payload);
    }
    case "pull_request_review_comment": {
      const parsed = reviewCommentEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid GitHub webhook payload" });
      }
      const events = toOutcomeEventsFromReviewComment(parsed.data);
      if (events.length === 0) {
        return { received: true, ignored: true };
      }
      return handleOutcomeEvents(deps, platform, events);
    }
    case "pull_request_review_thread": {
      const parsed = reviewThreadEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid GitHub webhook payload" });
      }
      const events = toOutcomeEventsFromThread(parsed.data);
      if (events.length === 0) {
        return { received: true, ignored: true };
      }
      return handleOutcomeEvents(deps, platform, events);
    }
    default:
      return { received: true, ignored: true };
  }
}

export function toReviewRequestFromPullRequest(event: z.infer<typeof pullRequestEventSchema>): WebhookPayload | null {
  if (!reviewActions.has(event.action)) {
    return null;
  }
  return {
    repo: event.repository.full_name,
    prId: String(event.pull_request.number),
    commitSha: event.pull_request.head.sha,
    diffHref: event.pull_request.diff_url,
  };
}

export function toOutcomeEventsFromReviewComment(event: z.infer<typeof reviewCommentEventSchema>): OutcomeEvent[] {
  // edited carries no state change: the created event already recorded the
  // comment, and a re-delivered created event would dedup onto it anyway.
  if (event.action !== "created" && event.action !== "deleted") {
    return [];
  }
  return [
    {
      repo: event.repository.full_name,
      prId: String(event.pull_request.number),
      eventType: event.action === "created" ? "comment_created" : "comment_deleted",
      commentId: String(event.comment.id),
      inReplyTo: parentCommentId(event.comment),
      resolverUser: event.comment.user?.login,
      content: event.comment.body,
    },
  ];
}

export function toOutcomeEventsFromThread(event: z.infer<typeof reviewThreadEventSchema>): OutcomeEvent[] {
  // resolved is terminal in the outcome state machine and has no inverse
  // transition, so unresolved cannot move the state back.
  if (event.action !== "resolved") {
    return [];
  }
  return event.thread.comments.map((comment) => ({
    repo: event.repository.full_name,
    prId: String(event.pull_request.number),
    eventType: "comment_resolved" as const,
    commentId: String(comment.id),
    inReplyTo: parentCommentId(comment),
  }));
}
