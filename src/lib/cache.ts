import { eq } from 'drizzle-orm';
import { db } from '../db/dbClient.js';
import { githubUsers } from '../db/schema.js';
import type { UserAnalysis } from '../types/github.js';

const CACHE_STALE_TIME_MS = 30 * 24 * 60 * 60 * 1000;

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

  try {
    const userRows = await db
      .select()
      .from(githubUsers)
      .where(eq(githubUsers.username, normalizedUsername))
      .limit(1);

    if (userRows.length === 0) {
      return null;
    }

    const userRow = userRows[0]!;

    if (!isFresh(userRow.scrapedAt)) {
      return null;
    }

    // For now, just return a simple cached indicator
    // Full repo analysis would require joining githubRepos by ownerLogin
    cacheStats.hits++;
    return {
      user: {
        login: userRow.username,
        name: userRow.name ?? undefined,
        avatarUrl: userRow.avatarUrl ?? undefined,
        url: `https://github.com/${userRow.username}`,
        company: userRow.company ?? undefined,
        blog: userRow.blog ?? undefined,
        location: userRow.location ?? undefined,
        email: userRow.email ?? undefined,
        bio: userRow.bio ?? undefined,
        twitterUsername: userRow.twitterUsername ?? undefined,
        linkedin: undefined,
        isHireable: userRow.hireable ?? undefined,
        websiteUrl: userRow.blog ?? undefined,
        followers: userRow.followers,
        following: userRow.following,
        createdAt: userRow.createdAt?.toISOString() ?? '',
        updatedAt: new Date().toISOString(),
      },
      repos: [],
      languageBreakdown: {},
      contributionCount: 0,
      uniqueSkills: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[CACHE] Error reading cached user ${username}: ${message}`);
    return null;
  }
}
