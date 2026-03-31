import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../utils/config';

// Initialize PostgreSQL connection pool
const pool = new Pool({
  connectionString: config.databaseUrl,
});

// Initialize Drizzle ORM
export const db = drizzle(pool);

// Optional: Export pool if direct access is needed elsewhere
export { pool };
