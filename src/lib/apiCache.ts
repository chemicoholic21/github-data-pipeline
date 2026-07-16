import { eq, and, gt, sql } from 'drizzle-orm';
import { db } from '../db/dbClient.js';
import { apiCache } from '../db/schema.js';
import { getErrorMessage } from '../utils/async.js';

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
      type: parts[0]!,
      subtype: parts[1]!,
      ref: parts.slice(2).join(':'), // Join remaining parts for ref
    };
  }
  return { type: 'unknown', subtype: 'unknown', ref: cacheKey };
}

export async function getCachedApiResponse(cacheKey: string): Promise<unknown | null> {
  const rows = await db
    .select({ response: apiCache.response })
    .from(apiCache)
    .where(and(eq(apiCache.cacheKey, cacheKey), gt(apiCache.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  return row.response;
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

    // Write to api_cache with parsed key components.
    // Use raw SQL for upsert since cacheKey has a unique constraint but is not the PK.
    const parsed = parseCacheKey(cacheKey);
    const jsonResponse = JSON.stringify(serialized);
    await db.execute(sql`
      INSERT INTO api_cache (cache_key, cache_type, cache_subtype, cache_ref, response, cached_at, expires_at)
      VALUES (${cacheKey}, ${parsed.type}, ${parsed.subtype}, ${parsed.ref}, ${jsonResponse}::jsonb, ${now}, ${expiresAt})
      ON CONFLICT (cache_key) DO UPDATE SET
        cache_type = EXCLUDED.cache_type,
        cache_subtype = EXCLUDED.cache_subtype,
        cache_ref = EXCLUDED.cache_ref,
        response = EXCLUDED.response,
        cached_at = EXCLUDED.cached_at,
        expires_at = EXCLUDED.expires_at
    `);
  } catch (error) {
    console.error(`[CACHE_WRITE] Error caching ${cacheKey}: ${getErrorMessage(error)}`);
    throw error;
  }
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
