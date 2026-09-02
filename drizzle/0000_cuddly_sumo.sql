CREATE TABLE "finding_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"status" text NOT NULL,
	"dismissal_reason" text,
	"resolved_at" timestamp with time zone,
	"reason" text,
	"resolver_user" text,
	"reply_count" integer DEFAULT 0,
	"poll_count" integer DEFAULT 0,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid,
	"repo" text NOT NULL,
	"pr_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"file_path" text NOT NULL,
	"line_start" integer,
	"line_end" integer,
	"category" text NOT NULL,
	"pattern_id" uuid,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"message_hash" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "learning_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_key" text NOT NULL,
	"repo" text NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "learning_events_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid,
	"model" text,
	"provider" text,
	"prompt_hash" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer,
	"status" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo" text NOT NULL,
	"category" text NOT NULL,
	"canonical_message" text NOT NULL,
	"glob" text,
	"pattern_version" text NOT NULL,
	"status" text NOT NULL,
	"merged_into" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "posted_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid,
	"platform" text NOT NULL,
	"comment_id" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "repo_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo" text NOT NULL,
	"rule_type" text NOT NULL,
	"pattern_id" uuid,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"glob" text,
	"status" text NOT NULL,
	"confidence" numeric,
	"evidence_count" integer DEFAULT 0,
	"positive_count" integer DEFAULT 0,
	"negative_count" integer DEFAULT 0,
	"first_observed_at" timestamp with time zone,
	"last_observed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"deactivated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo" text NOT NULL,
	"pr_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"status" text NOT NULL,
	"model" text,
	"prompt_version" text,
	"rules_version" text,
	"retrieval_version" text,
	"mode" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "rule_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid,
	"finding_id" uuid,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"event_key" text NOT NULL,
	"delivery_id" text,
	"validated" boolean NOT NULL,
	"processed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "finding_outcomes" ADD CONSTRAINT "finding_outcomes_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_pattern_id_patterns_id_fk" FOREIGN KEY ("pattern_id") REFERENCES "public"."patterns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posted_comments" ADD CONSTRAINT "posted_comments_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_rules" ADD CONSTRAINT "repo_rules_pattern_id_patterns_id_fk" FOREIGN KEY ("pattern_id") REFERENCES "public"."patterns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_evidence" ADD CONSTRAINT "rule_evidence_rule_id_repo_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."repo_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_evidence" ADD CONSTRAINT "rule_evidence_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "findings_unique" ON "findings" USING btree ("repo","pr_id","commit_sha","file_path","line_start","line_end","message");--> statement-breakpoint
CREATE INDEX "learning_events_repo_created_at_idx" ON "learning_events" USING btree ("repo","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "posted_comments_unique" ON "posted_comments" USING btree ("platform","comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_rules_unique" ON "repo_rules" USING btree ("repo","rule_type","pattern_id");