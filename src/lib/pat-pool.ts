import { config } from '../utils/config';
import { redisConnection } from '../queue/queue';

interface TokenData {
  token: string;
  remaining: number;
  resetTime: number;
}

const RATE_LIMIT_KEY_PREFIX = 'github:rate_limit:';

let tokens: TokenData[] = config.githubTokens.map(token => ({
  token,
  remaining: 5000, // GitHub's default rate limit for authenticated requests
  resetTime: 0,
}));

let redisAvailable = true;

// Load token data from Redis on startup
async function loadTokensFromRedis() {
  if (!redisAvailable) return;
  try {
    for (const tokenData of tokens) {
      const key = `${RATE_LIMIT_KEY_PREFIX}${tokenData.token.slice(-8)}`; // Use last 8 chars as key
      const data = await redisConnection.get(key);
      if (data) {
        const parsed = JSON.parse(data);
        tokenData.remaining = parsed.remaining;
        tokenData.resetTime = parsed.resetTime;
      }
    }
  } catch (error) {
    console.warn('Redis not available for token persistence, using in-memory only');
    redisAvailable = false;
  }
}

// Save token data to Redis
async function saveTokenToRedis(tokenData: TokenData) {
  if (!redisAvailable) return;
  try {
    const key = `${RATE_LIMIT_KEY_PREFIX}${tokenData.token.slice(-8)}`;
    await redisConnection.setex(key, 3600, JSON.stringify({
      remaining: tokenData.remaining,
      resetTime: tokenData.resetTime,
    }));
  } catch (error) {
    redisAvailable = false;
  }
}

// Initialize
loadTokensFromRedis().catch(() => { redisAvailable = false; });

export async function getBestToken(): Promise<TokenData> {
  const now = Date.now() / 1000; // Unix timestamp in seconds

  // Reset tokens that have passed their reset time
  for (const token of tokens) {
    if (token.resetTime < now && token.resetTime > 0) {
      token.remaining = 5000;
      token.resetTime = 0;
      await saveTokenToRedis(token);
    }
  }

  // Find token with most remaining requests
  const bestToken = tokens.reduce((best, current) =>
    current.remaining > best.remaining ? current : best
  );

  if (bestToken.remaining <= 0) {
    throw new Error('rate-limited');
  }

  return bestToken;
}

export async function updateTokenUsage(token: string, remaining: number, resetTime: number) {
  const tokenData = tokens.find(t => t.token === token);
  if (tokenData) {
    tokenData.remaining = remaining;
    tokenData.resetTime = resetTime;
    await saveTokenToRedis(tokenData);
  }
}