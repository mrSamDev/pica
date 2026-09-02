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
