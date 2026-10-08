CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answers_question_id_unique" UNIQUE("question_id")
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "questions_status_valid" CHECK ("questions"."status" IN ('queued', 'assigned', 'answered', 'expired')),
	CONSTRAINT "questions_answered_at_matches_status" CHECK (("questions"."status" = 'answered') = ("questions"."answered_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "questions_queue_idx" ON "questions" USING btree ("created_at") WHERE "questions"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "questions_expiry_idx" ON "questions" USING btree ("expires_at") WHERE "questions"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "questions_author_created_idx" ON "questions" USING btree ("author_id","created_at");