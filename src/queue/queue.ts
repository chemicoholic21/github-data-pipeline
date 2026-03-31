import Redis from 'ioredis';
import { Queue, Worker, Job } from 'bullmq';
import { config } from '../utils/config';
import axios from 'axios';

// --- Redis Client Setup ---
let redisConnection;
if (config.redisUrl) {
  // Use Redis protocol
  try {
    redisConnection = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null, // Prevent retries if connection is lost
    });
  } catch (error) {
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

function createUpstashRestRedis(restUrl: string, token: string) {
  const client = axios.create({
    baseURL: restUrl,
    headers: {
      Authorization: `Bearer ${token}`,
    },
    timeout: 5000,
  });

  return {
    on: (event: string, callback: Function) => {
      // Mock events
    },
    get: async (key: string) => {
      try {
        const response = await client.get(`/get/${key}`);
        return response.data.result;
      } catch (error) {
        return null;
      }
    },
    setex: async (key: string, ttl: number, value: string) => {
      try {
        await client.post(`/setex/${key}/${ttl}`, value, {
          headers: { 'Content-Type': 'text/plain' },
        });
      } catch (error) {
        // Ignore errors
      }
    },
  };
}

function createMockRedis() {
  return {
    on: () => {},
    get: () => Promise.resolve(null),
    setex: () => Promise.resolve(),
  };
}

redisConnection.on('error', (err) => {
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

// Create a BullMQ Queue instance
let githubPipelineQueue;
if (config.redisUrl) {
  githubPipelineQueue = new Queue<UsernameJob>(queueName, {
    connection: redisConnection,
  });
} else {
  githubPipelineQueue = {
    add: async () => ({ id: 'mock' }),
  };
}

// --- BullMQ Worker Setup ---
let worker;
if (config.redisUrl) {
  worker = new Worker<UsernameJob>(queueName, async (job: Job<UsernameJob>) => {
  const { username } = job.data;
  console.log(`Processing job for username: ${username} (ID: ${job.id})`);

  // Simulate work that might fail
  if (username === 'fail-me') {
    throw new Error(`Simulated failure for user: ${username}`);
  }

  // Simulate successful job completion
  console.log(`Job completed for username: ${username}`);
  return { result: `Processed ${username}` };

}, {
  connection: redisConnection,
  // Retry strategy with exponential backoff
  limiter: {
    max: 10, // Max number of jobs that can be processed concurrently
    duration: 1000, // Duration in ms
  },
  settings: {
    // Exponential backoff: retry after 5s, 10s, 20s, ...
    backoffStrategy: (delay, count) => {
      return delay * Math.pow(2, count); // delay starts at 1000ms, count is retry number
    },
    retryFailedTaskWorker: true, // Enable retrying failed tasks
    maxStalledJobCount: 10, // Number of times to retry stalled jobs
  },
  // This is crucial for enabling the retry mechanism for failed jobs
  // If a job fails, BullMQ will automatically retry it based on backoffStrategy
  // The default retry options might be sufficient, but explicit configuration is clearer.
  // For example, to set max retries:
  // maxRetriesPerJob: 3, // default is 0, meaning no retries
  });
} else {
  worker = {
    on: () => {},
  };
  console.log('BullMQ worker disabled - using REST API for Redis operations');
}

// --- Event Listeners for Logging ---

if (config.redisUrl) {
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

  // Queue events
  githubPipelineQueue.on('error', (err) => {
    console.error('Queue encountered an error:', err);
  });
}

// Optional: You might want to expose the queue and worker instances
// For example, to add jobs from other parts of your application.
export { githubPipelineQueue, worker, redisConnection };
export type { UsernameJob };
