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

    const { token, index: tokenIndex } = await getBestToken();

    this.axiosClient.defaults.headers.common['Authorization'] = `Bearer ${token}`;

    try {
      console.log(`[GraphQL] Sending ${operationName || 'query'} request...`);
      console.log(`[GraphQL] Variables: ${JSON.stringify(variables)}`);
      
      // Log as curl command for reproducibility
      const tokenPreview = token.slice(0, 20) + '...';
      const payload = JSON.stringify({ query, variables, operationName });
      const escapedPayload = payload.replace(/'/g, "'\\''");
      console.log(`[GraphQL] Reproduce with:\ncurl -X POST https://api.github.com/graphql \\\n  -H "Authorization: Bearer ${tokenPreview}" \\\n  -H "Content-Type: application/json" \\\n  -d '${escapedPayload}'`);

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
      console.error(`[GraphQL] Error: ${error instanceof Error ? error.message : String(error)}`);
      
      if (axios.isAxiosError(error)) {
        console.error(`[GraphQL] Status: ${error.response?.status}`);

        const message =
          typeof error.response?.data === 'object' && error.response?.data !== null
            ? (error.response?.data as any).message
            : undefined;
        const messageText = typeof message === 'string' ? message : '';

        const isInvalidToken =
          error.response?.status === 401 ||
          messageText.includes('Bad credentials') ||
          messageText.includes('must authenticate') ||
          messageText.includes('Resource not accessible by integration');

        if (isInvalidToken) {
          const now = Math.floor(Date.now() / 1000);
          const invalidResetTime = now + 365 * 24 * 60 * 60; // treat invalid token as exhausted for one year
          console.error(
            `[GraphQL] Invalid GitHub token at index ${tokenIndex}; marking exhausted until ${invalidResetTime}`
          );
          await markTokenExhausted(tokenIndex, invalidResetTime);
        } else if (
          error.response &&
          error.response.status === 403 &&
          (messageText.includes('rate limit exceeded') ||
            messageText.includes('secondary rate limit'))
        ) {
          const resetTime = parseInt(error.response.headers['x-ratelimit-reset'] || '0', 10);
          await markTokenExhausted(tokenIndex, resetTime);
        }
      }
      throw error;
    }
  }
}

const gitHubGraphqlClient = new GitHubGraphqlClient();

export { gitHubGraphqlClient };
