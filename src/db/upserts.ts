import { db } from './dbClient.js';
import type { User, Repository, PullRequest } from '../types/github.js';
import { githubUsers, githubRepos, githubPullRequests, userRepoScores } from './schema.js';
import { sql } from 'drizzle-orm';

/**
 * Upserts a GitHub user profile into the github_users table.
 */
export async function upsertGithubUser(user: User) {
  const values = {
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
    scrapedAt: new Date(),
  };

  return await db
    .insert(githubUsers)
    .values(values)
    .onConflictDoUpdate({
      target: githubUsers.username,
      set: values,
    });
}

/**
 * Upserts a GitHub repository into the github_repos table.
 */
export async function upsertGithubRepo(repo: Repository) {
  const values = {
    ownerLogin: repo.ownerLogin,
    repoName: repo.name, // Real DB uses just the name as PK
    description: null,
    primaryLanguage: repo.primaryLanguage,
    stars: repo.stargazerCount,
    forks: 0,
    watchers: 0,
    totalPrs: repo.mergedPrCount,
    isFork: repo.isFork,
    isArchived: false,
    topics: repo.topics,
    createdAt: null,
    pushedAt: repo.pushedAt ? new Date(repo.pushedAt) : null,
    scrapedAt: new Date(),
  };

  return await db
    .insert(githubRepos)
    .values(values)
    .onConflictDoUpdate({
      target: githubRepos.repoName,
      set: values,
    });
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
export async function upsertUserRepoScore(data: any) {
  return await db
    .insert(userRepoScores)
    .values(data)
    .onConflictDoUpdate({
      target: [userRepoScores.username, userRepoScores.repoName],
      set: data,
    });
}
