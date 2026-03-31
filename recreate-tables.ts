import { db } from './src/db/dbClient.js';
import { sql } from 'drizzle-orm';

async function fixDatabaseSchema() {
  try {
    console.log('Checking database schema...');

    // First, let's see what columns exist
    const result = await db.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'leaderboard'
      ORDER BY ordinal_position
    `);

    console.log('Current leaderboard columns:');
    for (const row of result.rows) {
      console.log(`- ${row.column_name}: ${row.data_type} ${row.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'} ${row.column_default || ''}`);
    }

    // Check for corrupted column name
    const corruptedColumn = result.rows.find(row => row.column_name === 'frontend_sscore');
    if (corruptedColumn) {
      console.log('Found corrupted column frontend_sscore, renaming to frontend_score...');
      await db.execute(sql`ALTER TABLE leaderboard RENAME COLUMN frontend_sscore TO frontend_score`);
      console.log('Column renamed successfully!');
    }

    // Add missing columns if they don't exist
    const hasExperienceLevel = result.rows.some(row => row.column_name === 'experience_level');
    const hasCreatedAt = result.rows.some(row => row.column_name === 'created_at');

    if (!hasExperienceLevel) {
      console.log('Adding experience_level column...');
      await db.execute(sql`ALTER TABLE leaderboard ADD COLUMN experience_level text`);
    }

    if (!hasCreatedAt) {
      console.log('Adding created_at column...');
      await db.execute(sql`ALTER TABLE leaderboard ADD COLUMN created_at timestamp`);
    }

    console.log('Database schema check and fix completed!');
  } catch (error) {
    console.error('Error fixing database schema:', error);
  }
}

fixDatabaseSchema();