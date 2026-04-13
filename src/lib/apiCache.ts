import { eq, and, gt, lt } from 'drizzle-orm';
import { db } from '../db/dbClient.js';
import { apiCache } from '../db/schema.js';

const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function getCachedApiResponse(cacheKey: string): Promise<unknown | null> {
  const rows = await db
    .select()
    .from(apiCache)
    .where(and(eq(apiCache.cacheKey, cacheKey), gt(apiCache.expiresAt, new Date())))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  return rows[0]!.response;
}

export async function setCachedApiResponse(
  cacheKey: string,
  response: unknown,
  ttlMs: number = DEFAULT_CACHE_TTL_MS
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  await db
    .insert(apiCache)
    .values({
      cacheKey,
      response,
      cachedAt: now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: apiCache.cacheKey,
      set: {
        response,
        cachedAt: now,
        expiresAt,
      },
    });
}

export async function cleanupExpiredApiCache(): Promise<number> {
  const now = new Date();
  await db.delete(apiCache).where(lt(apiCache.expiresAt, now));

  return 0;
}

export async function withCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds: number = 60
): Promise<T> {
  const cached = await getCachedApiResponse(key);
  if (cached !== null) {
    return cached as T;
  }

  const data = await fetcher();
  await setCachedApiResponse(key, data, ttlSeconds * 1000);
  return data;
}
