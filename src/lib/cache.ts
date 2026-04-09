// src/lib/cache.ts
import { redis } from './redis';

export async function withCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds = 30
): Promise<T> {
  try {
    const cached = await redis.get<T>(key);
    if (cached !== null) {
      return cached;
    }
  } catch {
    // Redis read failed, fall through to fetcher
  }

  const data = await fetcher();

  try {
    await redis.set(key, JSON.stringify(data), { ex: ttlSeconds });
  } catch {
    // Redis write failed, continue without caching
  }

  return data;
}
