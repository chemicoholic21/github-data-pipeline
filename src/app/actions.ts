// src/app/actions.ts
'use server';

import { sql as db } from '../lib/db.js';
import { leaderboard } from '../db/schema.js';
import { desc, gt, eq } from 'drizzle-orm';
import { withCache } from '../lib/apiCache.js';

interface MemberProfile {
  username: string;
  name: string | null;
  avatar_url: string | null;
  total_score: number;
  bio: string | null;
  location: string | null;
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
