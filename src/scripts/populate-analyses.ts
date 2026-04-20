import { db } from '../db/dbClient.js';
import { 
  githubUsers, 
  githubRepos, 
  githubPullRequests,
  analyses 
} from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

/**
 * Skill categorization keywords
 */
const SKILL_CATEGORIES = {
  ai: ['ai', 'ml', 'machine-learning', 'deep-learning', 'neural', 'tensorflow', 'pytorch', 'nlp', 'gpt', 'llm', 'langchain', 'huggingface', 'scikit-learn', 'keras'],
  backend: ['backend', 'api', 'server', 'nodejs', 'node.js', 'python', 'java', 'go', 'rust', 'spring', 'express', 'django', 'fastapi', 'graphql', 'database', 'sql', 'mongodb', 'postgresql'],
  frontend: ['frontend', 'react', 'vue', 'angular', 'svelte', 'typescript', 'javascript', 'css', 'html', 'nextjs', 'nuxt', 'tailwind', 'ui', 'ux', 'web'],
  devops: ['devops', 'docker', 'kubernetes', 'k8s', 'terraform', 'aws', 'gcp', 'azure', 'ci-cd', 'github-actions', 'gitlab', 'jenkins', 'monitoring', 'logging', 'infrastructure'],
  data: ['data', 'analytics', 'data-science', 'pandas', 'numpy', 'spark', 'hadoop', 'snowflake', 'dbt', 'tableau', 'powerbi', 'etl', 'warehouse', 'bigquery'],
};

function categorizeRepo(repo: any): string[] {
  const categories: Set<string> = new Set();
  const allKeywords = (repo.topics || [])
    .concat(repo.primaryLanguage ? [repo.primaryLanguage.toLowerCase()] : [])
    .map((s: string) => s.toLowerCase());

  for (const [category, keywords] of Object.entries(SKILL_CATEGORIES)) {
    if (allKeywords.some((kw: string) => keywords.some(k => kw.includes(k)))) {
      categories.add(category);
    }
  }

  return Array.from(categories);
}

async function computeAnalysisForUser(username: string) {
  console.log(`[ANALYSE] Computing analysis for: ${username}`);

  // Get all repos for this user
  const userRepos = await db
    .select()
    .from(githubRepos)
    .where(eq(githubRepos.ownerLogin, username));

  if (userRepos.length === 0) {
    console.log(`[ANALYSE] No repos found for ${username}`);
    return null;
  }

  // Get all PRs for this user
  const userPrs = await db
    .select()
    .from(githubPullRequests)
    .where(eq(githubPullRequests.username, username));

  const prsByRepo = new Map<string, any[]>();
  for (const pr of userPrs) {
    if (!prsByRepo.has(pr.repoName)) {
      prsByRepo.set(pr.repoName, []);
    }
    prsByRepo.get(pr.repoName)!.push(pr);
  }

  // Categorize repos and compute scores
  const categoryScores: Record<string, number> = {
    ai: 0,
    backend: 0,
    frontend: 0,
    devops: 0,
    data: 0,
  };

  const topRepos: any[] = [];
  const languageFreq: Record<string, number> = {};
  const skillsSet = new Set<string>();
  let totalContributions = 0;

  for (const repo of userRepos) {
    const categories = categorizeRepo(repo);
    const prCount = prsByRepo.get(repo.repoName)?.length || 0;

    // Base score from stars
    const starScore = Math.log(repo.stars + 1) * 10;
    
    // PR contribution score
    const prScore = prCount * 5;
    
    // Total repo score
    const repoScore = starScore + prScore;

    // Distribute score to categories
    if (categories.length > 0) {
      const scorePerCategory = repoScore / categories.length;
      for (const cat of categories) {
        categoryScores[cat as keyof typeof categoryScores] += scorePerCategory;
      }
    }

    // Track for top repos
    topRepos.push({
      name: repo.repoName,
      owner: repo.ownerLogin,
      stars: repo.stars,
      prs: prCount,
      score: repoScore,
      categories,
    });

    // Track languages
    if (repo.primaryLanguage) {
      languageFreq[repo.primaryLanguage] = (languageFreq[repo.primaryLanguage] || 0) + 1;
    }

    // Track skills from topics
    if (repo.topics && Array.isArray(repo.topics)) {
      for (const topic of repo.topics) {
        skillsSet.add(topic.toLowerCase());
      }
    }

    totalContributions += prCount;
  }

  // Sort and get top 5 repos
  const topReposList = topRepos
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Sort and get top skills
  const topSkills = Array.from(skillsSet)
    .sort()
    .slice(0, 10);

  const totalScore = Object.values(categoryScores).reduce((a, b) => a + b, 0);

  const analysisData = {
    id: username.toLowerCase(),
    username,
    totalScore,
    aiScore: categoryScores.ai,
    backendScore: categoryScores.backend,
    frontendScore: categoryScores.frontend,
    devopsScore: categoryScores.devops,
    dataScore: categoryScores.data,
    uniqueSkillsJson: topSkills,
    topReposJson: topReposList,
    languagesJson: languageFreq,
    contributionCount: totalContributions,
    linkedin: null, // Can be populated from githubUsers if available
    cachedAt: new Date(),
  };

  console.log(`[ANALYSE] ✅ Computed for ${username}:`);
  console.log(`  - Total Score: ${totalScore.toFixed(2)}`);
  console.log(`  - AI: ${categoryScores.ai.toFixed(2)}, Backend: ${categoryScores.backend.toFixed(2)}, Frontend: ${categoryScores.frontend.toFixed(2)}`);
  console.log(`  - DevOps: ${categoryScores.devops.toFixed(2)}, Data: ${categoryScores.data.toFixed(2)}`);
  console.log(`  - Skills: ${topSkills.join(', ')}`);
  console.log(`  - Contributions: ${totalContributions}`);

  return analysisData;
}

async function populateAnalysesTable(username?: string) {
  try {
    let usernames: string[] = [];

    if (username) {
      usernames = [username];
    } else {
      // Get all unique usernames from githubUsers
      const allUsers = await db
        .selectDistinct({ username: githubUsers.username })
        .from(githubUsers);

      usernames = allUsers.map(u => u.username);
      console.log(`[ANALYSE] Found ${usernames.length} users to analyze`);
    }

    let successCount = 0;
    for (const uname of usernames) {
      try {
        const analysisData = await computeAnalysisForUser(uname);
        
        if (!analysisData) {
          console.log(`[ANALYSE] Skipping ${uname} - no data`);
          continue;
        }

        // Upsert into analyses table
        await db
          .insert(analyses)
          .values(analysisData)
          .onConflictDoUpdate({
            target: analyses.id,
            set: analysisData,
          });

        console.log(`[ANALYSE] 📊 Upserted analysis for ${uname}`);
        successCount++;
      } catch (error: any) {
        console.error(`[ANALYSE] ❌ Error for ${uname}: ${error.message}`);
      }
    }

    console.log(`\n[ANALYSE] ✅ Complete! Updated ${successCount}/${usernames.length} users`);
  } catch (error: any) {
    console.error(`[ANALYSE] ❌ Fatal error: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    throw error;
  }
}

// Main
const targetUser = process.argv[2];
populateAnalysesTable(targetUser).catch(console.error);
