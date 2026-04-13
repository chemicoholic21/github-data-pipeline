import { eq, desc, gt } from 'drizzle-orm';
import { db, pool, schema } from '../db/dbClient.js';

export { db, pool, schema, eq, desc, gt };

const sql = db;
export { sql };
