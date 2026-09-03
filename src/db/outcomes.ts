import { eq, sql } from "drizzle-orm";

import type { OutcomeStatus } from "../learning/feedback/state.ts";
import type { Db } from "./client.ts";
import { findingOutcomes } from "./schema.ts";

export interface OutcomeUpdate {
  status: OutcomeStatus;
  reason?: string;
  resolverUser?: string;
  resolvedAt?: Date;
}

export async function ensureOutcome(db: Db, findingId: string, status: OutcomeStatus): Promise<void> {
  await db.insert(findingOutcomes).values({ findingId, status }).onConflictDoNothing();
}

export async function getOutcome(db: Db, findingId: string): Promise<OutcomeStatus | null> {
  const rows = await db.select({ status: findingOutcomes.status }).from(findingOutcomes).where(eq(findingOutcomes.findingId, findingId)).limit(1);
  // SAFETY: status is the OutcomeStatus text the feedback state machine wrote;
  // casting is safe because every write funnels through it.
  return (rows[0]?.status as OutcomeStatus | null) ?? null;
}

export async function updateOutcome(db: Db, findingId: string, update: OutcomeUpdate): Promise<void> {
  const set: Partial<typeof findingOutcomes.$inferInsert> = { status: update.status, updatedAt: new Date() };
  if (update.reason !== undefined) set.dismissalReason = update.reason;
  if (update.resolverUser !== undefined) set.resolverUser = update.resolverUser;
  if (update.resolvedAt !== undefined) set.resolvedAt = update.resolvedAt;
  await db.update(findingOutcomes).set(set).where(eq(findingOutcomes.findingId, findingId));
}

export async function incrementPollCount(db: Db, findingId: string): Promise<void> {
  await db
    .update(findingOutcomes)
    .set({ pollCount: sql`${findingOutcomes.pollCount} + 1`, lastPolledAt: new Date() })
    .where(eq(findingOutcomes.findingId, findingId));
}
