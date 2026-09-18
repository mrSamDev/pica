import type { Config } from "../config.ts";
import type { ReviewQueue } from "../queue/enqueue.ts";
import type { OutcomeQueue } from "../queue/outcome.ts";

export interface WebhookEventRecord {
  platform: string;
  eventKey: string;
  deliveryId?: string;
  validated: boolean;
  processed: boolean;
}

export interface NewReviewRecord {
  repo: string;
  prId: string;
  commitSha: string;
  status: string;
  mode: string;
}

export interface WebhookStore {
  hasEvent(eventKey: string): Promise<boolean>;
  recordEvent(event: WebhookEventRecord): Promise<void>;
  createReview(review: NewReviewRecord): Promise<string>;
}

export interface WebhookDeps {
  config: Readonly<Config>;
  store: WebhookStore;
  queue: ReviewQueue;
  findFinding: (platform: "github" | "bitbucket", commentId: string) => Promise<string | null>;
  outcomeQueue: OutcomeQueue;
}
