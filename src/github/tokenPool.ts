// src/github/tokenPool.ts
import { config } from '../utils/config.js';
import { redisConnection } from '../queue/queue.js';

export interface TokenInfo {
  token: string;
  index: number;
  remaining: number;
  resetTime: number; // Unix timestamp
}

const GITHUB_RATE_LIMIT_KEY_PREFIX = 'github:rate_limit';

export async function markTokenExhausted(index: number, resetTime: number = 0) {
  const redisKey = `${GITHUB_RATE_LIMIT_KEY_PREFIX}:${index}`;
  const now = Math.floor(Date.now() / 1000);
  // If no reset time provided, assume 1 hour from now as a safety measure
  const actualResetTime = resetTime > now ? resetTime : now + 3600;

  try {
    await redisConnection.set(
      redisKey,
      JSON.stringify({ remaining: 0, resetTime: actualResetTime }),
      'EX',
      actualResetTime - now + 60
    );
  } catch (error) {
    console.error(`Error marking token ${index} as exhausted:`, error);
  }
}

export async function getBestToken(): Promise<TokenInfo> {
  const tokens = config.githubTokens;
  if (tokens.length === 0) {
    throw new Error('No GitHub tokens found in environment variables.');
  }

  let bestTokenInfo: TokenInfo | null = null;
  let highestRemaining = -1;
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < tokens.length; i++) {
    const redisKey = `${GITHUB_RATE_LIMIT_KEY_PREFIX}:${i}`;
    const cachedData = await redisConnection.get(redisKey);

    let remaining = 5000;
    let resetTime = 0;

    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData);
        remaining = parsed.remaining;
        resetTime = parsed.resetTime;

        // Reset if resetTime has passed
        if (resetTime > 0 && resetTime < now) {
          remaining = 5000;
          resetTime = 0;
        }
      } catch (e) {
        console.error(`Error parsing rate limit for token ${i}:`, e);
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
  const redisKey = `${GITHUB_RATE_LIMIT_KEY_PREFIX}:${index}`;
  try {
    await redisConnection.set(
      redisKey,
      JSON.stringify({ remaining, resetTime }),
      'EX',
      Math.max(60, resetTime - Math.floor(Date.now() / 1000) + 60)
    );
  } catch (error) {
    console.error(`Error writing rate limit to Redis for token index ${index}:`, error);
  }
}
