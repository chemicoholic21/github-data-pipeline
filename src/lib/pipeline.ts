import { 
  fetchGithubUser, 
  fetchUserRepositories, 
  fetchPullRequestsForRepo 
} from './githubScraper.js';
import {
  upsertGithubUser,
  upsertGithubRepo,
  insertPullRequests,
  upsertUserRepoScore,
  markGithubUserScraped,
} from '../db/upserts.js';
import type { User } from '../types/github.js';
import { db } from '../db/dbClient.js';
import {
  githubUsers,
  githubRepos,
  githubPullRequests,
  userRepoScores,
  userScores,
  leaderboardOld,
  leaderboard,
  usersOld,
  analysesOld
} from '../db/schema.js';
import { eq, sql, desc } from 'drizzle-orm';
import { 
  computeRepoScore 
} from './scoring.js';

/**
 * True when an error means "GitHub quota is exhausted right now" — i.e. the
 * token pool is dry (`rate-limited-all-tokens`) or the API returned a primary/
 * secondary rate-limit response (HTTP 403/429). These are transient: the right
 * response is to back off and retry, never to advance scraped_at.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message ?? '';
  if (
    msg.includes('rate-limited-all-tokens') ||
    msg.includes('secondary rate limit') ||
    msg.includes('rate limit')
  ) {
    return true;
  }
  // Axios-shaped errors carry the HTTP status without us importing axios here.
  const status = (error as { response?: { status?: number } }).response?.status;
  return status === 403 || status === 429;
}

/**
 * STAGE 1: SCRAPE
 */
export async function scrapeUser(username: string, forceRefresh = false): Promise<User> {
  console.log(`\n[SCRAPE][START] User: ${username}`);

  try {
    console.log(`[SCRAPE] Fetching user profile...`);
    const user = await fetchGithubUser(username, forceRefresh);
    await upsertGithubUser(user);
    console.log(`[SCRAPE][USER] ✅ Profile saved`);

    console.log(`[SCRAPE] Fetching repositories...`);
    const repos = await fetchUserRepositories(username, forceRefresh);
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
        const prs = await fetchPullRequestsForRepo(repo.ownerLogin, repo.name, forceRefresh);
        const userPrs = prs.filter(pr => pr.authorLogin.toLowerCase() === username.toLowerCase());

        if (userPrs.length > 0) {
          await insertPullRequests(userPrs);
          totalPrsSaved += userPrs.length;
          console.log(`  └─ [${repo.ownerLogin}/${repo.name}] Found ${userPrs.length} PRs.`);
        }
      } catch (error: unknown) {
        // Rate-limit errors are transient and recoverable: do NOT swallow them.
        // Re-throw so the whole user scrape fails, scraped_at is left untouched,
        // and the refresh loop retries this user once the token pool resets —
        // instead of marking it "done" with partially-missing PR data.
        if (isRateLimitError(error)) {
          console.error(
            `  └─ [${repo.ownerLogin}/${repo.name}] ⏳ rate-limited — aborting user to retry later`
          );
          throw error;
        }
        // Persistent per-repo errors (deleted repo, 404, etc.) stay non-fatal:
        // skipping one repo must not block the user forever.
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`  └─ [${repo.ownerLogin}/${repo.name}] ❌ Error: ${errorMsg}`);
      }
    }

    console.log(`[SCRAPE][COMPLETE] ✅ Total PRs: ${totalPrsSaved}`);
    return user;
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[SCRAPE][ERROR] ${errorMsg}`);
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
  
  if (repoStats.length === 0) {
    console.log(`[COMPUTE] No PR contributions found for ${username}`);
    return;
  }

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
  
  console.log(`[COMPUTE][COMPLETE] ✅ Processed ${repoStats.length} repos`);
}

/**
 * STAGE 3: AGGREGATE
 */
export async function updateUserScores(username: string, linkedin: string | null = null) {
  console.log(`\n[AGGREGATE][START] User: ${username}`);

  const repoScores = await db
    .select()
    .from(userRepoScores)
    .where(eq(userRepoScores.username, username))
    .orderBy(desc(userRepoScores.repoScore));

  if (repoScores.length === 0) {
    console.log(`[AGGREGATE] No repo scores found for ${username}, syncing profile only`);
    await syncToLegacyTables({ totalScore: 0 }, username, linkedin);
    return;
  }

  let totalScore = 0;
  for (const rs of repoScores) {
    totalScore += rs.repoScore;
  }

  const userScoreData = {
    username,
    totalScore,
    updatedAt: new Date(),
  };

  await db.insert(userScores).values(userScoreData).onConflictDoUpdate({
    target: userScores.username,
    set: userScoreData,
  });

  await syncToLegacyTables(userScoreData, username, linkedin);
  console.log(`[AGGREGATE][COMPLETE] ✅ Score: ${totalScore.toFixed(2)}`);
}

async function syncToLegacyTables(
  agg: { totalScore: number; contributionCount?: number },
  username: string,
  linkedin: string | null = null
): Promise<void> {
  const userRows = await db.select().from(githubUsers).where(eq(githubUsers.username, username)).limit(1);
  const user = userRows[0];
  if (!user) {
    return;
  }

  // ---------------------------------------------------------------------------
  // PRIMARY WRITE FIRST: the real `leaderboard` table is the one that matters,
  // so write it before the legacy tables. Previously the legacy writes ran
  // first, and if either threw, this write was skipped and the leaderboard went
  // stale. Use raw SQL to avoid schema mismatch issues.
  // ---------------------------------------------------------------------------
  console.log(`[SYNC] Leaderboard data for ${username}: location="${user.location ?? 'null'}"`);

  await db.execute(sql`
    INSERT INTO leaderboard (username, name, avatar_url, bio, location, company, blog, url, email, twitter_username, linkedin, hireable, followers, following, public_repos, total_score, updated_at)
    VALUES (
      ${user.username},
      ${user.name ?? null},
      ${user.avatarUrl ?? null},
      ${user.bio ?? null},
      ${user.location ?? null},
      ${user.company ?? null},
      ${user.blog ?? null},
      ${`https://github.com/${user.username}`},
      ${user.email ?? null},
      ${user.twitterUsername ?? null},
      ${linkedin ?? null},
      ${user.hireable ?? false},
      ${user.followers ?? null},
      ${user.following ?? null},
      ${user.publicRepos ?? null},
      ${agg.totalScore},
      NOW()
    )
    ON CONFLICT (username) DO UPDATE SET
      name = EXCLUDED.name,
      avatar_url = EXCLUDED.avatar_url,
      bio = EXCLUDED.bio,
      location = EXCLUDED.location,
      company = EXCLUDED.company,
      blog = EXCLUDED.blog,
      url = EXCLUDED.url,
      email = EXCLUDED.email,
      twitter_username = EXCLUDED.twitter_username,
      linkedin = EXCLUDED.linkedin,
      hireable = EXCLUDED.hireable,
      followers = EXCLUDED.followers,
      following = EXCLUDED.following,
      public_repos = EXCLUDED.public_repos,
      total_score = EXCLUDED.total_score,
      updated_at = NOW()
  `);
  console.log(`[SYNC] ✅ Synced ${username} to leaderboard`);

  // ---------------------------------------------------------------------------
  // LEGACY MIRRORS (best-effort): isolate these so a failure in either one can
  // never block the primary leaderboard write above.
  // ---------------------------------------------------------------------------
  try {
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

    await db.insert(usersOld).values(legacyUserData).onConflictDoUpdate({
      target: usersOld.username,
      set: legacyUserData,
    });
    console.log(`[SYNC] ✅ Synced ${username} to users_old table`);
  } catch (error: any) {
    console.error(`[SYNC] ⚠️ users_old mirror failed for ${username} (leaderboard already updated): ${error.message}`);
  }

  try {
    const leaderboardData = {
      username: user.username,
      name: user.name ?? null,
      avatarUrl: user.avatarUrl ?? null,
      totalScore: agg.totalScore,
      // Profile fields - propagate from githubUsers
      company: user.company ?? null,
      blog: user.blog ?? null,
      location: user.location ?? null,
      email: user.email ?? null,
      bio: user.bio ?? null,
      twitterUsername: user.twitterUsername ?? null,
      linkedin: linkedin ?? null,
      hireable: user.hireable ?? false,
      updatedAt: new Date(),
    };

    await db.insert(leaderboardOld).values(leaderboardData).onConflictDoUpdate({
      target: leaderboardOld.username,
      set: leaderboardData,
    });
    console.log(`[SYNC] ✅ Synced ${username} to leaderboard_old table`);
  } catch (error: any) {
    console.error(`[SYNC] ⚠️ leaderboard_old mirror failed for ${username} (leaderboard already updated): ${error.message}`);
  }
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
          const key = cat as keyof typeof categoryScores;
          categoryScores[key] = (categoryScores[key] ?? 0) + scorePerCategory;
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
      aiScore: categoryScores.ai ?? 0,
      backendScore: categoryScores.backend ?? 0,
      frontendScore: categoryScores.frontend ?? 0,
      devopsScore: categoryScores.devops ?? 0,
      dataScore: categoryScores.data ?? 0,
      uniqueSkillsJson: topSkills,
      topReposJson: topReposList,
      languagesJson: languageFreq,
      contributionCount: totalContributions,
      linkedin: null,
      cachedAt: new Date(),
    };

    await db.insert(analysesOld).values(analysisData).onConflictDoUpdate({
      target: analysesOld.id,
      set: analysisData,
    });

    // Update leaderboard with skill scores using raw SQL
    const skillsArray = `{${topSkills.map(s => `"${s}"`).join(',')}}`;
    await db.execute(sql`
      UPDATE leaderboard SET
        total_score = ${totalScore},
        ai_score = ${categoryScores.ai ?? 0},
        backend_score = ${categoryScores.backend ?? 0},
        frontend_score = ${categoryScores.frontend ?? 0},
        devops_score = ${categoryScores.devops ?? 0},
        data_score = ${categoryScores.data ?? 0},
        unique_skills = ${skillsArray}::text[],
        updated_at = NOW()
      WHERE username = ${username}
    `);
    console.log(`[ANALYZE] ✅ Updated leaderboard with skill scores`);

    console.log(`[ANALYZE][COMPLETE] ✅ Skills analyzed`);
    console.log(`  - AI: ${(categoryScores.ai ?? 0).toFixed(2)}, Backend: ${(categoryScores.backend ?? 0).toFixed(2)}, Frontend: ${(categoryScores.frontend ?? 0).toFixed(2)}`);
    console.log(`  - DevOps: ${(categoryScores.devops ?? 0).toFixed(2)}, Data: ${(categoryScores.data ?? 0).toFixed(2)}`);
    console.log(`  - Top Skills: ${topSkills.slice(0, 5).join(', ')}`);
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[ANALYZE][ERROR] ${errorMsg}`);
    throw error;
  }
}

export async function runPipeline(username: string, forceRefresh = false): Promise<boolean> {
  console.log(`\n[PIPELINE] Starting for ${username}...`);

  // Each stage runs independently. A failure in an earlier stage (e.g. a
  // rate-limited repo fetch, or a transient scoring error) must NOT prevent the
  // leaderboard sync from running — otherwise api_cache/github_users get fresh
  // data while the leaderboard is left stale. We therefore isolate every stage
  // and ALWAYS attempt Stage 3 (the leaderboard write), then only advance
  // scraped_at when the leaderboard actually updated.
  let scrapeOk = false;
  let syncOk = false;
  let linkedin: string | null = null;

  // Stage 1: scrape fresh data (also refreshes api_cache + github_users/repos/PRs)
  try {
    console.log(`[PIPELINE] Stage 1: Scraping user data...`);
    const scrapedUser = await scrapeUser(username, forceRefresh);
    linkedin = scrapedUser.linkedin ?? null;
    scrapeOk = true;
    console.log(`[PIPELINE] Stage 1 ✅ Complete`);
  } catch (error: any) {
    console.error(`[PIPELINE] ⚠️ Stage 1 (scrape) failed for ${username}: ${error.message}`);
    if (error.stack) console.error(error.stack);
    // Continue: we may still have prior profile/score data to sync forward.
  }

  // Stage 2: recompute per-repo scores from whatever PR data we have
  try {
    console.log(`[PIPELINE] Stage 2: Computing repo scores...`);
    await updateUserRepoScores(username);
    console.log(`[PIPELINE] Stage 2 ✅ Complete`);
  } catch (error: any) {
    console.error(`[PIPELINE] ⚠️ Stage 2 (scores) failed for ${username}: ${error.message}`);
    if (error.stack) console.error(error.stack);
  }

  // Stage 3: aggregate + sync to leaderboard — the critical write. Always run it.
  try {
    console.log(`[PIPELINE] Stage 3: Aggregating scores...`);
    await updateUserScores(username, linkedin);
    syncOk = true;
    console.log(`[PIPELINE] Stage 3 ✅ Complete`);
  } catch (error: any) {
    console.error(`[PIPELINE] ❌ Stage 3 (LEADERBOARD SYNC) failed for ${username}: ${error.message}`);
    if (error.stack) console.error(error.stack);
  }

  // Stage 4: skill scores — a leaderboard UPDATE; failure here doesn't undo Stage 3
  try {
    console.log(`[PIPELINE] Stage 4: Analyzing skills...`);
    await analyzeUserSkills(username);
    console.log(`[PIPELINE] Stage 4 ✅ Complete`);
  } catch (error: any) {
    console.error(`[PIPELINE] ⚠️ Stage 4 (skills) failed for ${username}: ${error.message}`);
    if (error.stack) console.error(error.stack);
  }

  // Only mark the profile "fresh" when we actually scraped fresh data AND the
  // leaderboard sync succeeded. Otherwise leave scraped_at untouched so the
  // refresh worker re-selects this user next pass instead of freezing it.
  if (scrapeOk && syncOk) {
    await markGithubUserScraped(username);
    console.log(`[PIPELINE] ✅ Pipeline complete for ${username}`);
    return true;
  }

  console.log(
    `[PIPELINE] ⚠️ Pipeline incomplete for ${username} (scrape=${scrapeOk}, leaderboardSync=${syncOk}) — not advancing scraped_at`,
  );
  return false;
}
