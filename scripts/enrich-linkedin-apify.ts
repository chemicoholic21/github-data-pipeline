import 'dotenv/config';
import { db } from '../src/db/dbClient.js';
import { sql } from 'drizzle-orm';

const APIFY_ACTOR = 'bestscrapers~linkedin-open-to-work-status';
const APIFY_BASE_URL = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`;
const BATCH_SIZE = 30;
const MAX_RETRIES = 2;
const DELAY_MS = 1500;

interface User {
  id: string;
  github_login: string;
  linkedin_url: string | null;
  is_open_to_work: boolean | null;
  otw_scraped_at: Date | null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchTopUsers(): Promise<User[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  const result = await db.execute(sql`
    SELECT id, github_login, linkedin_url, is_open_to_work, otw_scraped_at
    FROM users
    WHERE linkedin_url IS NOT NULL
      AND (otw_scraped_at IS NULL OR otw_scraped_at < ${sevenDaysAgo})
    ORDER BY followers_count DESC
    LIMIT 1000
  `);
  
  return result.rows as unknown as User[];
}

async function getOpenToWorkFromApify(
  linkedinUrl: string,
  retries: number = MAX_RETRIES
): Promise<boolean | null> {
  const token = process.env.APIFY_TOKEN;
  
  if (!token) {
    throw new Error('APIFY_TOKEN environment variable is not set');
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${APIFY_BASE_URL}?token=${token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          profileUrls: [linkedinUrl],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        
        if (response.status === 401 || response.status === 403) {
          throw new Error(`API token failed: ${response.status} - ${errorText}`);
        }
        
        if (attempt < retries) {
          await sleep(DELAY_MS * (attempt + 1));
          continue;
        }
        
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as Array<{ isOpenToWork: boolean }>;
      
      if (data && data.length > 0 && data[0] !== null) {
        return data[0].isOpenToWork ?? null;
      }
      
      return null;
    } catch (error: any) {
      if (attempt === retries) {
        throw error;
      }
      await sleep(DELAY_MS * (attempt + 1));
    }
  }
  
  return null;
}

async function updateUser(
  userId: string,
  isOpenToWork: boolean | null
): Promise<void> {
  await db.execute(sql`
    UPDATE users
    SET is_open_to_work = ${isOpenToWork},
        otw_scraped_at = NOW()
    WHERE id = ${userId}
  `);
}

async function processUser(user: User): Promise<{ success: boolean; error?: string }> {
  if (!user.linkedin_url) {
    return { success: false, error: 'No LinkedIn URL' };
  }

  try {
    const isOpenToWork = await getOpenToWorkFromApify(user.linkedin_url);
    await updateUser(user.id, isOpenToWork);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function main() {
  const token = process.env.APIFY_TOKEN;
  
  if (!token) {
    console.error('Error: APIFY_TOKEN environment variable is not set');
    console.error('Please set APIFY_TOKEN=your_token_here');
    process.exit(1);
  }

  console.log('Fetching users to process...');
  const users = await fetchTopUsers();
  
  if (users.length === 0) {
    console.log('No users found that need processing.');
    return;
  }

  console.log(`Found ${users.length} users to process\n`);

  let processed = 0;
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    processed++;
    
    console.log(`[${processed}/${users.length}] ${user.github_login}`);
    
    const result = await processUser(user);
    
    if (result.success) {
      successCount++;
      console.log(`  ✓ OpenToWork: processing complete`);
    } else {
      failureCount++;
      console.log(`  ✗ ${result.error}`);
    }

    if (i < users.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Total processed: ${processed}`);
  console.log(`Success: ${successCount}`);
  console.log(`Failures: ${failureCount}`);
}

main().catch(console.error);