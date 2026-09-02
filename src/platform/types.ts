import type { ExistingComment } from "../review/types.ts";

export interface InlineCommentTarget {
  path: string;
  line: number;
  commitSha: string;
}

export interface CommentState {
  resolved: boolean;
  deleted: boolean;
  replyCount: number;
}

export interface PlatformClient {
  fetchDiff(diffHref: string): Promise<string>;
  listComments(repo: string, prId: string): Promise<ExistingComment[]>;
  createInlineComment(repo: string, prId: string, target: InlineCommentTarget, content: string): Promise<{ id: string }>;
  // PR-level comment (not anchored to a line). Used for the observe-mode summary.
  createPrComment(repo: string, prId: string, content: string): Promise<{ id: string }>;
  // Current state of a posted comment, for the feedback poller.
  getCommentState(repo: string, prId: string, commentId: string): Promise<CommentState>;
}
