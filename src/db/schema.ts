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

// --- NEW TABLES ALIGNED WITH ACTUAL DB STATE ---

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
  createdAt: timestamp('created_at'),
  scrapedAt: timestamp('scraped_at').notNull().defaultNow(),
});

export const githubRepos = pgTable('github_repos', {
  repoName: text('repo_name').primaryKey(), // Real DB PK is ONLY repo_name
  ownerLogin: text('owner_login').notNull(),
  description: text('description'),
  primaryLanguage: text('primary_language'),
  stars: integer('stars').notNull().default(0),
  forks: integer('forks').notNull().default(0),
  watchers: integer('watchers').notNull().default(0),
  totalPrs: integer('total_prs').notNull().default(0),
  isFork: boolean('is_fork').notNull().default(false),
  isArchived: boolean('is_archived').notNull().default(false),
  topics: text('topics').array(), 
  createdAt: timestamp('created_at'),
  pushedAt: timestamp('pushed_at'),
  scrapedAt: timestamp('scraped_at').notNull().defaultNow(),
});

export const githubPullRequests = pgTable('github_pull_requests', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  repoName: text('repo_name').notNull(),
  state: text('state').notNull(),
  additions: integer('additions'),
  deletions: integer('deletions'),
  mergedAt: timestamp('merged_at'),
  createdAt: timestamp('created_at'),
});

export const userRepoScores = pgTable('user_repo_scores', {
  id: serial('id').primaryKey(),
  username: text('username').notNull(),
  repoName: text('repo_name').notNull(),
  userPrs: integer('user_prs').notNull().default(0),
  totalPrs: integer('total_prs').notNull().default(0),
  stars: integer('stars').notNull().default(0),
  repoScore: real('repo_score').notNull().default(0),
  computedAt: timestamp('computed_at').notNull().defaultNow(),
}, (table) => ({
  unq: unique('user_repo_scores_username_repo_name_key').on(table.username, table.repoName),
}));

export const userScores = pgTable('user_scores', {
  username: text('username').primaryKey(),
  totalScore: real('total_score').notNull().default(0),
  aiScore: real('ai_score').notNull().default(0),
  backendScore: real('backend_score').notNull().default(0),
  frontendScore: real('frontend_score').notNull().default(0),
  devopsScore: real('devops_score').notNull().default(0),
  dataScore: real('data_score').notNull().default(0),
  contributionCount: integer('contribution_count').notNull().default(0),
  topReposJson: jsonb('top_repos_json'),
  languagesJson: jsonb('languages_json'),
  uniqueSkillsJson: jsonb('unique_skills_json'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
