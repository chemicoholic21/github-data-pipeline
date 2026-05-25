-- PostgreSQL Schema for GitHub Data Pipeline
-- Migrated from Redis caching to PostgreSQL

-- Required for trigram (ILIKE) search indexes on the leaderboard
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Users table - caches GitHub user profile data
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    avatar_url TEXT,
    bio TEXT,
    followers INTEGER NOT NULL DEFAULT 0,
    following INTEGER NOT NULL DEFAULT 0,
    public_repos INTEGER NOT NULL DEFAULT 0,
    score REAL,
    name TEXT,
    company TEXT,
    blog TEXT,
    location TEXT,
    email TEXT,
    twitter_username TEXT,
    linkedin TEXT,
    hireable BOOLEAN,
    website_url TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    last_fetched TIMESTAMP NOT NULL DEFAULT NOW(),
    raw_json JSONB
);

CREATE INDEX IF NOT EXISTS idx_users_last_fetched ON users(last_fetched);
CREATE INDEX IF NOT EXISTS idx_users_score ON users(score);
CREATE INDEX IF NOT EXISTS idx_users_followers ON users(followers);

-- Repositories table - caches GitHub repository data for users
CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    stars INTEGER NOT NULL DEFAULT 0,
    forks INTEGER NOT NULL DEFAULT 0,
    language TEXT,
    description TEXT,
    url TEXT,
    pushed_at TIMESTAMP,
    is_fork BOOLEAN NOT NULL DEFAULT FALSE,
    topics JSONB,
    languages JSONB,
    merged_pr_count INTEGER NOT NULL DEFAULT 0,
    merged_prs_by_user_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_repos_username ON repos(username);
CREATE INDEX IF NOT EXISTS idx_repos_stars ON repos(stars);
CREATE INDEX IF NOT EXISTS idx_repos_full_name ON repos(full_name);

-- API cache table - caches GitHub API responses with parsed key components.
-- cache_key format: "github:graphql:<username>" -> type=github, subtype=graphql, ref=username
CREATE TABLE IF NOT EXISTS api_cache (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cache_type TEXT NOT NULL,                 -- e.g. "github"
    cache_subtype TEXT NOT NULL,              -- e.g. "graphql", "rest"
    cache_ref TEXT NOT NULL,                  -- e.g. username or repo name
    cache_key TEXT NOT NULL UNIQUE,           -- original full key
    response JSONB NOT NULL,
    cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_cache_cache_ref ON api_cache(cache_ref);
CREATE INDEX IF NOT EXISTS idx_api_cache_expires_at ON api_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_api_cache_type_ref ON api_cache(cache_type, cache_ref);

-- Token rate limit table - tracks GitHub token rate limits
CREATE TABLE IF NOT EXISTS token_rate_limit (
    token_index INTEGER PRIMARY KEY,
    remaining INTEGER NOT NULL DEFAULT 5000,
    reset_time INTEGER NOT NULL DEFAULT 0,
    last_updated TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Analyses table - existing table
CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    total_score REAL NOT NULL DEFAULT 0,
    ai_score REAL NOT NULL DEFAULT 0,
    backend_score REAL NOT NULL DEFAULT 0,
    frontend_score REAL NOT NULL DEFAULT 0,
    devops_score REAL NOT NULL DEFAULT 0,
    data_score REAL NOT NULL DEFAULT 0,
    unique_skills_json JSONB,
    linkedin TEXT,
    top_repos_json JSONB,
    languages_json JSONB,
    contribution_count INTEGER NOT NULL DEFAULT 0,
    cached_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Leaderboard table - consolidated, single-table profile + scores for fast queries.
-- Combines github_users (profile) + analyses (scores) + user_scores (efficiency) + OTW fields.
CREATE TABLE IF NOT EXISTS leaderboard (
    username TEXT PRIMARY KEY,
    name TEXT,
    avatar_url TEXT,
    bio TEXT,
    location TEXT,
    company TEXT,
    blog TEXT,
    url TEXT,
    email TEXT,
    twitter_username TEXT,
    linkedin TEXT,
    hireable BOOLEAN NOT NULL DEFAULT FALSE,
    followers INTEGER,
    following INTEGER,
    public_repos INTEGER,
    total_score REAL NOT NULL DEFAULT 0,
    ai_score REAL NOT NULL DEFAULT 0,
    backend_score REAL NOT NULL DEFAULT 0,
    frontend_score REAL NOT NULL DEFAULT 0,
    devops_score REAL NOT NULL DEFAULT 0,
    data_score REAL NOT NULL DEFAULT 0,
    contributor_efficiency REAL,
    is_open_to_work BOOLEAN,
    otw_error_code TEXT,
    otw_permanent_failure BOOLEAN DEFAULT FALSE,
    otw_scraped_at TIMESTAMP,
    unique_skills TEXT[],
    created_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Partial btree indexes for score-sorted listings (only rows with a positive score)
CREATE INDEX IF NOT EXISTS idx_leaderboard_total_score ON leaderboard(total_score DESC) WHERE total_score > 0;
CREATE INDEX IF NOT EXISTS idx_leaderboard_ai_score ON leaderboard(ai_score DESC) WHERE ai_score > 0;
CREATE INDEX IF NOT EXISTS idx_leaderboard_backend_score ON leaderboard(backend_score DESC) WHERE backend_score > 0;
CREATE INDEX IF NOT EXISTS idx_leaderboard_frontend_score ON leaderboard(frontend_score DESC) WHERE frontend_score > 0;
CREATE INDEX IF NOT EXISTS idx_leaderboard_is_open_to_work ON leaderboard(is_open_to_work) WHERE is_open_to_work = TRUE;
-- Trigram indexes for fuzzy name/username search
CREATE INDEX IF NOT EXISTS idx_leaderboard_name_trgm ON leaderboard USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_leaderboard_username_trgm ON leaderboard USING GIN (username gin_trgm_ops);
-- GIN index for skill-tag filtering
CREATE INDEX IF NOT EXISTS idx_leaderboard_unique_skills_gin ON leaderboard USING GIN (unique_skills) WHERE unique_skills IS NOT NULL;