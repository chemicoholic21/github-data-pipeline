import { 
  fetchGithubUser, 
  fetchUserRepositories, 
  fetchPullRequestsForRepo 
} from './githubScraper.js';
import { 
  upsertGithubUser, 
  upsertGithubRepo, 
  insertPullRequests,
  upsertUserRepoScore
} from '../db/upserts.js';
import { db } from '../db/dbClient.js';
import { 
  githubUsers,
  githubRepos,
  githubPullRequests,
  userRepoScores, 
  userScores,
  leaderboard,
  users,
  analyses
} from '../db/schema.js';
import { eq, sql, desc } from 'drizzle-orm';
import { 
  deriveExperienceLevel, 
  computeRepoScore 
} from './scoring.js';

/**
 * STAGE 1: SCRAPE
 */
export async function scrapeUser(username: string): Promise<void> {
  console.log(`\n[SCRAPE][START] User: ${username}`);

  try {
    console.log(`[SCRAPE] Fetching user profile...`);
    const user = await fetchGithubUser(username);
    await upsertGithubUser(user);
    console.log(`[SCRAPE][USER] ✅ Profile saved`);

    console.log(`[SCRAPE] Fetching repositories...`);
    const repos = await fetchUserRepositories(username);
    console.log(`[SCRAPE][REPOS] Found ${repos.length} repositories.`);
    
    for (const repo of repos) {
      await upsertGithubRepo(repo);
    }
    console.log(`[SCRAPE][REPOS] ✅ Repos processed.`);

    const qualifyingRepos = repos.filter(r => r.stargazerCount >= 10);
    console.log(`[SCRAPE][PRS] Scanning ${qualifyingRepos.length} repos for PRs...`);

    let totalPrsSaved = 0;
    for (const repo of qualifyingRepos) {
      try {
        const prs = await fetchPullRequestsForRepo(repo.ownerLogin, repo.name);
        const userPrs = prs.filter(pr => pr.authorLogin.toLowerCase() === username.toLowerCase());
        
        if (userPrs.length > 0) {
          await insertPullRequests(userPrs);
          totalPrsSaved += userPrs.length;
          console.log(`  └─ [${repo.ownerLogin}/${repo.name}] Found ${userPrs.length} PRs.`);
        }
      } catch (error: any) {
        console.error(`  └─ [${repo.ownerLogin}/${repo.name}] ❌ Error: ${error.message}`);
      }
    }

    console.log(`[SCRAPE][COMPLETE] ✅ Total PRs: ${totalPrsSaved}`);
  } catch (error: any) {
    console.error(`[SCRAPE][ERROR] ${error.message}`);
    throw error;
  }
}

/**
 * STAGE 2: COMPUTE
 */
export async function computeUserRepoStats(username: string) {
  const stats = await db
    .select({
      repoName: githubPullRequests.repoName,
      userPrs: sql<number>`count(${githubPullRequests.id})::int`,
      totalPrs: githubRepos.totalPrs,
      stars: githubRepos.stars,
    })
    .from(githubPullRequests)
    .innerJoin(
      githubRepos,
      eq(githubPullRequests.repoName, sql`${githubRepos.ownerLogin} || '/' || ${githubRepos.repoName}`)
    )
    .where(eq(githubPullRequests.username, username))
    .groupBy(
      githubPullRequests.repoName, 
      githubRepos.totalPrs, 
      githubRepos.stars
    );

  return stats;
}

export async function updateUserRepoScores(username: string) {
  console.log(`\n[COMPUTE][START] User: ${username}`);

  const repoStats = await computeUserRepoStats(username);
  
  for (const stats of repoStats) {
    const repoScore = computeRepoScore({
      user_prs: stats.userPrs,
      total_prs: stats.totalPrs,
      stars: stats.stars,
    });

    if (repoScore > 0) {
      console.log(`  └─ [${stats.repoName}] Score: ${repoScore.toFixed(2)}`);

      await upsertUserRepoScore({
        username,
        repoName: stats.repoName,
        userPrs: stats.userPrs,
        totalPrs: stats.totalPrs,
        stars: stats.stars,
        repoScore,
        computedAt: new Date(),
      });
    }
  }
}

/**
 * STAGE 3: AGGREGATE
 */
export async function updateUserScores(username: string) {
  console.log(`\n[AGGREGATE][START] User: ${username}`);

  const repoScores = await db
    .select()
    .from(userRepoScores)
    .where(eq(userRepoScores.username, username))
    .orderBy(desc(userRepoScores.repoScore));

  let totalScore = 0;
  for (const rs of repoScores) {
    totalScore += rs.repoScore;
  }

  const contributions = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(githubPullRequests)
    .where(eq(githubPullRequests.username, username));
  
  const contributionCount = contributions[0]?.count || 0;

  const experienceLevel = deriveExperienceLevel(totalScore);

  const userScoreData = {
    username,
    totalScore,
    updatedAt: new Date(),
  };

  await db.insert(userScores).values(userScoreData).onConflictDoUpdate({
    target: userScores.username,
    set: userScoreData,
  });

  await syncToLegacyTables(userScoreData, username);
  console.log(`[AGGREGATE][COMPLETE] ✅ Score: ${totalScore.toFixed(2)}`);
}

async function syncToLegacyTables(agg: any, username: string) {
  const userRows = await db.select().from(githubUsers).where(eq(githubUsers.username, username)).limit(1);
  const user = userRows[0];
  if (!user) return;

  // Sync to legacy 'users' table
  const legacyUserData = {
    username: user.username,
    name: user.name ?? null,
    avatarUrl: user.avatarUrl ?? null,
    bio: user.bio ?? null,
    company: user.company ?? null,
    blog: user.blog ?? null,
    location: user.location ?? null,
    email: user.email ?? null,
    twitterUsername: user.twitterUsername ?? null,
    hireable: user.hireable ?? null,
    websiteUrl: user.blog ?? null,
    followers: user.followers ?? 0,
    following: user.following ?? 0,
    publicRepos: 0,
    score: agg.totalScore ?? 0,
    lastFetched: new Date(),
    updatedAt: new Date(),
  };

  await db.insert(users).values(legacyUserData).onConflictDoUpdate({
    target: users.username,
    set: legacyUserData,
  });
  console.log(`[SYNC] ✅ Synced ${username} to users table`);

  // Sync to leaderboard table
  const leaderboardData = {
    username: user.username,
    name: user.name,
    avatarUrl: user.avatarUrl,
    totalScore: agg.totalScore,
    contributionCount: agg.contributionCount,
    updatedAt: new Date(),
  };

  await db.insert(leaderboard).values(leaderboardData).onConflictDoUpdate({
    target: leaderboard.username,
    set: leaderboardData,
  });
}

/**
 * STAGE 4: ANALYZE SKILLS
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

export async function analyzeUserSkills(username: string) {
  console.log(`\n[ANALYZE][START] User: ${username}`);

  try {
    // Get all repos for this user
    const userRepos = await db
      .select()
      .from(githubRepos)
      .where(eq(githubRepos.ownerLogin, username));

    if (userRepos.length === 0) {
      console.log(`[ANALYZE] No repos found for ${username}`);
      return;
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
      linkedin: null,
      cachedAt: new Date(),
    };

    await db.insert(analyses).values(analysisData).onConflictDoUpdate({
      target: analyses.id,
      set: analysisData,
    });

    console.log(`[ANALYZE][COMPLETE] ✅ Skills analyzed`);
    console.log(`  - AI: ${categoryScores.ai.toFixed(2)}, Backend: ${categoryScores.backend.toFixed(2)}, Frontend: ${categoryScores.frontend.toFixed(2)}`);
    console.log(`  - DevOps: ${categoryScores.devops.toFixed(2)}, Data: ${categoryScores.data.toFixed(2)}`);
    console.log(`  - Top Skills: ${topSkills.slice(0, 5).join(', ')}`);
  } catch (error: any) {
    console.error(`[ANALYZE][ERROR] ${error.message}`);
    throw error;
  }
}

export async function runPipeline(username: string) {
  try {
    console.log(`\n[PIPELINE] Starting for ${username}...`);
    
    console.log(`[PIPELINE] Stage 1: Scraping user data...`);
    await scrapeUser(username);
    console.log(`[PIPELINE] Stage 1 ✅ Complete`);
    
    console.log(`[PIPELINE] Stage 2: Computing repo scores...`);
    await updateUserRepoScores(username);
    console.log(`[PIPELINE] Stage 2 ✅ Complete`);
    
    console.log(`[PIPELINE] Stage 3: Aggregating scores...`);
    await updateUserScores(username);
    console.log(`[PIPELINE] Stage 3 ✅ Complete`);

    console.log(`[PIPELINE] Stage 4: Analyzing skills...`);
    await analyzeUserSkills(username);
    console.log(`[PIPELINE] Stage 4 ✅ Complete`);
    
    console.log(`[PIPELINE] ✅ Pipeline complete for ${username}`);
  } catch (error: any) {
    console.error(`[PIPELINE] ❌ FAILED for ${username}: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    throw error;
  }
}
