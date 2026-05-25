# GitHub Data Pipeline

A headless TypeScript pipeline that discovers GitHub developers, scores their open-source contributions, and stores ranked profiles in PostgreSQL — built for leaderboards and talent discovery.

---

## How it works

Discovery → Scrape → Score → Analyze, in four stages:

1. **Discover** — Finds GitHub users by location and follower range via the Search API
2. **Scrape** — Fetches repos, languages, topics, and merged PRs via GraphQL
3. **Score** — Computes `score = stars × (userPRs / totalPRs)` per repo, then sums to a total
4. **Analyze** — Categorizes each user across five skill areas: AI, Backend, Frontend, DevOps, Data

All GraphQL responses are cached in PostgreSQL (SHA-256 keyed, 30-day TTL). Multiple GitHub tokens are rotated automatically based on remaining quota.

---

## Setup

**Prerequisites:** Node.js 20+, pnpm, PostgreSQL

```bash
git clone https://github.com/chemicoholic21/github-data-pipeline.git
cd github-data-pipeline
pnpm install
cp .env.example .env   # add DATABASE_URL and GitHub tokens
pnpm db:push
```

**Run the pipeline:**

```bash
pnpm bulk-discover "Chennai"
pnpm bulk-discover "San Francisco" 0 1   # with start index and page
```

---

## Overview

This pipeline:

- Discovers GitHub users by location and follower range using the GitHub Search API (`@octokit/rest`)
- **Stage 1 (SCRAPE):** Fetches deep profile data (repos, languages, topics, merged PRs) via the GitHub GraphQL API → `github_users`, `github_repos`, `github_pull_requests`
- **Stage 2 (COMPUTE):** Calculates per-repository scores using `score = stars × (userPRs / totalPRs)` → `user_repo_scores`
- **Stage 3 (AGGREGATE):** Sums all repo scores → `user_scores`, syncs to `leaderboard`
- **Stage 4 (ANALYZE):** Categorizes repos by topics/languages, computes skill scores across five categories (AI, Backend, Frontend, DevOps, Data) → `analyses`
- Caches all GitHub API responses in `api_cache` (SHA-256 keyed) to avoid redundant requests
- Manages a pool of multiple GitHub tokens, automatically rotating to the token with the highest remaining quota via `token_rate_limit`

---

## Running the Pipeline

> ⚠️ Scraping GitHub data takes a long time — hours for large regions. Always run inside a **tmux** session so it survives disconnects.
>
> ```bash
> tmux new -s pipeline        # start a named session
> # ... run your command ...
> # Ctrl+B, D to detach       # safely disconnect
> tmux attach -t pipeline     # reattach later
> ```

---

## Scripts

### 1. Scrape a region from GitHub (makes API calls)

Discovers developers by location, fetches their repos and PRs, scores them, and writes everything to the database.

```bash
# Single region
pnpm bulk-discover "Bengaluru"

# Multiple regions in one run
pnpm bulk-discover "Bengaluru, San Francisco, London, Berlin, Mumbai, Beijing"

# Resume from a specific range index and page (useful after a crash or rate limit)
pnpm bulk-discover "Bengaluru, San Francisco" 0 5   # start at range 0, page 5
pnpm bulk-discover "Bengaluru, San Francisco" 2 1   # start at range 2, page 1
```

---

### 2. Populate leaderboard from cached data (no API calls)

If you've already scraped data and just need to (re)populate the leaderboard — use this. Reads entirely from `api_cache`, no GitHub calls made.

```bash
# Populate everything from cache
npx tsx src/scripts/populate-leaderboard-from-cache.ts

# Only process users not yet in the leaderboard (safest for large caches)
npx tsx src/scripts/populate-leaderboard-from-cache.ts --only-missing

# Preview what would run without writing anything
npx tsx src/scripts/populate-leaderboard-from-cache.ts --dry-run --limit=10

# Process a single user
npx tsx src/scripts/populate-leaderboard-from-cache.ts --username=torvalds

# Resume from a specific offset
npx tsx src/scripts/populate-leaderboard-from-cache.ts --offset=1000 --limit=500
```

---

### 3. Bulk SQL scripts (fastest — runs inside PostgreSQL)

Use these to recompute scores or refresh the leaderboard after schema changes or bulk imports. Much faster than the TypeScript equivalents.

```bash
pnpm sql:populate-analyses       # recompute skill scores from repos + PRs  (~2 min for 72K users)
pnpm sql:populate-leaderboard    # sync scored users → leaderboard          (~30s for 72K users)
```

Run `populate-analyses` before `populate-leaderboard` if recomputing from scratch.

---

## Scoring

```
repo_score = stars × (user_merged_prs / total_merged_prs)
```

- Repos with fewer than 10 stars are excluded
- Score is capped at 10,000 per repo
- Total score is the sum across all qualifying repos

**Experience levels:**

| Score | Label |
|---|---|
| < 10 | Newcomer |
| 10–99 | Contributor |
| 100–499 | Active Contributor |
| 500–1,999 | Core Contributor |
| ≥ 2,000 | Open Source Leader |

---

## Database

Full schema in `schema.sql`. Tables:

| Status | Tables | Purpose |
|--------|--------|---------|
| **Current** | `github_users`, `github_repos`, `github_pull_requests`, `user_repo_scores`, `user_scores`, `skills`, `user_skill_scores` | Pipeline: scraped data, scores |
| **Current** | `leaderboard`, `api_cache` | Consolidated leaderboard, parsed cache |
| **Current** | `conversations`, `messages` | Chat system |
| **Current** | `token_rate_limit` | Infra: rate limit tracking |
| **Deprecated** | `users_old`, `analyses_old`, `leaderboard_old`, `api_cache_old` | Legacy tables - kept for backward compatibility |

> **Note:** The consolidated tables were previously named `leaderboard_v2` / `api_cache_v2`. They are now just `leaderboard` / `api_cache`. To apply the rename on an existing database, run `sql/rename-v2-to-primary.sql` in your SQL editor, then verify with `pnpm verify:rename`.
