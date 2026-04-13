// src/lib/cache.ts
import { redis } from './redis.js';

export const CACHE_TTL = {
  DEFAULT: 2592000, // 30 days
  SHORT: 300, // 5 minutes
};

export async function withCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds = CACHE_TTL.DEFAULT
): Promise<T> {
  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      // In our unified Redis interface, values are stored as JSON strings
      try {
        return JSON.parse(cached) as T;
      } catch {
        // Fallback for non-JSON strings
        return cached as unknown as T;
      }
    }
  } catch {
    // Redis read failed, fall through to fetcher
  }

  const data = await fetcher();

  try {
    await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
  } catch {
    // Redis write failed, continue without caching
  }

  return data;
}
