import { db } from './dbClient.js';
import type { User, Repository, PullRequest } from '../types/github.js';
import type { RepoHealthMetrics, ContributionScore } from '../types/repoHealth.js';
import {
  githubUsers,
  githubRepos,
  githubPullRequests,
  userRepoScores,
  repoHealth,
} from './schema.js';
import { sql } from 'drizzle-orm';

/**
 * Upserts a GitHub user profile into the github_users table.
 */
export async function upsertGithubUser(user: User) {
  const insertValues = {
    username: user.login,
    name: user.name ?? null,
    avatarUrl: user.avatarUrl ?? null,
    bio: user.bio ?? null,
    followers: user.followers,
    following: user.following,
    publicRepos: 0,
    blog: user.blog ?? null,
    location: user.location ?? null,
    email: user.email ?? null,
    twitterUsername: user.twitterUsername ?? null,
    company: user.company ?? null,
    hireable: user.isHireable ?? null,
    createdAt: user.createdAt ? new Date(user.createdAt) : null,
    scrapedAt: new Date(0),
  };

  const updateValues = {
    username: user.login,
    name: user.name ?? null,
    avatarUrl: user.avatarUrl ?? null,
    bio: user.bio ?? null,
    followers: user.followers,
    following: user.following,
    publicRepos: 0,
    blog: user.blog ?? null,
    location: user.location ?? null,
    email: user.email ?? null,
    twitterUsername: user.twitterUsername ?? null,
    company: user.company ?? null,
    hireable: user.isHireable ?? null,
    createdAt: user.createdAt ? new Date(user.createdAt) : null,
  };

  return await db.insert(githubUsers).values(insertValues).onConflictDoUpdate({
    target: githubUsers.username,
    set: updateValues,
  });
}

/**
 * Upserts a GitHub repository into the github_repos table.
 * NOTE: Live DB uses repo_name as PK. full_name (owner/repo) is stored separately.
 */
export async function upsertGithubRepo(repo: Repository) {
  const fullName = `${repo.ownerLogin}/${repo.name}`; // Format: "owner/repo"
  const values = {
    repoName: repo.name, // This is the PK in live DB
    ownerLogin: repo.ownerLogin,
    fullName: fullName, // Unique indexed column "owner/repo"
    description: repo.description ?? null,
    primaryLanguage: repo.primaryLanguage,
    stars: repo.stargazerCount,
    forks: repo.forkCount ?? 0,
    watchers: 0,
    totalPrs: repo.mergedPrCount,
    isFork: repo.isFork,
    isArchived: false,
    topics: repo.topics,
    createdAt: repo.createdAt ? new Date(repo.createdAt) : null,
    pushedAt: repo.pushedAt ? new Date(repo.pushedAt) : null,
    scrapedAt: new Date(),
  };

  return await db.insert(githubRepos).values(values).onConflictDoUpdate({
    target: githubRepos.repoName, // PK is repo_name, not id
    set: values,
  });
}

/**
 * A repository candidate discovered directly from GitHub's repository search
 * (not via a user scrape). Only the public metadata the search API returns.
 */
export interface DiscoveredRepo {
  name: string;
  ownerLogin: string;
  description: string | null;
  primaryLanguage: string | null;
  stars: number;
  forks: number;
  isFork: boolean;
  isArchived: boolean;
  topics: string[];
  createdAt: string | null;
  pushedAt: string | null;
}

/**
 * Bulk-insert freshly discovered repositories into github_repos.
 *
 * Design notes:
 *  - github_repos' PRIMARY KEY is repo_name (not owner/repo), a pre-existing
 *    schema quirk. We therefore ON CONFLICT DO NOTHING so discovery only ADDS
 *    brand-new repo names and never clobbers an existing row (which could belong
 *    to a different owner, or already carry user-PR aggregation in total_prs).
 *  - Per-repo health (stars/pushedAt/activity) is refreshed separately by the
 *    compute-repo-health worker into the repo_health table, so we don't need to
 *    overwrite existing github_repos rows here.
 *  - Rows are de-duplicated by repo_name within the batch before insert.
 *
 * @returns the number of NEW rows actually inserted.
 */
export async function upsertDiscoveredRepos(repos: DiscoveredRepo[]): Promise<number> {
  if (repos.length === 0) return 0;

  // De-dupe by repo_name (the PK) so a single INSERT can't reference the same
  // key twice; keep the highest-starred candidate for each name.
  const byName = new Map<string, DiscoveredRepo>();
  for (const r of repos) {
    const existing = byName.get(r.name);
    if (!existing || r.stars > existing.stars) byName.set(r.name, r);
  }

  const values = Array.from(byName.values()).map((r) => ({
    repoName: r.name,
    ownerLogin: r.ownerLogin,
    fullName: `${r.ownerLogin}/${r.name}`,
    description: r.description ?? null,
    primaryLanguage: r.primaryLanguage,
    languages: r.primaryLanguage ? [r.primaryLanguage] : [],
    stars: r.stars,
    forks: r.forks,
    watchers: 0,
    totalPrs: 0,
    isFork: r.isFork,
    isArchived: r.isArchived,
    topics: r.topics,
    createdAt: r.createdAt ? new Date(r.createdAt) : null,
    pushedAt: r.pushedAt ? new Date(r.pushedAt) : null,
    scrapedAt: new Date(),
  }));

  const result = await db.insert(githubRepos).values(values).onConflictDoNothing({
    target: githubRepos.repoName,
  });

  // node-postgres exposes rowCount; fall back to 0 if the driver omits it.
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

/**
 * Inserts a list of pull requests into the github_pull_requests table.
 */
export async function insertPullRequests(prList: PullRequest[]) {
  if (prList.length === 0) return;

  const values = prList.map((pr) => ({
    id: pr.id,
    username: pr.authorLogin,
    repoName: pr.repoId, // Assumes this is the full name "owner/repo"
    state: 'MERGED',
    additions: 0,
    deletions: 0,
    mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null,
    createdAt: pr.createdAt ? new Date(pr.createdAt) : null,
  }));

  return await db
    .insert(githubPullRequests)
    .values(values)
    .onConflictDoUpdate({
      target: githubPullRequests.id,
      set: {
        state: 'MERGED',
        mergedAt: sql`EXCLUDED.merged_at`,
      },
    });
}

/**
 * Upserts repository scores for a user.
 */
export async function upsertUserRepoScore(data: typeof userRepoScores.$inferInsert) {
  return await db
    .insert(userRepoScores)
    .values(data)
    .onConflictDoUpdate({
      target: [userRepoScores.username, userRepoScores.repoName],
      set: data,
    });
}

/**
 * Upserts a repository's contribution-friendliness health metrics + score.
 */
export async function upsertRepoHealth(m: RepoHealthMetrics, s: ContributionScore) {
  const values = {
    fullName: m.fullName,
    ownerLogin: m.ownerLogin,
    repoName: m.repoName,
    primaryLanguage: m.primaryLanguage,
    stars: m.stars,
    isArchived: m.isArchived,
    isDisabled: m.isDisabled,
    pushedAt: m.pushedAt ? new Date(m.pushedAt) : null,
    lastReleaseAt: m.lastReleaseAt ? new Date(m.lastReleaseAt) : null,
    mergedPrCount: m.mergedPrCount,
    closedPrCount: m.closedPrCount,
    openPrCount: m.openPrCount,
    medianFirstReviewHours: m.medianFirstReviewHours,
    medianMergeHours: m.medianMergeHours,
    acceptanceRate: m.acceptanceRate,
    externalMergedRatio: m.externalMergedRatio,
    mergeVelocityPerMonth: m.mergeVelocityPerMonth,
    openIssuesCount: m.openIssuesCount,
    goodFirstIssues: m.goodFirstIssues,
    helpWantedIssues: m.helpWantedIssues,
    hasContributing: m.hasContributing,
    hasCodeOfConduct: m.hasCodeOfConduct,
    mentionableUsers: m.mentionableUsers,
    sampleSize: m.sampleSize,
    contributionScore: s.score,
    responsivenessScore: s.responsiveness,
    throughputScore: s.throughput,
    acceptanceScore: s.acceptance,
    newcomerScore: s.newcomer,
    livenessScore: s.liveness,
    confidence: s.confidence,
    gatedReason: s.gatedReason,
    scrapedAt: new Date(),
    scoredAt: new Date(),
  };

  return await db
    .insert(repoHealth)
    .values(values)
    .onConflictDoUpdate({ target: repoHealth.fullName, set: values });
}

export async function markGithubUserScraped(username: string) {
  return await db.execute(sql`
    UPDATE github_users
    SET scraped_at = NOW()
    WHERE username = ${username}
  `);
}
