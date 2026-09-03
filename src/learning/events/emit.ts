import type { Db } from "../../db/client.ts";
import { learningEvents } from "../../db/schema.ts";

export interface LearningEvent {
  eventKey: string;
  repo: string;
  eventType: string;
  aggregateId: string;
  payload: unknown;
}

/** Append an immutable learning event. Deterministic event_key makes retries safe. */
export async function emitEvent(db: Db, event: LearningEvent): Promise<void> {
  await db
    .insert(learningEvents)
    .values({
      eventKey: event.eventKey,
      repo: event.repo,
      eventType: event.eventType,
      aggregateId: event.aggregateId,
      payload: event.payload,
    })
    .onConflictDoNothing();
}
