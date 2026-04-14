CREATE TABLE "analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"total_score" real DEFAULT 0 NOT NULL,
	"ai_score" real DEFAULT 0 NOT NULL,
	"backend_score" real DEFAULT 0 NOT NULL,
	"frontend_score" real DEFAULT 0 NOT NULL,
	"devops_score" real DEFAULT 0 NOT NULL,
	"data_score" real DEFAULT 0 NOT NULL,
	"unique_skills_json" jsonb,
	"linkedin" text,
	"top_repos_json" jsonb,
	"languages_json" jsonb,
	"contribution_count" integer DEFAULT 0 NOT NULL,
	"cached_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"response" jsonb NOT NULL,
	"cached_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaderboard" (
	"username" text PRIMARY KEY NOT NULL,
	"name" text,
	"avatar_url" text,
	"url" text,
	"total_score" real DEFAULT 0 NOT NULL,
	"ai_score" real DEFAULT 0 NOT NULL,
	"backend_score" real DEFAULT 0 NOT NULL,
	"frontend_score" real DEFAULT 0 NOT NULL,
	"devops_score" real DEFAULT 0 NOT NULL,
	"data_score" real DEFAULT 0 NOT NULL,
	"unique_skills_json" jsonb,
	"company" text,
	"blog" text,
	"location" text,
	"email" text,
	"bio" text,
	"twitter_username" text,
	"linkedin" text,
	"hireable" boolean DEFAULT false NOT NULL,
	"is_open_to_work" boolean,
	"otw_scraped_at" timestamp,
	"created_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"repo_name" text NOT NULL,
	"full_name" text NOT NULL,
	"stars" integer DEFAULT 0 NOT NULL,
	"forks" integer DEFAULT 0 NOT NULL,
	"language" text,
	"description" text,
	"url" text,
	"pushed_at" timestamp,
	"is_fork" boolean DEFAULT false NOT NULL,
	"topics" jsonb,
	"languages" jsonb,
	"merged_pr_count" integer DEFAULT 0 NOT NULL,
	"merged_prs_by_user_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_rate_limit" (
	"token_index" integer PRIMARY KEY NOT NULL,
	"remaining" integer DEFAULT 5000 NOT NULL,
	"reset_time" integer DEFAULT 0 NOT NULL,
	"last_updated" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"username" text PRIMARY KEY NOT NULL,
	"avatar_url" text,
	"bio" text,
	"followers" integer DEFAULT 0 NOT NULL,
	"following" integer DEFAULT 0 NOT NULL,
	"public_repos" integer DEFAULT 0 NOT NULL,
	"score" real,
	"name" text,
	"company" text,
	"blog" text,
	"location" text,
	"email" text,
	"twitter_username" text,
	"linkedin" text,
	"hireable" boolean,
	"website_url" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	"last_fetched" timestamp DEFAULT now() NOT NULL,
	"raw_json" jsonb
);
--> statement-breakpoint
CREATE INDEX "idx_api_cache_expires_at" ON "api_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_repos_username" ON "repos" USING btree ("username");--> statement-breakpoint
CREATE INDEX "idx_repos_stars" ON "repos" USING btree ("stars");--> statement-breakpoint
CREATE INDEX "idx_repos_full_name" ON "repos" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "idx_users_last_fetched" ON "users" USING btree ("last_fetched");--> statement-breakpoint
CREATE INDEX "idx_users_score" ON "users" USING btree ("score");--> statement-breakpoint
CREATE INDEX "idx_users_followers" ON "users" USING btree ("followers");