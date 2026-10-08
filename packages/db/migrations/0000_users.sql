CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"google_sub" text,
	"telegram_id" bigint,
	"alias" text NOT NULL,
	"locale" text DEFAULT 'ru' NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"is_staff" boolean DEFAULT false NOT NULL,
	"receiving_enabled" boolean DEFAULT true NOT NULL,
	"bot_blocked_at" timestamp with time zone,
	"cooldown_until" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub"),
	CONSTRAINT "users_telegram_id_unique" UNIQUE("telegram_id"),
	CONSTRAINT "users_alias_unique" UNIQUE("alias"),
	CONSTRAINT "users_channel_valid" CHECK ("users"."channel" IN ('web', 'telegram')),
	CONSTRAINT "users_locale_valid" CHECK ("users"."locale" IN ('ru', 'en')),
	CONSTRAINT "users_identity_matches_channel" CHECK (("users"."channel" = 'web' AND "users"."telegram_id" IS NULL)
        OR ("users"."channel" = 'telegram' AND "users"."google_sub" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "users_cooldown_until_idx" ON "users" USING btree ("cooldown_until");