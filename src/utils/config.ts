import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env and .env.local files
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

// Define the schema for environment variables
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid URL.' }),
  GITHUB_TOKENS: z.string().optional(),
  GITHUB_TOKEN_1: z.string().optional(),
  GITHUB_TOKEN_2: z.string().optional(),
  GITHUB_TOKEN_3: z.string().optional(),
  GITHUB_TOKEN_4: z.string().optional(),
  GITHUB_TOKEN_5: z.string().optional(),
});

// Validate and parse the environment variables
const env = envSchema.parse(process.env);

// Collect GitHub tokens
const githubTokens: string[] = [];
if (env.GITHUB_TOKENS) {
  githubTokens.push(...env.GITHUB_TOKENS.split(','));
}
for (let i = 1; i <= 5; i++) {
  const token = env[`GITHUB_TOKEN_${i}` as keyof typeof env] as string | undefined;
  if (token) {
    githubTokens.push(token);
  }
}

if (githubTokens.length === 0) {
  throw new Error('No GitHub tokens found. Please set GITHUB_TOKENS or GITHUB_TOKEN_1, etc.');
}

// Export the validated environment variables
export const config = {
  nodeEnv: env.NODE_ENV,
  githubTokens,
  databaseUrl: env.DATABASE_URL,
};

if (config.nodeEnv === 'development') {
  console.log('Environment variables loaded:');
  console.log(`NODE_ENV: ${config.nodeEnv}`);
  console.log(`DATABASE_URL: ${config.databaseUrl}`);
  console.log(`GITHUB_TOKENS count: ${config.githubTokens.length}`);
}
