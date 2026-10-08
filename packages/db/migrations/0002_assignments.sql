CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"receiver_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"reminded_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"outcome" text,
	CONSTRAINT "assignments_question_receiver_unique" UNIQUE("question_id","receiver_id"),
	CONSTRAINT "assignments_outcome_valid" CHECK ("assignments"."outcome" IN ('answered', 'timed_out', 'skipped', 'reported', 'undeliverable')),
	CONSTRAINT "assignments_ended_at_matches_outcome" CHECK (("assignments"."outcome" IS NULL) = ("assignments"."ended_at" IS NULL)),
	CONSTRAINT "assignments_deadline_after_assigned" CHECK ("assignments"."deadline_at" > "assignments"."assigned_at")
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_receiver_id_users_id_fk" FOREIGN KEY ("receiver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_one_active_per_receiver_idx" ON "assignments" USING btree ("receiver_id") WHERE "assignments"."outcome" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_one_active_per_question_idx" ON "assignments" USING btree ("question_id") WHERE "assignments"."outcome" IS NULL;--> statement-breakpoint
CREATE INDEX "assignments_deadline_idx" ON "assignments" USING btree ("deadline_at") WHERE "assignments"."outcome" IS NULL;