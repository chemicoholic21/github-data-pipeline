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

  console.log(`[TokenPool] Marking token ${index} as exhausted, resetTime=${actualResetTime}`);

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

/**
 * Pick the token with the most remaining quota.
 *
 * @param allowedIndices Optional explicit partition of token indices to choose
 *   from. When omitted, falls back to the process-wide `config.tokenIndices`
 *   (set via GITHUB_TOKEN_INDICES); when that is also null, all tokens are
 *   considered. This is how concurrent workers dedicate disjoint PAT subsets so
 *   they don't drain a shared budget.
 */
export async function getBestToken(allowedIndices?: number[]): Promise<TokenInfo> {
  const cfg = (await import('../utils/config.js')).config;
  const tokens = cfg.githubTokens;
  if (tokens.length === 0) {
    throw new Error('No GitHub tokens found in environment variables.');
  }

  // Resolve the partition: explicit arg > process config > all tokens.
  const partition = allowedIndices ?? cfg.tokenIndices ?? null;
  const candidateIndices = (
    partition && partition.length > 0 ? partition : tokens.map((_, i) => i)
  ).filter((i) => i >= 0 && i < tokens.length);

  if (candidateIndices.length === 0) {
    throw new Error('No GitHub tokens available in the configured partition.');
  }

  const now = Math.floor(Date.now() / 1000);
  let bestTokenInfo: TokenInfo | null = null;
  let highestRemaining = -1;

  console.log(
    `[TokenPool] Checking ${candidateIndices.length}/${tokens.length} tokens ` +
      `(partition=${partition ? `[${candidateIndices.join(',')}]` : 'all'}) at time ${now}`
  );

  try {
    for (const i of candidateIndices) {
      console.log(`[TokenPool] Processing token ${i}...`);

      let rows: (typeof tokenRateLimit.$inferSelect)[] = [];
      try {
        rows = await db
          .select()
          .from(tokenRateLimit)
          .where(eq(tokenRateLimit.tokenIndex, i))
          .limit(1);
      } catch (dbError) {
        console.error(`[TokenPool] DB error for token ${i}:`, dbError);
        // If DB fails, assume no record (default to 5000)
        rows = [];
      }

      console.log(`[TokenPool] Token ${i}: got ${rows.length} rows from DB`);

      let remaining = 5000;
      let resetTime = 0;

      if (rows.length > 0) {
        const row = rows[0]!;
        remaining = row.remaining;
        resetTime = row.resetTime;

        console.log(
          `[TokenPool] Token ${i}: DB has remaining=${remaining}, resetTime=${resetTime}`
        );

        if (resetTime > 0 && resetTime < now) {
          console.log(`[TokenPool] Token ${i} reset time passed, resetting...`);
          remaining = 5000;
          resetTime = 0;
        }
      } else {
        console.log(`[TokenPool] Token ${i}: no record found, defaulting to 5000`);
      }

      console.log(
        `[TokenPool] Token ${i}: final remaining=${remaining}, highestRemaining=${highestRemaining}`
      );

      if (remaining > highestRemaining) {
        highestRemaining = remaining;
        bestTokenInfo = { token: tokens[i]!, index: i, remaining, resetTime };
        console.log(`[TokenPool] Token ${i} is now best, highestRemaining=${highestRemaining}`);
      }
    }
  } catch (err) {
    console.error('[TokenPool] Error in getBestToken:', err);
    throw err;
  }

  console.log(
    `[TokenPool] Best token: index=${bestTokenInfo?.index}, remaining=${bestTokenInfo?.remaining}, highestRemaining=${highestRemaining}`
  );

  if (!bestTokenInfo || highestRemaining <= 0) {
    console.log('[TokenPool] Throwing rate-limited-all-tokens');
    throw new Error('rate-limited-all-tokens');
  }

  return bestTokenInfo!;
}

export async function updateTokenRateLimit(index: number, remaining: number, resetTime: number) {
  console.log(
    `[TokenPool] Updating token ${index}: remaining=${remaining}, resetTime=${resetTime}`
  );

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

export async function clearAllTokenLimits(): Promise<void> {
  console.log('[TokenPool] Clearing all token rate limits');
  await db.delete(tokenRateLimit);
}
