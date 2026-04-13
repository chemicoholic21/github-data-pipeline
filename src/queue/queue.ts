import { Redis } from 'ioredis';
import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { config } from '../utils/config.js';
import axiosLib from 'axios';

const axios = (axiosLib as any).default || axiosLib;

// --- Redis Client Interface ---
export interface RedisClient {
  on(event: string, callback: (...args: any[]) => void): void;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<void>;
  setex(key: string, ttl: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  ttl(key: string): Promise<number>;
}

// --- Redis Client Setup ---
let redisConnection: RedisClient;
let ioRedisInstance: Redis | null = null;

if (config.redisUrl) {
  // Use Redis protocol
  try {
    ioRedisInstance = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null, // Prevent retries if connection is lost
    });
    redisConnection = ioRedisInstance as unknown as RedisClient;
  } catch (error: any) {
    console.warn('Failed to initialize Redis connection:', error.message);
    redisConnection = createMockRedis();
  }
} else if (config.upstashRestUrl && config.upstashRestToken) {
  // Use Upstash REST API
  console.log('Using Upstash REST API for Redis operations');
  redisConnection = createUpstashRestRedis(config.upstashRestUrl, config.upstashRestToken);
} else {
  console.warn('No Redis URL or Upstash REST credentials configured, using in-memory storage');
  redisConnection = createMockRedis();
}

function createUpstashRestRedis(restUrl: string, token: string): RedisClient {
  const client = axios.create({
    baseURL: restUrl,
    headers: {
      Authorization: `Bearer ${token}`,
    },
    timeout: 5000,
  });

  const execCommand = async (command: any[]) => {
    try {
      const response = await client.post('/', command);
      return response.data.result;
    } catch (error: any) {
      console.error('Upstash Redis REST Error:', error.message);
      return null;
    }
  };

  return {
    on: (event: string, callback: (...args: any[]) => void) => {
      // Mock events - Upstash REST doesn't support real-time events like 'connect' or 'error' in the same way
      if (event === 'connect') {
        setTimeout(callback, 0);
      }
    },
    get: async (key: string) => {
      return await execCommand(['GET', key]);
    },
    set: async (key: string, value: string, ...args: any[]) => {
      const command = ['SET', key, value, ...args];
      await execCommand(command);
    },
    setex: async (key: string, ttl: number, value: string) => {
      await execCommand(['SETEX', key, ttl, value]);
    },
    del: async (key: string) => {
      await execCommand(['DEL', key]);
    },
    keys: async (pattern: string) => {
      return (await execCommand(['KEYS', pattern])) || [];
    },
    ttl: async (key: string) => {
      return await execCommand(['TTL', key]);
    },
  } as RedisClient;
}

function createMockRedis(): RedisClient {
  return {
    on: () => {},
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    setex: () => Promise.resolve(),
    del: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
    ttl: () => Promise.resolve(-1),
  } as RedisClient;
}

redisConnection.on('error', (err: Error) => {
  console.error('Redis Connection Error:', err);
});

redisConnection.on('connect', () => {
  console.log('Connected to Redis');
});

// --- BullMQ Queue Setup ---
const queueName = 'github-pipeline';

// Define the structure for a job
interface UsernameJob {
  username: string;
}

// Mock queue type for when Redis is not available
interface MockQueue {
  add: (name: string, data: UsernameJob) => Promise<{ id: string }>;
}

// Create a BullMQ Queue instance
let githubPipelineQueue: Queue<UsernameJob> | MockQueue;
if (config.redisUrl && ioRedisInstance) {
  githubPipelineQueue = new Queue<UsernameJob>(queueName, {
    connection: ioRedisInstance,
  });
} else {
  githubPipelineQueue = {
    add: async () => ({ id: 'mock' }),
  };
}

// Mock worker type
interface MockWorker {
  on: (event: string, callback: (...args: any[]) => void) => void;
}

// --- BullMQ Worker Setup ---
let worker: Worker<UsernameJob> | MockWorker;
if (config.redisUrl && ioRedisInstance) {
  worker = new Worker<UsernameJob>(
    queueName,
    async (job: Job<UsernameJob>) => {
      const { username } = job.data;
      console.log(`Processing job for username: ${username} (ID: ${job.id})`);

      // Simulate work that might fail
      if (username === 'fail-me') {
        throw new Error(`Simulated failure for user: ${username}`);
      }

      // Simulate successful job completion
      console.log(`Job completed for username: ${username}`);
      return { result: `Processed ${username}` };
    },
    {
      connection: ioRedisInstance,
      // Retry strategy with exponential backoff
      limiter: {
        max: 10, // Max number of jobs that can be processed concurrently
        duration: 1000, // Duration in ms
      },
      settings: {
        // Exponential backoff: retry after 5s, 10s, 20s, ...
        backoffStrategy: (attemptsMade: number) => {
          return 1000 * Math.pow(2, attemptsMade); // delay starts at 1000ms
        },
      },
    }
  );
} else {
  worker = {
    on: () => {},
  };
  console.log('BullMQ worker disabled - using REST API for Redis operations');
}

// --- Event Listeners for Logging ---

if (config.redisUrl && ioRedisInstance && worker instanceof Worker) {
  // Worker events
  worker.on('completed', (job: Job<UsernameJob>) => {
    console.log(`Job ${job.id} for user ${job.data.username} completed.`);
  });

  worker.on('failed', (job: Job<UsernameJob> | undefined, err: Error) => {
    if (job) {
      console.error(`Job ${job.id} for user ${job.data.username} failed:`, err.message);
    } else {
      console.error('A worker failed with an unknown job:', err.message);
    }
  });

  worker.on('error', (err: Error) => {
    console.error('Worker encountered an error:', err);
  });

  // Queue events - use QueueEvents for queue-level events
  if (githubPipelineQueue instanceof Queue) {
    const queueEvents = new QueueEvents(queueName, { connection: ioRedisInstance });
    queueEvents.on('error', (err: Error) => {
      console.error('Queue encountered an error:', err);
    });
  }
}

// Optional: You might want to expose the queue and worker instances
// For example, to add jobs from other parts of your application.
export { githubPipelineQueue, worker, redisConnection };
export type { UsernameJob };
