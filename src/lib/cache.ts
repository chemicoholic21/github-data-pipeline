import { eq, lt, desc } from 'drizzle-orm';
import { db } from '../db/dbClient.js';
import { users, repos } from '../db/schema.js';
import type { UserAnalysis, Repository } from '../types/github.js';

const CACHE_STALE_TIME_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_THRESHOLD_MS = 60 * 24 * 60 * 60 * 1000;

const inFlightRequests = new Map<string, Promise<UserAnalysis>>();

export const cacheStats = {
  hits: 0,
  misses: 0,
};

function isFresh(lastFetched: Date | null): boolean {
  if (!lastFetched) return false;
  const now = new Date();
  const diff = now.getTime() - lastFetched.getTime();
  return diff < CACHE_STALE_TIME_MS;
}

export async function getCachedUser(username: string): Promise<UserAnalysis | null> {
  const normalizedUsername = username.toLowerCase();

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.username, normalizedUsername))
    .limit(1);

  if (userRows.length === 0) {
    return null;
  }

  const userRow = userRows[0]!;

  if (!isFresh(userRow.lastFetched)) {
    return null;
  }

  const repoRows = await db
    .select()
    .from(repos)
    .where(eq(repos.username, normalizedUsername))
    .orderBy(desc(repos.stars))
    .limit(100);

  const parsedRepos: Repository[] = repoRows.map((r) => ({
    name: r.repoName,
    ownerLogin: normalizedUsername,
    stargazerCount: r.stars,
    primaryLanguage: r.language,
    pushedAt: r.pushedAt?.toISOString() ?? null,
    isFork: r.isFork,
    mergedPrCount: r.mergedPrCount,
    mergedPrsByUserCount: r.mergedPrsByUserCount,
    topics: (r.topics ?? []) as string[],
    languages: (r.languages ?? []) as string[],
  }));

  const user = userRow;
  const languageBreakdown: Record<string, number> = {};
  parsedRepos.forEach((repo) => {
    if (repo.primaryLanguage) {
      languageBreakdown[repo.primaryLanguage] = (languageBreakdown[repo.primaryLanguage] || 0) + 1;
    }
  });

  const contributionCount = parsedRepos.reduce((sum, r) => sum + r.mergedPrsByUserCount, 0);

  const uniqueSkillsSet = new Set<string>();
  parsedRepos.forEach((repo) => {
    repo.languages?.forEach((l) => uniqueSkillsSet.add(l.toLowerCase()));
    repo.topics?.forEach((t) => uniqueSkillsSet.add(t.toLowerCase()));
  });
  const uniqueSkills = Array.from(uniqueSkillsSet);

  cacheStats.hits++;
  return {
    user: {
      login: user.username,
      name: user.name ?? undefined,
      avatarUrl: user.avatarUrl ?? undefined,
      url: user.blog ? `https://github.com/${user.username}` : undefined,
      company: user.company ?? undefined,
      blog: user.blog ?? undefined,
      location: user.location ?? undefined,
      email: user.email ?? undefined,
      bio: user.bio ?? undefined,
      twitterUsername: user.twitterUsername ?? undefined,
      linkedin: user.linkedin ?? undefined,
      isHireable: user.hireable ?? undefined,
      websiteUrl: user.websiteUrl ?? undefined,
      followers: user.followers,
      following: user.following,
      createdAt: user.createdAt?.toISOString() ?? '',
      updatedAt: user.updatedAt?.toISOString() ?? '',
    },
    repos: parsedRepos,
    languageBreakdown,
    contributionCount,
    uniqueSkills,
  };
}

export async function setCachedUser(username: string, analysis: UserAnalysis): Promise<void> {
  const normalizedUsername = username.toLowerCase();
  const now = new Date();

  const userData = {
    username: normalizedUsername,
    avatarUrl: analysis.user.avatarUrl ?? null,
    bio: analysis.user.bio ?? null,
    followers: analysis.user.followers,
    following: analysis.user.following,
    publicRepos: analysis.user.followers,
    name: analysis.user.name ?? null,
    company: analysis.user.company ?? null,
    blog: analysis.user.blog ?? null,
    location: analysis.user.location ?? null,
    email: analysis.user.email ?? null,
    twitterUsername: analysis.user.twitterUsername ?? null,
    linkedin: analysis.user.linkedin ?? null,
    hireable: analysis.user.isHireable ?? null,
    websiteUrl: analysis.user.websiteUrl ?? null,
    createdAt: analysis.user.createdAt ? new Date(analysis.user.createdAt) : null,
    updatedAt: analysis.user.updatedAt ? new Date(analysis.user.updatedAt) : null,
    lastFetched: now,
    rawJson: JSON.stringify(analysis),
  };

  await db.insert(users).values(userData).onConflictDoUpdate({
    target: users.username,
    set: userData,
  });

  await db.delete(repos).where(eq(repos.username, normalizedUsername));

  const repoInserts = analysis.repos.map((r) => ({
    id: `${r.ownerLogin}/${r.name}`,
    username: normalizedUsername,
    repoName: r.name,
    fullName: `${r.ownerLogin}/${r.name}`,
    stars: r.stargazerCount,
    forks: 0,
    language: r.primaryLanguage,
    description: null,
    url: `https://github.com/${r.ownerLogin}/${r.name}`,
    pushedAt: r.pushedAt ? new Date(r.pushedAt) : null,
    isFork: r.isFork,
    topics: r.topics,
    languages: r.languages,
    mergedPrCount: r.mergedPrCount,
    mergedPrsByUserCount: r.mergedPrsByUserCount,
  }));

  if (repoInserts.length > 0) {
    for (const repo of repoInserts) {
      await db.insert(repos).values(repo).onConflictDoUpdate({
        target: repos.id,
        set: repo,
      });
    }
  }
}

export async function getOrSetCache(
  username: string,
  fetcher: () => Promise<UserAnalysis>
): Promise<UserAnalysis> {
  const normalizedUsername = username.toLowerCase();

  const existingPromise = inFlightRequests.get(normalizedUsername);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = fetcher();
  inFlightRequests.set(normalizedUsername, promise);

  promise
    .then(() => {
      inFlightRequests.delete(normalizedUsername);
    })
    .catch(() => {
      inFlightRequests.delete(normalizedUsername);
    });

  return promise;
}

export async function cleanupStaleUsers(): Promise<number> {
  const threshold = new Date(Date.now() - CLEANUP_THRESHOLD_MS);

  await db.delete(users).where(lt(users.lastFetched, threshold));

  return 0;
}

export function getCacheStats() {
  return { ...cacheStats };
}

export function resetCacheStats() {
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}
