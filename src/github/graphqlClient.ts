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
    } = options;

    let cacheKey = '';
    if (useCache) {
      const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ query, variables }))
        .digest('hex');
      cacheKey = `github:graphql:${hash}`;

      const cachedResult = await getCachedApiResponse(cacheKey);
      if (cachedResult) {
        return cachedResult as T;
      }
    }

    const { token, index: tokenIndex } = await getBestToken();

    this.axiosClient.defaults.headers.common['Authorization'] = `Bearer ${token}`;

    try {
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
          throw new Error('GitHub GraphQL API errors: ' + JSON.stringify(response.data.errors));
        }
        result = response.data as unknown as T;
      }

      if (useCache && cacheKey) {
        await setCachedApiResponse(cacheKey, result, cacheTTL);
      }

      return result;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response) {
        if (
          error.response.status === 403 &&
          (error.response.data?.message?.includes('rate limit exceeded') ||
            error.response.data?.message?.includes('secondary rate limit'))
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
