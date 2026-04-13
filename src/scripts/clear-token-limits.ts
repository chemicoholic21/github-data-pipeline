import { db } from '../db/dbClient.js';
import { tokenRateLimit } from '../db/schema.js';
import { eq } from 'drizzle-orm';

async function clearTokenLimits() {
  console.log('Clearing all token rate limits...');

  // Delete all rows from token_rate_limit
  await db.delete(tokenRateLimit);

  console.log('Done! All tokens are now fresh.');
}

clearTokenLimits()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
