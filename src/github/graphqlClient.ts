import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { config } from '../utils/config.js';
import { redisConnection, RedisClient } from '../queue/queue.js'; // Assuming redisConnection is exported
import crypto from 'crypto';

const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
const GITHUB_RATE_LIMIT_KEY_PREFIX = 'github:rate_limit'; // Redis key prefix
const GITHUB_CACHE_KEY_PREFIX = 'github:cache'; // Redis key prefix for results

interface RateLimitInfo {
  remaining: number;
  resetTime: number; // Unix timestamp
  cost: number;
}

interface GitHubGraphqlRequestOptions {
  query: string;
  variables?: Record<string, any>;
  operationName?: string;
  useCache?: boolean;
  cacheTTL?: number; // in seconds
}

interface RateLimitData {
  rate: {
    remaining: number;
    reset: number; // Unix timestamp
    cost: number;
    limit: number;
    nodeCount?: number; // Might be available in some contexts
    nodes?: number; // Might be available in some contexts
  };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

class GitHubGraphqlClient {
  private tokens: string[];
  private redis: RedisClient;
  private axiosClient: AxiosInstance;
  private tokenIndex: number = 0; // To keep track of the current token index

  constructor() {
    this.tokens = config.githubTokens;
    this.redis = redisConnection;
    this.axiosClient = axios.create({
      baseURL: GITHUB_GRAPHQL_ENDPOINT,
      timeout: 10000, // 10 second timeout
    });

    if (this.tokens.length === 0) {
      throw new Error('No GitHub tokens found in environment variables. Please set GITHUB_TOKENS.');
    }

    // Initialize rate limit info in memory if not present in Redis
    // This is a simplification; a more robust approach would fetch on startup or first use.
    this.initializeRateLimitInfo();
  }

  private async initializeRateLimitInfo() {
    for (let i = 0; i < this.tokens.length; i++) {
      const redisKey = this.getRateLimitRedisKey(i);
      const existingData = await this.redis.get(redisKey);
      if (!existingData) {
        // If no data exists, we'll fetch it on the first request for this token
        // For now, we can log that it needs fetching or set a placeholder.
        console.log(`Rate limit info for token index ${i} not found in Redis. Will fetch on first use.`);
      }
    }
  }

  private getRateLimitRedisKey(index: number): string {
    return `${GITHUB_RATE_LIMIT_KEY_PREFIX}:${index}`;
  }

  private async getTokenRateLimit(tokenIndex: number): Promise<RateLimitInfo | null> {
    const redisKey = this.getRateLimitRedisKey(tokenIndex);
    try {
      const cachedData = await this.redis.get(redisKey);
      if (cachedData) {
        const parsedData: RateLimitInfo = JSON.parse(cachedData);
        // Check if the token has reset (or is close to resetting)
        if (parsedData.resetTime * 1000 > Date.now()) {
          return parsedData;
        } else {
          // Reset time has passed, so rate limit info is stale.
          // We'll treat it as if it's missing, and refetch on next use.
          // console.log(`Rate limit info for token index ${tokenIndex} is stale. Reset time: ${new Date(parsedData.resetTime * 1000)}`);
          await this.redis.del(redisKey); // Clean up stale data
          return null;
        }
      }
    } catch (error) {
      console.error(`Error reading rate limit from Redis for token index ${tokenIndex}:`, error);
      // If Redis read fails, we can't rely on cache, so treat as missing.
      return null;
    }
    return null; // Data not found in Redis
  }

  private async updateTokenRateLimit(tokenIndex: number, headers: Record<string, string>) {
    const remaining = parseInt(headers['x-ratelimit-remaining'] || '0', 10);
    const resetTime = parseInt(headers['x-ratelimit-reset'] || '0', 10); // Unix timestamp
    const cost = parseInt(headers['x-ratelimit-cost'] || '1', 10); // Default cost to 1 if not provided

    if (!Number.isNaN(remaining) && !Number.isNaN(resetTime) && !Number.isNaN(cost)) {
      const rateLimitInfo: RateLimitInfo = { remaining, resetTime, cost };
      const redisKey = this.getRateLimitRedisKey(tokenIndex);
      try {
        await this.redis.set(redisKey, JSON.stringify(rateLimitInfo), 'EX', resetTime + 60); // Set expiry slightly after reset time
        console.log(`Updated rate limit for token index ${tokenIndex}: Remaining=${remaining}, Reset=${new Date(resetTime * 1000)}, Cost=${cost}`);
      } catch (error) {
        console.error(`Error writing rate limit to Redis for token index ${tokenIndex}:`, error);
      }
    } else {
      console.warn(`Could not parse rate limit headers for token index ${tokenIndex}. Headers:`, headers);
    }
  }

  private async getBestToken(): Promise<{ token: string; index: number; rateLimit: RateLimitInfo | null }> {
    let bestTokenIndex = -1;
    let highestRemaining = -1;
    let bestTokenRateLimit: RateLimitInfo | null = null;

    // Fetch rate limits for all tokens and find the best one
    for (let i = 0; i < this.tokens.length; i++) {
      const currentRateLimit = await this.getTokenRateLimit(i);

      // If rate limit info is missing or stale, we can't reliably pick the best.
      // In a real scenario, you might want to make a dummy request to fetch rate limits.
      // For now, we prioritize tokens with known, high remaining limits.
      // If a token is missing from Redis, we will try to use it, but can't rank it easily.
      // Let's assume if it's missing, we can't determine its rank against others.
      // A better approach: make a HEAD request or a dummy GraphQL query to get rate limits for missing tokens.

      if (currentRateLimit && currentRateLimit.remaining > highestRemaining) {
        highestRemaining = currentRateLimit.remaining;
        bestTokenIndex = i;
        bestTokenRateLimit = currentRateLimit;
      }
    }

    // If no token has rate limit info or all are exhausted, pick the first one and hope for the best.
    // A more robust solution would involve waiting or erroring if all tokens are exhausted and no valid token found.
    if (bestTokenIndex === -1) {
      console.warn('No token with available rate limit info found or all limits exhausted. Selecting the first token.');
      bestTokenIndex = 0; // Default to the first token
      // Attempt to get rate limit info for the default token, if it exists and is not stale
      bestTokenRateLimit = await this.getTokenRateLimit(bestTokenIndex);
    }

    if (bestTokenIndex === -1 || bestTokenIndex >= this.tokens.length) {
      throw new Error('GitHub API authentication failed: No valid GitHub tokens available or all tokens are rate-limited.');
    }

    const token = this.tokens[bestTokenIndex];
    if (!token) {
      throw new Error('GitHub API authentication failed: No valid GitHub tokens available or all tokens are rate-limited.');
    }

    return { token, index: bestTokenIndex, rateLimit: bestTokenRateLimit };
  }

  async request<T>(options: GitHubGraphqlRequestOptions): Promise<T> {
    const { query, variables, operationName, useCache = true, cacheTTL = 3600 } = options;

    // Caching logic
    let cacheKey = '';
    if (useCache) {
      const hash = crypto.createHash('sha256')
        .update(JSON.stringify({ query, variables }))
        .digest('hex');
      cacheKey = `${GITHUB_CACHE_KEY_PREFIX}:${hash}`;

      try {
        const cachedResult = await this.redis.get(cacheKey);
        if (cachedResult) {
          console.log(`Cache hit for query: ${operationName || 'unnamed'}`);
          return JSON.parse(cachedResult) as T;
        }
      } catch (error) {
        console.error('Error reading from Redis cache:', error);
      }
    }

    let bestTokenInfo;
    try {
      bestTokenInfo = await this.getBestToken();
    } catch (error: any) {
      console.error('Error getting best GitHub token:', error.message);
      throw error; // Re-throw to indicate failure
    }

    const { token, index: tokenIndex, rateLimit: initialRateLimit } = bestTokenInfo;

    this.axiosClient.defaults.headers.common['Authorization'] = `Bearer ${token}`;

    try {
      const response: AxiosResponse<GraphQLResponse<T>> = await this.axiosClient.post('', {
        query,
        variables,
        operationName,
      });

      const responseHeaders = response.headers;
      const cost = parseInt(responseHeaders['x-ratelimit-cost'] || '1', 10);
      const remaining = parseInt(responseHeaders['x-ratelimit-remaining'] || '0', 10);
      const resetTime = parseInt(responseHeaders['x-ratelimit-reset'] || '0', 10); // Unix timestamp

      // Log rate limit info
      console.log(`GitHub API Request Cost: ${cost}, Remaining Rate Limit: ${remaining}`);

      // Update rate limit info in Redis
      await this.updateTokenRateLimit(tokenIndex, {
        'x-ratelimit-cost': String(cost),
        'x-ratelimit-remaining': String(remaining),
        'x-ratelimit-reset': String(resetTime),
      });

      // Extract result
      let result: T;
      if (response.data && response.data.data) {
        result = response.data.data as T;
      } else {
        if (response.data.errors) {
          console.error('GitHub GraphQL API returned errors:', response.data.errors);
          throw new Error('GitHub GraphQL API errors: ' + JSON.stringify(response.data.errors));
        }
        result = response.data as unknown as T;
      }

      // Store in cache if enabled
      if (useCache && cacheKey) {
        try {
          await this.redis.set(cacheKey, JSON.stringify(result), 'EX', cacheTTL);
          console.log(`Cached result for query: ${operationName || 'unnamed'} with TTL ${cacheTTL}s`);
        } catch (error) {
          console.error('Error writing to Redis cache:', error);
        }
      }

      return result;

    } catch (error: any) {
      console.error(`GitHub GraphQL request failed for token index ${tokenIndex}:`, error.message);
      // Handle specific error cases, e.g., rate limiting errors
      if (error.response) {
        console.error('GitHub API Response Status:', error.response.status);
        console.error('GitHub API Response Data:', error.response.data);
        // Check for 401 (Unauthorized) or 403 (Forbidden - often rate limiting)
        if (error.response.status === 403 && error.response.data?.message?.includes('rate limit exceeded')) {
          console.warn(`Token index ${tokenIndex} is rate limited. Attempting to use another token.`);
          // Here you could implement a backoff strategy or try another token immediately.
          // For simplicity, the getBestToken logic will be re-evaluated on the next call.
          // If this was the *only* token, this would be a critical error.
        } else if (error.response.status === 401) {
          console.error(`GitHub authentication failed for token index ${tokenIndex}. Please check your token.`);
          // Consider invalidating or marking this token as unusable temporarily.
        }
      }
      throw error; // Re-throw the error
    }
  }
}

// Instantiate the client
// It will use the existing redisConnection and tokens from config
const gitHubGraphqlClient = new GitHubGraphqlClient();

export { gitHubGraphqlClient };
export type { GitHubGraphqlRequestOptions, RateLimitInfo, RateLimitData };
