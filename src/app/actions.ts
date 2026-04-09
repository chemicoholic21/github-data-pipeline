// src/app/actions.ts
'use server';

import { sql } from '../lib/db';
import { withCache } from '../lib/cache';

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
      const rows = await sql`
        SELECT username, name, avatar_url, total_score, bio, location
        FROM leaderboard
        WHERE total_score > 0
        ORDER BY total_score DESC
        LIMIT ${limit}
      `;
      return rows as MemberProfile[];
    },
    60
  );
}

export async function getMemberProfile(username: string): Promise<MemberProfile | null> {
  return withCache(
    `member:${username}`,
    async () => {
      const rows = await sql`
        SELECT username, name, avatar_url, total_score, bio, location
        FROM leaderboard
        WHERE username = ${username}
        LIMIT 1
      `;
      return (rows[0] as MemberProfile) ?? null;
    },
    30
  );
}
