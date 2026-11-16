ALTER TABLE "collections" ADD COLUMN "api_key_hint" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "api_key_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "search_q" text;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "source_host" text;