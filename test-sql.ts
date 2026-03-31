import { db } from "./src/db/dbClient";
import { sql } from "drizzle-orm";

async function testRawSQL() {
  try {
    console.log('Testing raw SQL insertion...');

    // Test data
    const testData = {
      username: 'testuser123',
      name: 'Test User',
      avatar_url: 'https://github.com/testuser123.png',
      url: 'https://github.com/testuser123',
      total_score: 50.5,
      ai_score: 10.0,
      backend_score: 15.0,
      frontend_score: 20.0,
      devops_score: 5.0,
      data_score: 0.5,
      unique_skills_json: JSON.stringify(['javascript', 'react']),
      company: 'Test Company',
      location: 'Sydney',
      hireable: true,
      created_at: new Date(),
      updated_at: new Date(),
    };

    // Test insertion
    await db.execute(sql`
      INSERT INTO leaderboard (
        username, name, avatar_url, url, total_score, ai_score, backend_score,
        frontend_score, devops_score, data_score, unique_skills_json, company,
        location, hireable, created_at, updated_at
      ) VALUES (
        ${testData.username}, ${testData.name}, ${testData.avatar_url}, ${testData.url},
        ${testData.total_score}, ${testData.ai_score}, ${testData.backend_score},
        ${testData.frontend_score}, ${testData.devops_score}, ${testData.data_score},
        ${testData.unique_skills_json}, ${testData.company}, ${testData.location},
        ${testData.hireable}, ${testData.created_at}, ${testData.updated_at}
      )
      ON CONFLICT (username) DO UPDATE SET
        name = EXCLUDED.name,
        total_score = EXCLUDED.total_score,
        frontend_score = EXCLUDED.frontend_score,
        updated_at = EXCLUDED.updated_at
    `);

    console.log('Raw SQL insertion test successful!');

    // Verify the data
    const verifyResult = await db.execute(sql`
      SELECT username, total_score, frontend_score
      FROM leaderboard
      WHERE username = ${testData.username}
    `);

    console.log('Verification result:', verifyResult.rows[0]);

  } catch (error) {
    console.error('Raw SQL test failed:', error);
  }
}

testRawSQL();