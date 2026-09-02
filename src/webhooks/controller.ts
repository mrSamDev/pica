import { z } from "zod";

import type { RepoConfig } from "../config.ts";
import type { ReviewRequest } from "../review/types.ts";

export const webhookPayloadSchema = z.object({
  repo: z.string().min(1),
  prId: z.string().min(1),
  commitSha: z.string().min(1),
  diffHref: z.string().url(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

export function parsePlatform(value: string): "github" | "bitbucket" {
  if (value === "github" || value === "bitbucket") {
    return value;
  }
  throw new Error(`Unsupported platform: ${value}`);
}

export function isWebhookPayload(body: unknown): body is WebhookPayload {
  return webhookPayloadSchema.safeParse(body).success;
}

export function toReviewRequest(payload: WebhookPayload, platform: "github" | "bitbucket", repoConfig: RepoConfig): Omit<ReviewRequest, "reviewId"> {
  return { ...payload, platform, mode: repoConfig.mode, postingCap: repoConfig.postingCap, summaryComment: repoConfig.summaryComment };
}
