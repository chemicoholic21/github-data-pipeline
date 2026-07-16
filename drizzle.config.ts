import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

// Match the rest of the project: load .env, with .env.local as an override.
config({ path: '.env' });
config({ path: '.env.local', override: true });

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
