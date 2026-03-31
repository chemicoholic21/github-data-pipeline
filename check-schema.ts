import { db } from './src/db/dbClient.js';
import { sql } from 'drizzle-orm';

async function checkSchema() {
  try {
    const result = await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'leaderboard' ORDER BY ordinal_position`);
    console.log('Current leaderboard columns:');
    console.log(result.rows.map(r => r.column_name));
  } catch (error) {
    console.error('Error:', error);
  }
}

checkSchema();