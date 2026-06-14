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
  // Optional per-process token partition: a comma-separated list of token
  // indices (0-based) this process is allowed to use. Lets you dedicate
  // disjoint PAT subsets to concurrent workers (e.g. refresh-worker on "0,1"
  // and compute-repo-health on "2,3,4") so they don't drain a shared budget.
  // Empty / unset / all-invalid => use every token.
  GITHUB_TOKEN_INDICES: z.string().optional(),
});

// Validate and parse the environment variables
const env = envSchema.parse(process.env);

// Collect GitHub tokens
const githubTokenCandidates: string[] = [];
if (env.GITHUB_TOKENS) {
  githubTokenCandidates.push(
    ...env.GITHUB_TOKENS.split(',').map((value) => value.trim()).filter(Boolean)
  );
}
for (let i = 1; i <= 5; i++) {
  const token = env[`GITHUB_TOKEN_${i}` as keyof typeof env] as string | undefined;
  if (token) {
    githubTokenCandidates.push(token.trim());
  }
}

const githubTokens = Array.from(new Set(githubTokenCandidates.filter(Boolean)));

if (githubTokens.length === 0) {
  throw new Error('No GitHub tokens found. Please set GITHUB_TOKENS or GITHUB_TOKEN_1, etc.');
}

/**
 * Parse GITHUB_TOKEN_INDICES into a validated, de-duplicated list of in-range
 * token indices. Returns null (meaning "use all tokens") when unset, empty, or
 * when no entry is a valid index — so a typo can never silently disable a worker.
 */
function parseTokenIndices(raw: string | undefined, tokenCount: number): number[] | null {
  if (!raw || !raw.trim()) return null;
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const valid = parsed.filter((n) => Number.isInteger(n) && n >= 0 && n < tokenCount);
  const invalid = parsed.filter((n) => !(Number.isInteger(n) && n >= 0 && n < tokenCount));
  if (invalid.length > 0) {
    console.warn(
      `[config] GITHUB_TOKEN_INDICES ignored ${invalid.length} out-of-range/invalid entr(ies) ` +
        `(valid range 0..${tokenCount - 1}).`
    );
  }
  if (valid.length === 0) {
    console.warn(
      `[config] GITHUB_TOKEN_INDICES="${raw}" yielded no valid indices — falling back to ALL tokens.`
    );
    return null;
  }
  return Array.from(new Set(valid)).sort((a, b) => a - b);
}

const tokenIndices = parseTokenIndices(env.GITHUB_TOKEN_INDICES, githubTokens.length);

// Export the validated environment variables
export const config = {
  nodeEnv: env.NODE_ENV,
  githubTokens,
  // Per-process token partition (0-based indices), or null to use all tokens.
  tokenIndices,
  databaseUrl: env.DATABASE_URL,
};

if (config.nodeEnv === 'development') {
  console.log('Environment variables loaded:');
  console.log(`NODE_ENV: ${config.nodeEnv}`);
  console.log(`DATABASE_URL: ${config.databaseUrl}`);
  console.log(`GITHUB_TOKENS count: ${config.githubTokens.length}`);
  console.log(
    `GITHUB_TOKEN_INDICES: ${tokenIndices ? `[${tokenIndices.join(',')}]` : 'all'}`
  );
}
