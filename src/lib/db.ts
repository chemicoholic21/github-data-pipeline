// src/lib/db.ts
import { neon } from '@neondatabase/serverless';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'Missing DATABASE_URL environment variable. ' +
    'Get it from your Neon console at https://console.neon.tech'
  );
}

export const sql = neon(connectionString);
