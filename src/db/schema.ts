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
} from 'drizzle-orm/pg-core';

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

export const apiCache = pgTable(
  'api_cache',
  {
    cacheKey: text('cache_key').primaryKey(),
    response: jsonb('response').notNull(),
    cachedAt: timestamp('cached_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (table) => ({
    idxApiCacheExpiresAt: index('idx_api_cache_expires_at').on(table.expiresAt),
  })
);

export const tokenRateLimit = pgTable('token_rate_limit', {
  tokenIndex: integer('token_index').primaryKey(),
  remaining: integer('remaining').notNull().default(5000),
  resetTime: integer('reset_time').notNull().default(0),
  lastUpdated: timestamp('last_updated').notNull().defaultNow(),
});

export const analyses = pgTable('analyses', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  totalScore: real('total_score').notNull().default(0),
  aiScore: real('ai_score').notNull().default(0),
  backendScore: real('backend_score').notNull().default(0),
  frontendScore: real('frontend_score').notNull().default(0),
  devopsScore: real('devops_score').notNull().default(0),
  dataScore: real('data_score').notNull().default(0),
  uniqueSkillsJson: jsonb('unique_skills_json'),
  linkedin: text('linkedin'),
  topReposJson: jsonb('top_repos_json'),
  languagesJson: jsonb('languages_json'),
  contributionCount: integer('contribution_count').notNull().default(0),
  cachedAt: timestamp('cached_at').notNull().defaultNow(),
});

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
