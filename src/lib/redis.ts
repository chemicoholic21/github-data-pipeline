// src/lib/redis.ts
import { Redis } from '@upstash/redis';

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url) {
  throw new Error(
    'Missing UPSTASH_REDIS_REST_URL environment variable. ' +
    'Get it from your Upstash console at https://console.upstash.com'
  );
}

if (!token) {
  throw new Error(
    'Missing UPSTASH_REDIS_REST_TOKEN environment variable. ' +
    'Get it from your Upstash console at https://console.upstash.com'
  );
}

export const redis = new Redis({ url, token });
