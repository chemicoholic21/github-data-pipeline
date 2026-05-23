import {
  pgTable,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  primaryKey,
  serial,
  unique,
} from 'drizzle-orm/pg-core';

// =============================================================================
// LEGACY TABLES - kept for backward compatibility, auto-synced during Stage 3
// =============================================================================

// Legacy user profiles - use github_users or leaderboard_v2 instead
export const users = pgTable(
  'users',
  {
    username: text('username').primaryKey(),
    avatarUrl: text('avatar_url'),
    bio: text('bio'),
    followers: integer('followers').notNull().default(0),
    following: integer('following').notNull().default(0),
    publicRepos: integer('public_repos').notNull().default(0),
    score: real('score'),
    name: text('name'),
    company: text('company'),
    blog: text('blog'),
    location: text('location'),
    email: text('email'),
    twitterUsername: text('twitter_username'),
    linkedin: text('linkedin'),
    hireable: boolean('hireable'),
    websiteUrl: text('website_url'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
    lastFetched: timestamp('last_fetched').notNull().defaultNow(),
    rawJson: jsonb('raw_json'),
  },
  (table) => ({
    idxUsersLastFetched: index('idx_users_last_fetched').on(table.lastFetched),
    idxUsersScore: index('idx_users_score').on(table.score),
    idxUsersFollowers: index('idx_users_followers').on(table.followers),
  })
);

// Legacy repos - use github_repos instead
export const repos = pgTable(
  'repos',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    repoName: text('repo_name').notNull(),
    fullName: text('full_name').notNull(),
    stars: integer('stars').notNull().default(0),
    forks: integer('forks').notNull().default(0),
    language: text('language'),
    description: text('description'),
    url: text('url'),
    pushedAt: timestamp('pushed_at'),
    isFork: boolean('is_fork').notNull().default(false),
    topics: jsonb('topics'),
    languages: jsonb('languages'),
    mergedPrCount: integer('merged_pr_count').notNull().default(0),
    mergedPrsByUserCount: integer('merged_prs_by_user_count').notNull().default(0),
  },
  (table) => ({
    idxReposUsername: index('idx_repos_username').on(table.username),
    idxReposStars: index('idx_repos_stars').on(table.stars),
    idxReposFullName: index('idx_repos_full_name').on(table.fullName),
  })
);

// =============================================================================
// INFRASTRUCTURE TABLES - caching and rate limiting
// =============================================================================

// GitHub API response cache - SHA-256 keyed, 30-day TTL
// Use api_cache_v2 for parsed/filterable cache access
export const apiCache = pgTable(
  'api_cache',
  {
    cacheKey: text('cache_key').primaryKey(), // SHA-256 hash of request
    response: jsonb('response').notNull(),    // Raw API response
    cachedAt: timestamp('cached_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (table) => ({
    idxApiCacheExpiresAt: index('idx_api_cache_expires_at').on(table.expiresAt),
  })
);

// Tracks rate limit state per GitHub token for automatic rotation
export const tokenRateLimit = pgTable('token_rate_limit', {
  tokenIndex: integer('token_index').primaryKey(), // Index in GITHUB_TOKENS array
  remaining: integer('remaining').notNull().default(5000), // Remaining API calls
  resetTime: integer('reset_time').notNull().default(0),   // Unix timestamp when limit resets
  lastUpdated: timestamp('last_updated').notNull().defaultNow(),
});

// =============================================================================
// PIPELINE TABLES - scoring and analysis (Stage 4)
// =============================================================================

// Skill breakdown per user - AI, Backend, Frontend, DevOps, Data scores
// Populated by sql/populate-analyses.sql from repos + PRs
export const analyses = pgTable('analyses', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  totalScore: real('total_score').notNull().default(0),
  aiScore: real('ai_score').notNull().default(0),
  backendScore: real('backend_score').notNull().default(0),
  frontendScore: real('frontend_score').notNull().default(0),
  devopsScore: real('devops_score').notNull().default(0),
  dataScore: real('data_score').notNull().default(0),
  uniqueSkillsJson: jsonb('unique_skills_json'), // Array of skill tags
  linkedin: text('linkedin'),
  topReposJson: jsonb('top_repos_json'),         // Top contributing repos
  languagesJson: jsonb('languages_json'),        // Language breakdown
  contributionCount: integer('contribution_count').notNull().default(0),
  cachedAt: timestamp('cached_at').notNull().defaultNow(),
});

// Public leaderboard - synced from analyses + github_users
// Use leaderboard_v2 for consolidated data with OTW fields
export const leaderboard = pgTable('leaderboard', {
  username: text('username').primaryKey(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  url: text('url'),
  totalScore: real('total_score').notNull().default(0),
  aiScore: real('ai_score').notNull().default(0),
  backendScore: real('backend_score').notNull().default(0),
  frontendScore: real('frontend_score').notNull().default(0),
  devopsScore: real('devops_score').notNull().default(0),
  dataScore: real('data_score').notNull().default(0),
  uniqueSkillsJson: jsonb('unique_skills_json'),
  company: text('company'),
  blog: text('blog'),
  location: text('location'),
  email: text('email'),
  bio: text('bio'),
  twitterUsername: text('twitter_username'),
  linkedin: text('linkedin'),
  hireable: boolean('hireable').notNull().default(false),
  isOpenToWork: boolean('is_open_to_work'),
  otwScrapedAt: timestamp('otw_scraped_at'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// =============================================================================
// PIPELINE TABLES - raw scraped data (Stages 1-3)
// =============================================================================

// Raw GitHub user profiles from GraphQL API
export const githubUsers = pgTable('github_users', {
  username: text('username').primaryKey(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  followers: integer('followers').notNull().default(0),
  following: integer('following').notNull().default(0),
  publicRepos: integer('public_repos').notNull().default(0),
  blog: text('blog'),
  location: text('location'),
  email: text('email'),
  twitterUsername: text('twitter_username'),
  company: text('company'),
  hireable: boolean('hireable'),
  createdAt: timestamp('created_at'),  // GitHub account creation date
  scrapedAt: timestamp('scraped_at').notNull().defaultNow(),
});

// Repositories scraped from GitHub - one row per unique repo
// PK is repo_name (not owner/repo) - use fullName for unique lookup
export const githubRepos = pgTable('github_repos', {
  repoName: text('repo_name').primaryKey(),        // e.g. "react"
  ownerLogin: text('owner_login').notNull(),       // e.g. "facebook"
  fullName: text('full_name'),                     // e.g. "facebook/react" - unique indexed
  description: text('description'),
  primaryLanguage: text('primary_language'),       // Main language (e.g. "TypeScript")
  languages: text('languages').array(),            // All languages used
  stars: integer('stars').notNull().default(0),
  forks: integer('forks').notNull().default(0),
  watchers: integer('watchers').notNull().default(0),
  totalPrs: integer('total_prs').notNull().default(0), // Total merged PRs across all users
  isFork: boolean('is_fork').notNull().default(false),
  isArchived: boolean('is_archived').notNull().default(false),
  topics: text('topics').array(),                  // GitHub topics/tags
  createdAt: timestamp('created_at'),
  pushedAt: timestamp('pushed_at'),                // Last push date
  scrapedAt: timestamp('scraped_at').notNull().defaultNow(),
});

// Pull requests - tracks which users contributed to which repos
export const githubPullRequests = pgTable('github_pull_requests', {
  id: text('id').primaryKey(),                     // GitHub PR node ID
  username: text('username').notNull(),            // PR author
  repoName: text('repo_name').notNull(),
  fullName: text('full_name'),                     // "owner/repo" format
  state: text('state').notNull(),                  // OPEN, CLOSED, MERGED
  additions: integer('additions'),
  deletions: integer('deletions'),
  mergedAt: timestamp('merged_at'),
  createdAt: timestamp('created_at'),
});

// Per-repo scores for each user: score = stars × (userPRs / totalPRs)
export const userRepoScores = pgTable('user_repo_scores', {
  id: serial('id').primaryKey(),
  username: text('username').notNull(),
  repoName: text('repo_name').notNull(),
  userPrs: integer('user_prs').notNull().default(0),   // User's merged PRs
  totalPrs: integer('total_prs').notNull().default(0), // Repo's total merged PRs
  stars: integer('stars').notNull().default(0),
  repoScore: real('repo_score').notNull().default(0),  // Computed score
  computedAt: timestamp('computed_at').notNull().defaultNow(),
}, (table) => ({
  unq: unique('user_repo_scores_username_repo_name_key').on(table.username, table.repoName),
}));

// Aggregated total score per user (sum of all repo scores)
export const userScores = pgTable('user_scores', {
  username: text('username').primaryKey(),
  totalScore: real('total_score').notNull().default(0),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// =============================================================================
// SKILLS TABLES - skill taxonomy and per-user skill scores
// =============================================================================

// Skill definitions - maps languages/topics/keywords to skill categories
// 28 skills total (languages, frameworks, tools)
export const skills = pgTable('skills', {
  slug: text('slug').primaryKey(),                 // e.g. "typescript", "react"
  displayName: text('display_name').notNull(),     // e.g. "TypeScript", "React"
  category: text('category').notNull(),            // e.g. "language", "framework", "tool"
  matchLanguages: text('match_languages').array().notNull(), // GitHub languages that match
  matchTopics: text('match_topics').array().notNull(),       // GitHub topics that match
  matchKeywords: text('match_keywords').array().notNull(),   // Keywords to match
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Per-user skill scores - computed from repos/PRs matching each skill
export const userSkillScores = pgTable('user_skill_scores', {
  username: text('username').notNull(),
  skillSlug: text('skill_slug').notNull(),         // FK to skills.slug
  score: real('score').notNull(),                  // Computed skill score
  repoCount: integer('repo_count').notNull(),      // Number of repos with this skill
  topReposJson: jsonb('top_repos_json'),           // Top repos for this skill
  computedAt: timestamp('computed_at').notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.username, table.skillSlug] }),
  idxSkill: index('idx_uss_skill').on(table.skillSlug),
  idxScore: index('idx_uss_score').on(table.score),
  idxUsername: index('idx_uss_username').on(table.username),
  idxSkillScore: index('idx_uss_skill_score').on(table.skillSlug, table.score),
}));

// =============================================================================
// V2 TABLES - consolidated/optimized versions from v4b migration
// =============================================================================

// Consolidated leaderboard - single table with all user data for fast queries
// Combines: github_users (profile) + analyses (scores) + user_scores (efficiency) + OTW fields
// NOTE: Schema matches actual DB - use raw SQL in pipeline to avoid Drizzle issues
export const leaderboardV2 = pgTable('leaderboard_v2', {
  username: text('username').primaryKey(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  location: text('location'),
  company: text('company'),
  blog: text('blog'),
  url: text('url'),
  email: text('email'),
  twitterUsername: text('twitter_username'),
  linkedin: text('linkedin'),
  hireable: boolean('hireable').notNull().default(false),
  followers: integer('followers'),
  following: integer('following'),
  publicRepos: integer('public_repos'),
  totalScore: real('total_score').notNull().default(0),
  aiScore: real('ai_score').notNull().default(0),
  backendScore: real('backend_score').notNull().default(0),
  frontendScore: real('frontend_score').notNull().default(0),
  devopsScore: real('devops_score').notNull().default(0),
  dataScore: real('data_score').notNull().default(0),
  contributorEfficiency: real('contributor_efficiency'),
  isOpenToWork: boolean('is_open_to_work'),
  otwErrorCode: text('otw_error_code'),
  otwPermanentFailure: boolean('otw_permanent_failure').default(false),
  otwScrapedAt: timestamp('otw_scraped_at'),
  uniqueSkills: text('unique_skills').array(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Parsed API cache - same data as api_cache but with extracted fields for filtering
// cache_key format: "github:graphql:<username>" → type=github, subtype=graphql, ref=username
export const apiCacheV2 = pgTable('api_cache_v2', {
  id: serial('id').primaryKey(),
  cacheType: text('cache_type').notNull(),         // e.g. "github"
  cacheSubtype: text('cache_subtype').notNull(),   // e.g. "graphql", "rest"
  cacheRef: text('cache_ref').notNull(),           // e.g. username or repo name
  cacheKey: text('cache_key').notNull(),           // Original full key (unique)
  response: jsonb('response').notNull(),
  cachedAt: timestamp('cached_at'),
  expiresAt: timestamp('expires_at'),
});

// =============================================================================
// CHAT TABLES - direct messaging between users
// =============================================================================

// Conversations between two users
// Canonical ordering: user_a < user_b alphabetically (enforced by CHECK constraint)
export const conversations = pgTable('conversations', {
  id: serial('id').primaryKey(),
  userA: text('user_a').notNull(),                 // FK to github_users
  userB: text('user_b').notNull(),                 // FK to github_users
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(), // Updated on new message
});

// Individual messages within a conversation
export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  conversationId: integer('conversation_id').notNull(), // FK to conversations
  senderUsername: text('sender_username').notNull(),    // FK to github_users
  content: text('content').notNull(),                   // 1-10,000 chars
  sentAt: timestamp('sent_at').notNull().defaultNow(),
  readAt: timestamp('read_at'),                         // NULL = unread
  deletedAt: timestamp('deleted_at'),                   // Soft delete (NULL = active)
});
