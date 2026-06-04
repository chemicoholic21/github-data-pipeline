import axios, { AxiosInstance, AxiosResponse } from 'axios';
import crypto from 'crypto';
import { getBestToken, updateTokenRateLimit, markTokenExhausted } from './tokenPool.js';
import { getCachedApiResponse, setCachedApiResponse } from '../lib/apiCache.js';

const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

export interface RateLimitInfo {
  remaining: number;
  resetTime: number;
  cost: number;
}

export interface GitHubGraphqlRequestOptions {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  useCache?: boolean;
  cacheTTL?: number;
  forceRefresh?: boolean;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

class GitHubGraphqlClient {
  private axiosClient: AxiosInstance;

  constructor() {
    this.axiosClient = axios.create({
      baseURL: GITHUB_GRAPHQL_ENDPOINT,
      timeout: 10000,
    });
  }

  async request<T>(options: GitHubGraphqlRequestOptions): Promise<T> {
    const {
      query,
      variables,
      operationName,
      useCache = true,
      cacheTTL = 30 * 24 * 60 * 60 * 1000,
      forceRefresh = false,
    } = options;

    let cacheKey = '';
    if (useCache) {
      const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ query, variables }))
        .digest('hex');
      cacheKey = `github:graphql:${hash}`;

      if (!forceRefresh) {
        const cachedResult = await getCachedApiResponse(cacheKey);
        if (cachedResult) {
          console.log(`[CACHE_HIT] ${operationName || 'query'}`);
          return cachedResult as T;
        }
      }
    }

    // Rotate through the available PATs within a single request. A 401 (dead
    // token) or 403 rate-limit marks that token unusable and we immediately try
    // the next-best one — no backoff needed, since switching credentials is the
    // correct response. We stop when a token succeeds, when every token has been
    // tried, or when getBestToken reports all tokens exhausted.
    const tried = new Set<number>();
    let lastError: unknown;

    while (true) {
      let token: string;
      let tokenIndex: number;
      try {
        ({ token, index: tokenIndex } = await getBestToken());
      } catch (e) {
        // No token with remaining quota. Surface the underlying request error
        // if we have one (more actionable), otherwise the pool error.
        throw lastError ?? e;
      }

      // getBestToken handed back a token we already tried this request — the
      // pool can't offer anything new, so stop rotating to avoid an infinite loop.
      if (tried.has(tokenIndex)) {
        throw lastError ?? new Error('rate-limited-all-tokens');
      }
      tried.add(tokenIndex);

      this.axiosClient.defaults.headers.common['Authorization'] = `Bearer ${token}`;

      try {
        console.log(`[GraphQL] Sending ${operationName || 'query'} request (token ${tokenIndex})...`);
        const response: AxiosResponse<GraphQLResponse<T>> = await this.axiosClient.post('', {
          query,
          variables,
          operationName,
        });

        const responseHeaders = response.headers;
        const remaining = parseInt(responseHeaders['x-ratelimit-remaining'] || '0', 10);
        const resetTime = parseInt(responseHeaders['x-ratelimit-reset'] || '0', 10);

        await updateTokenRateLimit(tokenIndex, remaining, resetTime);

        let result: T;
        if (response.data && response.data.data) {
          result = response.data.data as T;
        } else {
          if (response.data.errors) {
            const errorMsg = JSON.stringify(response.data.errors);
            console.error(`[GraphQL] API errors: ${errorMsg}`);
            throw new Error('GitHub GraphQL API errors: ' + errorMsg);
          }
          result = response.data as unknown as T;
        }

        if (useCache && cacheKey) {
          try {
            console.log(`[CACHE] Writing to api_cache: ${cacheKey.substring(0, 50)}...`);
            await setCachedApiResponse(cacheKey, result, cacheTTL);
            console.log(`[CACHE] ✅ Successfully cached`);
          } catch (cacheError: any) {
            console.error(`[CACHE] ❌ Failed to write cache: ${cacheError.message}`);
            // Don't crash the pipeline, just log the error
          }
        }

        return result;
      } catch (error: unknown) {
        lastError = error;
        console.error(`[GraphQL] Error: ${error instanceof Error ? error.message : String(error)}`);

        if (axios.isAxiosError(error) && error.response) {
          console.error(`[GraphQL] Status: ${error.response.status}`);

          const message =
            typeof error.response.data === 'object' && error.response.data !== null
              ? (error.response.data as any).message
              : undefined;
          const messageText = typeof message === 'string' ? message : '';

          const isInvalidToken =
            error.response.status === 401 ||
            messageText.includes('Bad credentials') ||
            messageText.includes('must authenticate') ||
            messageText.includes('Resource not accessible by integration');

          if (isInvalidToken) {
            console.error(`[GraphQL] Token ${tokenIndex} unauthorized — marking exhausted, rotating to next PAT`);
            await markTokenExhausted(tokenIndex, Math.floor(Date.now() / 1000) + 86400);
            continue; // try the next-best token immediately, no backoff
          }

          if (
            error.response.status === 403 &&
            (messageText.includes('rate limit exceeded') ||
              messageText.includes('secondary rate limit'))
          ) {
            const resetTime = parseInt(error.response.headers['x-ratelimit-reset'] || '0', 10);
            console.error(`[GraphQL] Token ${tokenIndex} rate-limited — marking exhausted, rotating to next PAT`);
            await markTokenExhausted(tokenIndex, resetTime);
            continue; // another token may still have quota
          }
        }

        // Non-auth / non-rate-limit error (network blip, GraphQL errors, etc.):
        // not token-specific, so don't burn other PATs — let the caller's
        // retry/backoff handle it.
        throw error;
      }
    }
  }
}

const gitHubGraphqlClient = new GitHubGraphqlClient();

export { gitHubGraphqlClient };
