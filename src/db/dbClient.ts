import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../utils/config.js';
import * as schema from './schema.js'; // Import all schema definitions

// Initialize PostgreSQL connection pool
const pool = new Pool({
  connectionString: config.databaseUrl,
});

// Initialize Drizzle ORM with the schema
export const db = drizzle(pool, { schema });

// Export pool if direct access is needed elsewhere, though usually not recommended for external use
export { pool };

// Export the schema object itself for use in migrations or other tools
export { schema };
