import { db } from "./src/db/dbClient";
import { sql } from "drizzle-orm";

async function testDatabaseConnection() {
  try {
    console.log('Testing database connection...');

    // Test basic connection
    const result = await db.execute(sql`SELECT 1 as test`);
    console.log('Database connection successful:', result.rows[0]);

    // Check if tables exist
    const tablesResult = await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('analyses', 'leaderboard')
    `);

    console.log('Existing tables:', tablesResult.rows.map(r => r.table_name));

    // Check leaderboard columns
    const columnsResult = await db.execute(sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'leaderboard'
      ORDER BY ordinal_position
    `);

    console.log('Leaderboard columns:');
    columnsResult.rows.forEach(row => {
      console.log(`  - ${row.column_name}: ${row.data_type}`);
    });

    console.log('Database test completed successfully!');
  } catch (error) {
    console.error('Database test failed:', error);
  }
}

testDatabaseConnection();