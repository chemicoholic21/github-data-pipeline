import { eq } from 'drizzle-orm';
import { db } from '../db/dbClient.js';
import { tokenRateLimit } from '../db/schema.js';

export interface TokenInfo {
  token: string;
  index: number;
  remaining: number;
  resetTime: number;
}

export async function markTokenExhausted(index: number, resetTime: number = 0) {
  const now = Math.floor(Date.now() / 1000);
  const actualResetTime = resetTime > now ? resetTime : now + 3600;

  await db
    .insert(tokenRateLimit)
    .values({
      tokenIndex: index,
      remaining: 0,
      resetTime: actualResetTime,
      lastUpdated: new Date(),
    })
    .onConflictDoUpdate({
      target: tokenRateLimit.tokenIndex,
      set: {
        remaining: 0,
        resetTime: actualResetTime,
        lastUpdated: new Date(),
      },
    });
}

export async function getBestToken(): Promise<TokenInfo> {
  const tokens = (await import('../utils/config.js')).config.githubTokens;
  if (tokens.length === 0) {
    throw new Error('No GitHub tokens found in environment variables.');
  }

  const now = Math.floor(Date.now() / 1000);
  let bestTokenInfo: TokenInfo | null = null;
  let highestRemaining = -1;

  for (let i = 0; i < tokens.length; i++) {
    const rows = await db
      .select()
      .from(tokenRateLimit)
      .where(eq(tokenRateLimit.tokenIndex, i))
      .limit(1);

    let remaining = 5000;
    let resetTime = 0;

    if (rows.length > 0) {
      const row = rows[0]!;
      remaining = row.remaining;
      resetTime = row.resetTime;

      if (resetTime > 0 && resetTime < now) {
        remaining = 5000;
        resetTime = 0;
      }
    }

    if (remaining > highestRemaining) {
      highestRemaining = remaining;
      bestTokenInfo = { token: tokens[i]!, index: i, remaining, resetTime };
    }
  }

  if (!bestTokenInfo || highestRemaining <= 0) {
    throw new Error('rate-limited-all-tokens');
  }

  return bestTokenInfo;
}

export async function updateTokenRateLimit(index: number, remaining: number, resetTime: number) {
  const ttl = Math.max(60, resetTime - Math.floor(Date.now() / 1000) + 60);

  await db
    .insert(tokenRateLimit)
    .values({
      tokenIndex: index,
      remaining,
      resetTime,
      lastUpdated: new Date(),
    })
    .onConflictDoUpdate({
      target: tokenRateLimit.tokenIndex,
      set: {
        remaining,
        resetTime,
        lastUpdated: new Date(),
      },
    });
}
