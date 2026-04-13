-- PostgreSQL Schema for GitHub Data Pipeline
-- Migrated from Redis caching to PostgreSQL

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

-- API cache table - caches GitHub API responses
CREATE TABLE IF NOT EXISTS api_cache (
    cache_key TEXT PRIMARY KEY,
    response JSONB NOT NULL,
    cached_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_cache_expires_at ON api_cache(expires_at);

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

-- Leaderboard table - existing table
CREATE TABLE IF NOT EXISTS leaderboard (
    username TEXT PRIMARY KEY,
    name TEXT,
    avatar_url TEXT,
    url TEXT,
    total_score REAL NOT NULL DEFAULT 0,
    ai_score REAL NOT NULL DEFAULT 0,
    backend_score REAL NOT NULL DEFAULT 0,
    frontend_score REAL NOT NULL DEFAULT 0,
    devops_score REAL NOT NULL DEFAULT 0,
    data_score REAL NOT NULL DEFAULT 0,
    unique_skills_json JSONB,
    company TEXT,
    blog TEXT,
    location TEXT,
    email TEXT,
    bio TEXT,
    twitter_username TEXT,
    linkedin TEXT,
    hireable BOOLEAN NOT NULL DEFAULT FALSE,
    is_open_to_work BOOLEAN,
    otw_scraped_at TIMESTAMP,
    created_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);