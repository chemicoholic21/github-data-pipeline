const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });

async function recreateTables() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    console.log('Recreating database tables with correct schema...');

    // Drop existing tables
    await pool.query('DROP TABLE IF EXISTS leaderboard CASCADE');
    await pool.query('DROP TABLE IF EXISTS analyses CASCADE');

    // Create analyses table
    await pool.query(`
      CREATE TABLE analyses (
        id text PRIMARY KEY,
        username text NOT NULL,
        total_score real DEFAULT 0,
        ai_score real DEFAULT 0,
        backend_score real DEFAULT 0,
        frontend_score real DEFAULT 0,
        devops_score real DEFAULT 0,
        data_score real DEFAULT 0,
        unique_skills_json text,
        linkedin text,
        top_repos_json text,
        languages_json text,
        contribution_count integer,
        cached_at timestamp DEFAULT NOW()
      )
    `);

    // Create leaderboard table with all correct columns
    await pool.query(`
      CREATE TABLE leaderboard (
        username text PRIMARY KEY,
        name text,
        avatar_url text,
        url text,
        total_score real DEFAULT 0,
        ai_score real DEFAULT 0,
        backend_score real DEFAULT 0,
        frontend_score real DEFAULT 0,
        devops_score real DEFAULT 0,
        data_score real DEFAULT 0,
        unique_skills_json text,
        company text,
        blog text,
        location text,
        email text,
        bio text,
        twitter_username text,
        linkedin text,
        hireable boolean,
        created_at timestamp,
        updated_at timestamp DEFAULT NOW()
      )
    `);

    console.log('Tables recreated successfully with correct schema!');
    console.log('You can now run the bulk discover script.');
  } catch (error) {
    console.error('Error recreating tables:', error.message);
  } finally {
    await pool.end();
  }
}

recreateTables();