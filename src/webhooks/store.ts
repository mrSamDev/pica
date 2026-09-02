import { eq } from "drizzle-orm";

import { reviews, webhookEvents } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import type { NewReviewRecord, WebhookEventRecord, WebhookStore } from "./types.ts";

export function createWebhookStore(db: Db): WebhookStore {
  return {
    async hasEvent(eventKey: string) {
      const rows = await db.select({ id: webhookEvents.id }).from(webhookEvents).where(eq(webhookEvents.eventKey, eventKey));
      return rows.length > 0;
    },
    async recordEvent(event: WebhookEventRecord) {
      await db.insert(webhookEvents).values({
        platform: event.platform,
        eventKey: event.eventKey,
        deliveryId: event.deliveryId,
        validated: event.validated,
        processed: event.processed,
      });
    },
    async createReview(review: NewReviewRecord) {
      const inserted = await db
        .insert(reviews)
        .values({
          repo: review.repo,
          prId: review.prId,
          commitSha: review.commitSha,
          status: review.status,
          mode: review.mode,
        })
        .returning({ id: reviews.id });
      return inserted[0]?.id ?? "";
    },
  };
}
