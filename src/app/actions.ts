// src/app/actions.ts
'use server';

import { db } from '../db/dbClient.js';
import { leaderboard, repoIssues, repoHealth } from '../db/schema.js';
import { desc, gt, eq, and, sql } from 'drizzle-orm';
import { withCache } from '../lib/apiCache.js';

interface MemberProfile {
  username: string;
  name: string | null;
  avatar_url: string | null;
  total_score: number;
  bio: string | null;
  location: string | null;
}

interface RepoIssue {
  title: string;
  url: string;
  authorLogin: string | null;
  labels: string[];
  createdAt: string | null;
}

interface RepoWithIssueCount {
  fullName: string;
  ownerLogin: string;
  repoName: string;
  primaryLanguage: string | null;
  stars: number;
  contributionScore: number;
  goodFirstIssueCount: number;
  url: string;
}

export async function getTopReposByNewcomerFriendliness(limit = 20): Promise<RepoWithIssueCount[]> {
  return withCache(
    `repos:newcomer:${limit}`,
    async () => {
      const issueCounts = db
        .select({
          fullName: repoIssues.fullName,
          goodFirstIssueCount: sql<number>`COUNT(*)::int`.as('good_first_issue_count'),
        })
        .from(repoIssues)
        .where(eq(repoIssues.category, 'good_first_issue'))
        .groupBy(repoIssues.fullName);

      const results = await db
        .select({
          fullName: repoHealth.fullName,
          ownerLogin: repoHealth.ownerLogin,
          repoName: repoHealth.repoName,
          primaryLanguage: repoHealth.primaryLanguage,
          stars: repoHealth.stars,
          contributionScore: repoHealth.contributionScore,
          url: sql<string>`'https://github.com/' || ${repoHealth.fullName}`.as('url'),
          goodFirstIssueCount: sql<number>`COALESCE(ic.good_first_issue_count, 0)::int`.as('good_first_issue_count'),
        })
        .from(repoHealth)
        .leftJoin(
          issueCounts.as('ic'),
          eq(repoHealth.fullName, sql`ic.full_name`)
        )
        .orderBy(desc(sql`COALESCE(ic.good_first_issue_count, 0)`))
        .limit(limit);

      return results as RepoWithIssueCount[];
    },
    30
  );
}

export async function getTopMembers(limit = 10): Promise<MemberProfile[]> {
  return withCache(
    `leaderboard:top:${limit}`,
    async () => {
      const results = await db
        .select({
          username: leaderboard.username,
          name: leaderboard.name,
          avatar_url: leaderboard.avatarUrl,
          total_score: leaderboard.totalScore,
          bio: leaderboard.bio,
          location: leaderboard.location,
        })
        .from(leaderboard)
        .where(gt(leaderboard.totalScore, 0))
        .orderBy(desc(leaderboard.totalScore))
        .limit(limit);

      return results as MemberProfile[];
    },
    60
  );
}

export async function getMemberProfile(username: string): Promise<MemberProfile | null> {
  return withCache(
    `member:${username}`,
    async () => {
      const results = await db
        .select({
          username: leaderboard.username,
          name: leaderboard.name,
          avatar_url: leaderboard.avatarUrl,
          total_score: leaderboard.totalScore,
          bio: leaderboard.bio,
          location: leaderboard.location,
        })
        .from(leaderboard)
        .where(eq(leaderboard.username, username))
        .limit(1);

      return (results[0] as MemberProfile) ?? null;
    },
    30
  );
}

export async function getRepoIssues(fullName: string, category?: string): Promise<RepoIssue[]> {
  const cacheKey = category ? `repo:issues:${fullName}:${category}` : `repo:issues:${fullName}`;
  return withCache(
    cacheKey,
    async () => {
      const whereClause = category
        ? and(eq(repoIssues.fullName, fullName), eq(repoIssues.category, category))
        : eq(repoIssues.fullName, fullName);

      const results = await db
        .select({
          title: repoIssues.title,
          url: repoIssues.url,
          authorLogin: repoIssues.authorLogin,
          labels: repoIssues.labels,
          category: repoIssues.category,
          createdAt: repoIssues.createdAt,
        })
        .from(repoIssues)
        .where(whereClause)
        .orderBy(repoIssues.createdAt);

      return results as RepoIssue[];
    },
    30
  );
}
