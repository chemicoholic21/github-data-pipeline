import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../utils/config.js';
import * as schema from './schema.js';

// Initialize PostgreSQL connection pool with error handling
let pool: Pool;
try {
  pool = new Pool({
    connectionString: config.databaseUrl,
  });

  pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err.message);
  });

  pool.on('connect', () => {
    console.log('Database connected successfully');
  });
} catch (error) {
  console.error('Failed to initialize database pool:', error);
  throw error;
}

// Initialize Drizzle ORM with the schema
export const db = drizzle(pool, { schema });

export { pool };
export { schema };
