-- Migration: repo_health table for contribution-friendliness scoring.
-- Safe to run repeatedly (IF NOT EXISTS). Mirrors src/db/schema.ts -> repoHealth.

CREATE TABLE IF NOT EXISTS repo_health (
    full_name                  TEXT PRIMARY KEY,          -- "owner/repo"
    owner_login                TEXT NOT NULL,
    repo_name                  TEXT NOT NULL,
    description                TEXT,                      -- GitHub "About" text
    primary_language           TEXT,
    stars                      INTEGER NOT NULL DEFAULT 0,
    forks                      INTEGER NOT NULL DEFAULT 0,

    -- Liveness / gates
    is_archived                BOOLEAN NOT NULL DEFAULT FALSE,
    is_disabled                BOOLEAN NOT NULL DEFAULT FALSE,
    created_at                 TIMESTAMP,                 -- when the repo was created
    pushed_at                  TIMESTAMP,
    last_release_at            TIMESTAMP,

    -- Throughput / acceptance (raw signals)
    merged_pr_count            INTEGER NOT NULL DEFAULT 0,
    closed_pr_count            INTEGER NOT NULL DEFAULT 0,
    open_pr_count              INTEGER NOT NULL DEFAULT 0,
    median_first_review_hours  REAL,
    median_merge_hours         REAL,
    acceptance_rate            REAL,
    external_merged_ratio      REAL,
    merge_velocity_per_month   REAL,

    -- Newcomer-friendliness
    open_issues_count          INTEGER NOT NULL DEFAULT 0,
    good_first_issues          INTEGER NOT NULL DEFAULT 0,
    help_wanted_issues         INTEGER NOT NULL DEFAULT 0,
    has_contributing           BOOLEAN NOT NULL DEFAULT FALSE,
    has_code_of_conduct        BOOLEAN NOT NULL DEFAULT FALSE,
    mentionable_users          INTEGER NOT NULL DEFAULT 0,
    sample_size                INTEGER NOT NULL DEFAULT 0,

    -- Computed scores
    contribution_score         REAL NOT NULL DEFAULT 0,   -- 0..100 combined
    responsiveness_score       REAL,
    throughput_score           REAL,
    acceptance_score           REAL,
    newcomer_score             REAL,
    liveness_score             REAL,
    confidence                 REAL NOT NULL DEFAULT 0,
    gated_reason               TEXT,

    scraped_at                 TIMESTAMP NOT NULL DEFAULT NOW(),
    scored_at                  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- For tables created before description/forks/created_at existed: add them
-- idempotently. Safe to run repeatedly. (CREATE TABLE IF NOT EXISTS above does
-- NOT alter an existing table, so these ALTERs are required for live upgrades.)
ALTER TABLE repo_health ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE repo_health ADD COLUMN IF NOT EXISTS forks       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repo_health ADD COLUMN IF NOT EXISTS created_at  TIMESTAMP;

-- Score-sorted listing (only meaningful, non-gated rows)
CREATE INDEX IF NOT EXISTS idx_repo_health_score
    ON repo_health(contribution_score DESC) WHERE contribution_score > 0;
CREATE INDEX IF NOT EXISTS idx_repo_health_stars ON repo_health(stars DESC);
CREATE INDEX IF NOT EXISTS idx_repo_health_lang  ON repo_health(primary_language);
