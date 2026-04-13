import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { redisConnection, RedisClient } from '../queue/queue.js';
import crypto from 'crypto';
import { getBestToken, updateTokenRateLimit, markTokenExhausted } from './tokenPool.js';

const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
const GITHUB_CACHE_KEY_PREFIX = 'github:cache'; // Redis key prefix for results

export interface RateLimitInfo {
  remaining: number;
  resetTime: number; // Unix timestamp
  cost: number;
}

export interface GitHubGraphqlRequestOptions {
  query: string;
  variables?: Record<string, any>;
  operationName?: string;
  useCache?: boolean;
  cacheTTL?: number; // in seconds
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

class GitHubGraphqlClient {
  private redis: RedisClient;
  private axiosClient: AxiosInstance;

  constructor() {
    this.redis = redisConnection;
    this.axiosClient = axios.create({
      baseURL: GITHUB_GRAPHQL_ENDPOINT,
      timeout: 10000, // 10 second timeout
    });
  }

  async request<T>(options: GitHubGraphqlRequestOptions): Promise<T> {
    const { query, variables, operationName, useCache = true, cacheTTL = 2592000 } = options; // 30 days default

    // Caching logic
    let cacheKey = '';
    if (useCache) {
      const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ query, variables }))
        .digest('hex');
      cacheKey = `${GITHUB_CACHE_KEY_PREFIX}:${hash}`;

      try {
        const cachedResult = await this.redis.get(cacheKey);
        if (cachedResult) {
          return JSON.parse(cachedResult) as T;
        }
      } catch (error) {
        console.error('Error reading from Redis cache:', error);
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
      const resetTime = parseInt(responseHeaders['x-ratelimit-reset'] || '0', 10); // Unix timestamp

      // Update rate limit info in Redis via unified token pool
      await updateTokenRateLimit(tokenIndex, remaining, resetTime);

      // Extract result
      let result: T;
      if (response.data && response.data.data) {
        result = response.data.data as T;
      } else {
        if (response.data.errors) {
          throw new Error('GitHub GraphQL API errors: ' + JSON.stringify(response.data.errors));
        }
        result = response.data as unknown as T;
      }

      // Store in cache if enabled
      if (useCache && cacheKey) {
        try {
          await this.redis.set(cacheKey, JSON.stringify(result), 'EX', cacheTTL);
        } catch (error) {
          console.error('Error writing to Redis cache:', error);
        }
      }

      return result;
    } catch (error: any) {
      if (error.response) {
        if (
          error.response.status === 403 &&
          (error.response.data?.message?.includes('rate limit exceeded') ||
            error.response.data?.message?.includes('secondary rate limit'))
        ) {
          const _remaining = parseInt(error.response.headers['x-ratelimit-remaining'] || '0', 10);
          const resetTime = parseInt(error.response.headers['x-ratelimit-reset'] || '0', 10);
          await markTokenExhausted(tokenIndex, resetTime);
        }
      }
      throw error;
    }
  }
}

// Instantiate the client
const gitHubGraphqlClient = new GitHubGraphqlClient();

export { gitHubGraphqlClient };
