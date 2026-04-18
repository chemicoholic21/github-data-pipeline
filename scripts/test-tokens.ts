import { config } from '../src/utils/config.js';
import { Octokit } from '@octokit/rest';

async function testTokens() {
  const allTokens = config.githubTokens;

  console.log(`Found ${allTokens.length} tokens to test.\n`);

  for (let i = 0; i < allTokens.length; i++) {
    const token = allTokens[i].trim();
    const maskedToken = `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
    
    try {
      const octokit = new Octokit({ auth: token });
      const { data } = await octokit.rest.users.getAuthenticated();
      
      const { data: rateLimit } = await octokit.rest.rateLimit.get();
      const remaining = rateLimit.resources.core.remaining;
      
      console.log(`Token ${i} (${maskedToken}): ✅ VALID (User: ${data.login}, Core Remaining: ${remaining})`);
    } catch (err: any) {
      if (err.status === 401) {
        console.log(`Token ${i} (${maskedToken}): ❌ EXPIRED/INVALID (Unauthorized)`);
      } else if (err.status === 403 && err.message.includes('rate limit')) {
        console.log(`Token ${i} (${maskedToken}): ⚠️ RATE LIMITED (But valid)`);
      } else {
        console.log(`Token ${i} (${maskedToken}): ❌ ERROR: ${err.message}`);
      }
    }
  }
}

testTokens().catch(console.error);
