import { eq, and, gt, lt, sql } from 'drizzle-orm';
import { db } from '../db/dbClient.js';
import { apiCacheOld, apiCacheV2 } from '../db/schema.js';

const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Parse a cache key into type, subtype, and ref components.
 * Expected formats:
 *   - "github:graphql:<username>" → { type: "github", subtype: "graphql", ref: "<username>" }
 *   - "github:rest:users:<username>" → { type: "github", subtype: "rest", ref: "users:<username>" }
 *   - Any other format → { type: "unknown", subtype: "unknown", ref: cacheKey }
 */
function parseCacheKey(cacheKey: string): { type: string; subtype: string; ref: string } {
  const parts = cacheKey.split(':');
  if (parts.length >= 3) {
    return {
      type: parts[0],
      subtype: parts[1],
      ref: parts.slice(2).join(':'), // Join remaining parts for ref
    };
  }
  return { type: 'unknown', subtype: 'unknown', ref: cacheKey };
}

export async function getCachedApiResponse(cacheKey: string): Promise<unknown | null> {
  const rows = await db
    .select()
    .from(apiCacheOld)
    .where(and(eq(apiCacheOld.cacheKey, cacheKey), gt(apiCacheOld.expiresAt, new Date())))
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

  try {
    // Ensure response is JSON-serializable
    const serialized = JSON.parse(JSON.stringify(response));

    // Write to legacy api_cache_old table
    await db
      .insert(apiCacheOld)
      .values({
        cacheKey,
        response: serialized,
        cachedAt: now,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: apiCacheOld.cacheKey,
        set: {
          response: serialized,
          cachedAt: now,
          expiresAt,
        },
      });

    // Write to api_cache_v2 with parsed key components
    // Use raw SQL for upsert since cacheKey has unique constraint but is not PK
    const parsed = parseCacheKey(cacheKey);
    const jsonResponse = JSON.stringify(serialized);
    await db.execute(sql`
      INSERT INTO api_cache_v2 (cache_key, cache_type, cache_subtype, cache_ref, response, cached_at, expires_at)
      VALUES (${cacheKey}, ${parsed.type}, ${parsed.subtype}, ${parsed.ref}, ${jsonResponse}::jsonb, ${now}, ${expiresAt})
      ON CONFLICT (cache_key) DO UPDATE SET
        cache_type = EXCLUDED.cache_type,
        cache_subtype = EXCLUDED.cache_subtype,
        cache_ref = EXCLUDED.cache_ref,
        response = EXCLUDED.response,
        cached_at = EXCLUDED.cached_at,
        expires_at = EXCLUDED.expires_at
    `);
  } catch (error: any) {
    console.error(`[CACHE_WRITE] Error caching ${cacheKey}: ${error.message}`);
    throw error;
  }
}

export async function cleanupExpiredApiCache(): Promise<number> {
  const now = new Date();
  await db.delete(apiCacheOld).where(lt(apiCacheOld.expiresAt, now));

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
