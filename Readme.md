# GitHub Data Pipeline

A headless TypeScript data pipeline that ingests GitHub user data at scale, scores developers by their open-source contributions, and stores structured insights in PostgreSQL. Built for powering developer leaderboards, talent discovery tools, and community analytics.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Database Schema](#database-schema)
  - [users](#users)
  - [repos](#repos)
  - [analyses](#analyses)
  - [leaderboard](#leaderboard)
  - [api\_cache](#api_cache)
  - [token\_rate\_limit](#token_rate_limit)
- [Scoring System](#scoring-system)
- [Caching Strategy](#caching-strategy)
- [Token Pool](#token-pool)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Scripts](#scripts)
- [Environment Variables](#environment-variables)

---

## Overview

This pipeline:

1. Discovers GitHub users by location and follower range using the GitHub Search API (`@octokit/rest`)
2. Fetches deep profile data (repos, languages, topics, merged PRs) via the **GitHub GraphQL API**
3. Scores each developer across five skill categories: **AI**, **Backend**, **Frontend**, **DevOps**, and **Data**
4. Persists raw profiles, repository data, scored analyses, and a ranked leaderboard into **PostgreSQL**
5. Caches all GitHub API responses in the `api_cache` table to avoid redundant requests and rate limit consumption
6. Manages a pool of multiple GitHub tokens, automatically rotating to the token with the highest remaining quota

---

## Architecture

```
                         ┌──────────────────────┐
                         │   bulk-discover.ts   │  ← Entry point (CLI script)
                         │  location + follower │
                         │  range search loop   │
                         └──────────┬───────────┘
                                    │  GitHub Search API (Octokit REST)
                                    │  100 users/page, paginated
                                    ▼
                         ┌──────────────────────┐
                         │    Token Pool        │  ← Selects best token by remaining quota
                         │  (tokenPool.ts)      │  ← Tracks limits in `token_rate_limit` table
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │  GitHubGraphqlClient │  ← SHA-256 keyed cache lookup first
                         │  (graphqlClient.ts)  │  ← Hits `api_cache` before real API call
                         └──────────┬───────────┘
                                    │  GitHub GraphQL API
                                    │  (repos, languages, topics, merged PRs)
                                    ▼
                         ┌──────────────────────┐
                         │   fetchUserAnalysis  │  ← Assembles UserAnalysis object
                         │   (github.ts)        │  ← Deduplicates owned + contributed repos
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │   computeScore       │  ← score = stars × (userPRs / totalPRs)
                         │   (scoring.ts)       │  ← Categorises by language/topic keywords
                         └──────────┬───────────┘
                                    │
                          ┌─────────┴──────────┐
                          ▼                    ▼
               ┌────────────────┐   ┌────────────────────┐
               │  `analyses`    │   │   `leaderboard`    │
               │  (full scores) │   │  (display-ready)   │
               └────────────────┘   └────────────────────┘
                          │
               ┌──────────┴──────────┐
               ▼                     ▼
         ┌──────────┐         ┌──────────┐
         │  `users` │         │  `repos` │
         │ (profile)│         │ (per-user│
         └──────────┘         │   repos) │
                              └──────────┘
```

---

## Tech Stack

| Concern | Library |
|---|---|
| Language | TypeScript (ESM, Node.js) |
| Database ORM | Drizzle ORM |
| Database | PostgreSQL (Neon serverless compatible) |
| GitHub REST API | `@octokit/rest` |
| GitHub GraphQL API | `@octokit/graphql` + custom `axios` client |
| Job Queue (stub) | BullMQ (currently mocked, Redis removed) |
| Validation | Zod v4 |
| HTTP | Axios |
| Build | `tsc` / `tsx` |
| Package Manager | pnpm |

---
<img width="718" height="600" alt="image" src="https://github.com/user-attachments/assets/bc9283f9-f8c9-4086-b1e9-55e031378183" />


## Database Schema

The schema is defined in `src/db/schema.ts` using Drizzle ORM and mirrored as raw SQL in `schema.sql`. There are six tables.

---

### `users`

Caches the raw GitHub profile for each discovered developer. Acts as the persistent layer backing the in-memory user cache. Rows are refreshed after 30 days.

| Column | Type | Notes |
|---|---|---|
| `username` | `TEXT` **PK** | Lowercased GitHub login |
| `avatar_url` | `TEXT` | Profile picture URL |
| `bio` | `TEXT` | GitHub bio |
| `followers` | `INTEGER` | Follower count |
| `following` | `INTEGER` | Following count |
| `public_repos` | `INTEGER` | Number of public repos |
| `score` | `REAL` | Legacy score field |
| `name` | `TEXT` | Display name |
| `company` | `TEXT` | Company field |
| `blog` | `TEXT` | Website / blog URL |
| `location` | `TEXT` | Location string |
| `email` | `TEXT` | Public email |
| `twitter_username` | `TEXT` | Twitter handle |
| `linkedin` | `TEXT` | Extracted LinkedIn URL |
| `hireable` | `BOOLEAN` | GitHub "available for hire" flag |
| `website_url` | `TEXT` | Website URL |
| `created_at` | `TIMESTAMP` | GitHub account creation date |
| `updated_at` | `TIMESTAMP` | GitHub account last updated |
| `last_fetched` | `TIMESTAMP` **NOT NULL** | When this row was last hydrated |
| `raw_json` | `JSONB` | Full serialised `UserAnalysis` payload |

**Indexes:** `idx_users_last_fetched`, `idx_users_score`, `idx_users_followers`

---

### `repos`

Stores every repository associated with a user — both owned repos and repos the user has contributed to via merged PRs. Rows are deleted and re-inserted on each user refresh.

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` **PK** | `owner/repo` full name |
| `username` | `TEXT` **NOT NULL** | Owning user (FK to `users.username`) |
| `repo_name` | `TEXT` **NOT NULL** | Short repo name |
| `full_name` | `TEXT` **NOT NULL** | `owner/repo` |
| `stars` | `INTEGER` | Stargazer count |
| `forks` | `INTEGER` | Fork count |
| `language` | `TEXT` | Primary language |
| `description` | `TEXT` | Repo description |
| `url` | `TEXT` | GitHub URL |
| `pushed_at` | `TIMESTAMP` | Last push date |
| `is_fork` | `BOOLEAN` | Whether this is a fork |
| `topics` | `JSONB` | Array of topic strings |
| `languages` | `JSONB` | Array of all detected language names |
| `merged_pr_count` | `INTEGER` | Total merged PRs in this repo |
| `merged_prs_by_user_count` | `INTEGER` | Merged PRs authored by this user |

**Indexes:** `idx_repos_username`, `idx_repos_stars`, `idx_repos_full_name`

---

### `analyses`

Stores the computed score breakdown per user. One row per user, upserted on each pipeline run.

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` **PK** | Lowercased username |
| `username` | `TEXT` **NOT NULL** | GitHub login |
| `total_score` | `REAL` | Sum of all repo scores |
| `ai_score` | `REAL` | Score from AI/ML repos |
| `backend_score` | `REAL` | Score from backend repos |
| `frontend_score` | `REAL` | Score from frontend repos |
| `devops_score` | `REAL` | Score from DevOps repos |
| `data_score` | `REAL` | Score from data/analytics repos |
| `unique_skills_json` | `JSONB` | Top-10 skill strings by frequency |
| `linkedin` | `TEXT` | LinkedIn URL if found |
| `top_repos_json` | `JSONB` | Array of `TopRepositorySummary` objects |
| `languages_json` | `JSONB` | Language → count breakdown map |
| `contribution_count` | `INTEGER` | Total merged PRs by this user across all repos |
| `cached_at` | `TIMESTAMP` | When this analysis was computed |

---

### `leaderboard`

A denormalised, display-ready table for ranking developers. Contains all profile fields needed for a leaderboard UI without additional joins.

| Column | Type | Notes |
|---|---|---|
| `username` | `TEXT` **PK** | GitHub login |
| `name` | `TEXT` | Display name |
| `avatar_url` | `TEXT` | Profile picture URL |
| `url` | `TEXT` | GitHub profile URL |
| `total_score` | `REAL` | Overall contribution score |
| `ai_score` | `REAL` | AI/ML category score |
| `backend_score` | `REAL` | Backend category score |
| `frontend_score` | `REAL` | Frontend category score |
| `devops_score` | `REAL` | DevOps category score |
| `data_score` | `REAL` | Data category score |
| `unique_skills_json` | `JSONB` | Top skills array |
| `company` | `TEXT` | Company |
| `blog` | `TEXT` | Blog / website |
| `location` | `TEXT` | Location |
| `email` | `TEXT` | Public email |
| `bio` | `TEXT` | Bio |
| `twitter_username` | `TEXT` | Twitter handle |
| `linkedin` | `TEXT` | LinkedIn URL |
| `hireable` | `BOOLEAN` | Open to work (GitHub flag) |
| `is_open_to_work` | `BOOLEAN` | Open to work (scraped) |
| `otw_scraped_at` | `TIMESTAMP` | When `is_open_to_work` was last scraped |
| `created_at` | `TIMESTAMP` | GitHub account creation date |
| `updated_at` | `TIMESTAMP` **NOT NULL** | Row last updated |

---

### `api_cache`

Caches raw GitHub GraphQL API responses. Cache keys are SHA-256 hashes of the query + variables. Default TTL is 30 days.

| Column | Type | Notes |
|---|---|---|
| `cache_key` | `TEXT` **PK** | `github:graphql:<sha256>` |
| `response` | `JSONB` **NOT NULL** | Full API response payload |
| `cached_at` | `TIMESTAMP` **NOT NULL** | When the response was stored |
| `expires_at` | `TIMESTAMP` **NOT NULL** | Expiry — rows past this are stale |

**Index:** `idx_api_cache_expires_at`

---

### `token_rate_limit`

Tracks the GitHub API rate limit state for each token in the pool. The token pool reads this table to select the token with the most remaining quota before every API call.

| Column | Type | Notes |
|---|---|---|
| `token_index` | `INTEGER` **PK** | 0-based index into the tokens array |
| `remaining` | `INTEGER` | Requests remaining in current window |
| `reset_time` | `INTEGER` | Unix timestamp when the window resets |
| `last_updated` | `TIMESTAMP` **NOT NULL** | When this row was last written |

---

## Scoring System

Scores are computed in `src/lib/scoring.ts`. The formula rewards meaningful contributions to high-impact repositories.

**Per-repo score:**
```
score = stars × (userMergedPRs / totalMergedPRs)
```

- Repos with fewer than 10 stars are ignored (score = 0)
- Score is capped at 10,000 per repo
- A user's `total_score` is the sum of scores across all qualifying repos

**Experience levels** derived from `total_score`:

| Range | Label |
|---|---|
| < 10 | Newcomer |
| 10 – 99 | Contributor |
| 100 – 499 | Active Contributor |
| 500 – 1,999 | Core Contributor |
| ≥ 2,000 | Open Source Leader |

**Category classification** assigns each repo a skill category based on its topics first, then falls back to primary language:

| Category | Example topics / languages |
|---|---|
| AI | `machine-learning`, `pytorch`, `tensorflow`, Python, Julia |
| Backend | `api`, `microservices`, `graphql`, Java, Go, Rust, Ruby |
| Frontend | `react`, `vue`, `angular`, JavaScript, TypeScript |
| DevOps | `docker`, `kubernetes`, `terraform`, `github-actions`, Shell, HCL |
| Data | `data-science`, `analytics`, `pandas`, SQL, R |

A repo can belong to multiple categories simultaneously. Its score is added to each matching category.

---

## Caching Strategy

The pipeline uses a two-level cache, both backed by PostgreSQL:

**Level 1 — User cache (`users` + `repos` tables)**
- On each request, `getCachedUser()` checks if the user exists in `users` and whether `last_fetched` is within 30 days
- If fresh, repos are loaded from the `repos` table and a full `UserAnalysis` is reconstructed without hitting the GitHub API
- On write, `setCachedUser()` upserts the `users` row and replaces all `repos` rows for that user

**Level 2 — API response cache (`api_cache` table)**
- Every GitHub GraphQL request is keyed by `SHA-256(query + variables)`
- Cache key format: `github:graphql:<hash>`
- Before any network call, `getCachedApiResponse()` checks `api_cache` for a non-expired row
- On a cache miss, the response is stored via `setCachedApiResponse()` with a 30-day TTL
- Expired rows can be purged with `cleanupExpiredApiCache()`

An in-flight deduplication map (`inFlightRequests`) prevents concurrent identical fetches from triggering multiple API calls for the same username.

---

## Token Pool

Defined in `src/github/tokenPool.ts`. Supports up to 5 GitHub personal access tokens (or more via `GITHUB_TOKENS`).

**`getBestToken()`** selects the token with the highest `remaining` quota by reading the `token_rate_limit` table. If a token's `reset_time` is in the past, its quota is optimistically reset to 5,000.

**`updateTokenRateLimit()`** writes the `x-ratelimit-remaining` and `x-ratelimit-reset` response headers back to the table after every API call.

**`markTokenExhausted()`** sets `remaining = 0` for a token when a 403 rate-limit response is received, forcing the pool to skip it until its reset window expires.

If all tokens are exhausted, `getBestToken()` throws `rate-limited-all-tokens` and the bulk discover script waits 60 seconds before retrying.

---

## Project Structure

```
github-data-pipeline/
├── src/
│   ├── app/
│   │   └── actions.ts          # Server actions: getTopMembers, getMemberProfile
│   ├── db/
│   │   ├── dbClient.ts         # Drizzle + pg connection
│   │   └── schema.ts           # All table definitions (source of truth)
│   ├── github/
│   │   ├── graphqlClient.ts    # Axios-based GraphQL client with caching + token rotation
│   │   └── tokenPool.ts        # Multi-token rate limit manager
│   ├── lib/
│   │   ├── apiCache.ts         # api_cache table read/write helpers
│   │   ├── cache.ts            # User/repo cache (users + repos tables)
│   │   ├── db.ts               # Re-exports db client for app layer
│   │   ├── github.ts           # fetchUserAnalysis — main data fetching orchestrator
│   │   └── scoring.ts          # computeScore, deriveExperienceLevel
│   ├── queue/
│   │   └── queue.ts            # BullMQ queue stub (currently mocked)
│   ├── scripts/
│   │   ├── bulk-discover.ts    # Main pipeline entry — location-based user discovery
│   │   ├── clear-token-limits.ts  # Utility to reset token_rate_limit table
│   │   └── enrich-linkedin-apify.ts  # LinkedIn enrichment via Apify
│   ├── types/
│   │   └── github.ts           # User, Repository, UserAnalysis interfaces
│   ├── utils/
│   │   └── config.ts           # Zod-validated env config, token collection
│   └── cli.ts                  # Basic CLI entry point
├── drizzle/
│   ├── 0000_typical_human_robot.sql  # Initial migration
│   └── meta/                   # Drizzle migration metadata
├── schema.sql                  # Raw SQL schema (mirrors Drizzle schema)
├── drizzle.config.ts           # Drizzle Kit config
├── package.json
├── tsconfig.json
└── .env.example
```

---

## Getting Started

**Prerequisites:** Node.js 20+, pnpm, a PostgreSQL database (local or [Neon](https://neon.tech))

**1. Clone and install**
```bash
git clone https://github.com/chemicoholic21/github-data-pipeline.git
cd github-data-pipeline
pnpm install
```

**2. Configure environment**
```bash
cp .env.example .env
# Edit .env with your DATABASE_URL and GitHub tokens
```

**3. Push the schema**
```bash
pnpm db:push
```

Or apply the raw SQL directly:
```bash
psql $DATABASE_URL -f schema.sql
```

**4. Run the pipeline**
```bash
# Discover developers in a city (e.g. Chennai)
pnpm bulk-discover Chennai

# With optional start range index and start page
pnpm bulk-discover "San Francisco" 0 1
```

---

## Scripts

| Script | Command | Description |
|---|---|---|
| Dev server | `pnpm dev` | Runs `src/cli.ts` with hot reload via `tsx` |
| Build | `pnpm build` | Compiles TypeScript to `dist/` |
| Start | `pnpm start` | Runs compiled `dist/cli.js` |
| Bulk discover | `pnpm bulk-discover <location>` | Main pipeline — discovers and scores users by location |
| DB push | `pnpm db:push` | Pushes Drizzle schema to the database |
| LinkedIn enrich | `pnpm enrich-linkedin` | Enriches leaderboard rows with LinkedIn data via Apify |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `GITHUB_TOKENS` | ✅* | Comma-separated list of GitHub PATs |
| `GITHUB_TOKEN_1` … `GITHUB_TOKEN_5` | ✅* | Individual token slots (alternative to `GITHUB_TOKENS`) |
| `NODE_ENV` | — | `development` / `production` / `test` (default: `development`) |
| `REDIS_URL` | — | Redis URL for BullMQ (currently unused — queue is mocked) |
| `UPSTASH_REDIS_REST_URL` | — | Upstash REST URL (optional fallback) |
| `UPSTASH_REDIS_REST_TOKEN` | — | Upstash REST token (optional fallback) |

\* At least one GitHub token is required. Multiple tokens are strongly recommended to maximise throughput.
