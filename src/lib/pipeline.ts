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
  leaderboard
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

  const user = await fetchGithubUser(username);
  await upsertGithubUser(user);
  console.log(`[SCRAPE][USER] ✅ Profile saved`);

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
    experienceLevel,
    contributionCount,
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

export async function runPipeline(username: string) {
  await scrapeUser(username);
  await updateUserRepoScores(username);
  await updateUserScores(username);
}
