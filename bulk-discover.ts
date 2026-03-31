import { db } from "./src/db/dbClient";
import { analyses, leaderboard } from "./src/lib/schema";
import { eq, sql } from "drizzle-orm";
import { Octokit } from "@octokit/rest";
import { getBestToken } from "./src/lib/pat-pool";
import { fetchUserAnalysis } from "./src/lib/github";
import { computeScore } from "./src/lib/scoring";

const CONCURRENCY = 3; // Lowered to avoid secondary rate limits
const WAIT_TIME_MS = 60 * 1000 * 5; // 5 minutes
const BATCH_DELAY_MS = 200; // Small delay between batch processing

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Raw SQL insertion to bypass schema issues
async function insertUserData(scored: any, username: string) {
  const analysisData = {
    id: username.toLowerCase(),
    username: scored.user?.login || username,
    total_score: scored.totalScore || 0,
    ai_score: scored.aiScore || 0,
    backend_score: scored.backendScore || 0,
    frontend_score: scored.frontendScore || 0,
    devops_score: scored.devopsScore || 0,
    data_score: scored.dataScore || 0,
    unique_skills_json: JSON.stringify(scored.uniqueSkills || []),
    linkedin: scored.user?.linkedin || null,
    top_repos_json: JSON.stringify(scored.topRepositories || []),
    languages_json: JSON.stringify(scored.languageBreakdown || {}),
    contribution_count: scored.contributionCount || 0,
    cached_at: new Date(),
  };

  const leaderboardData = {
    username: scored.user?.login || username,
    name: scored.user?.name || username,
    avatar_url: scored.user?.avatarUrl || `https://github.com/${username}.png`,
    url: scored.user?.url || `https://github.com/${username}`,
    total_score: scored.totalScore || 0,
    ai_score: scored.aiScore || 0,
    backend_score: scored.backendScore || 0,
    frontend_score: scored.frontendScore || 0,
    devops_score: scored.devopsScore || 0,
    data_score: scored.dataScore || 0,
    unique_skills_json: JSON.stringify(scored.uniqueSkills || []),
    company: scored.user?.company || null,
    blog: scored.user?.websiteUrl || null,
    location: scored.user?.location || null,
    email: scored.user?.email || null,
    bio: scored.user?.bio || null,
    twitter_username: scored.user?.twitterUsername || null,
    linkedin: scored.user?.linkedin || null,
    hireable: scored.user?.isHireable || false,
    created_at: new Date(scored.user?.createdAt || Date.now()),
    updated_at: new Date(),
  };

  // Insert into analyses table
  await db.execute(sql`
    INSERT INTO analyses (
      id, username, total_score, ai_score, backend_score, frontend_score,
      devops_score, data_score, unique_skills_json, linkedin, top_repos_json,
      languages_json, contribution_count, cached_at
    ) VALUES (
      ${analysisData.id}, ${analysisData.username}, ${analysisData.total_score},
      ${analysisData.ai_score}, ${analysisData.backend_score}, ${analysisData.frontend_score},
      ${analysisData.devops_score}, ${analysisData.data_score}, ${analysisData.unique_skills_json},
      ${analysisData.linkedin}, ${analysisData.top_repos_json}, ${analysisData.languages_json},
      ${analysisData.contribution_count}, ${analysisData.cached_at}
    )
    ON CONFLICT (id) DO UPDATE SET
      username = EXCLUDED.username,
      total_score = EXCLUDED.total_score,
      ai_score = EXCLUDED.ai_score,
      backend_score = EXCLUDED.backend_score,
      frontend_score = EXCLUDED.frontend_score,
      devops_score = EXCLUDED.devops_score,
      data_score = EXCLUDED.data_score,
      unique_skills_json = EXCLUDED.unique_skills_json,
      linkedin = EXCLUDED.linkedin,
      top_repos_json = EXCLUDED.top_repos_json,
      languages_json = EXCLUDED.languages_json,
      contribution_count = EXCLUDED.contribution_count,
      cached_at = EXCLUDED.cached_at
  `);

  // Insert into leaderboard table
  await db.execute(sql`
    INSERT INTO leaderboard (
      username, name, avatar_url, url, total_score, ai_score, backend_score,
      frontend_score, devops_score, data_score, unique_skills_json, company,
      blog, location, email, bio, twitter_username, linkedin, hireable,
      created_at, updated_at
    ) VALUES (
      ${leaderboardData.username}, ${leaderboardData.name}, ${leaderboardData.avatar_url},
      ${leaderboardData.url}, ${leaderboardData.total_score}, ${leaderboardData.ai_score},
      ${leaderboardData.backend_score}, ${leaderboardData.frontend_score}, ${leaderboardData.devops_score},
      ${leaderboardData.data_score}, ${leaderboardData.unique_skills_json}, ${leaderboardData.company},
      ${leaderboardData.blog}, ${leaderboardData.location}, ${leaderboardData.email},
      ${leaderboardData.bio}, ${leaderboardData.twitter_username}, ${leaderboardData.linkedin},
      ${leaderboardData.hireable}, ${leaderboardData.created_at}, ${leaderboardData.updated_at}
    )
    ON CONFLICT (username) DO UPDATE SET
      name = EXCLUDED.name,
      avatar_url = EXCLUDED.avatar_url,
      url = EXCLUDED.url,
      total_score = EXCLUDED.total_score,
      ai_score = EXCLUDED.ai_score,
      backend_score = EXCLUDED.backend_score,
      frontend_score = EXCLUDED.frontend_score,
      devops_score = EXCLUDED.devops_score,
      data_score = EXCLUDED.data_score,
      unique_skills_json = EXCLUDED.unique_skills_json,
      company = EXCLUDED.company,
      blog = EXCLUDED.blog,
      location = EXCLUDED.location,
      email = EXCLUDED.email,
      bio = EXCLUDED.bio,
      twitter_username = EXCLUDED.twitter_username,
      linkedin = EXCLUDED.linkedin,
      hireable = EXCLUDED.hireable,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at
  `);
}

async function bulkDiscover(location: string, startRangeIndex: number = 0, startPage: number = 1) {
  console.log(`Starting Global Protocol Import for: ${location}`);

  const ranges = [
    "10..20", "21..30", "31..40", "41..50",
    "51..75", "76..100", "101..150", "151..200",
    "201..300", "301..500", "501..1000", "1001..2000",
    "2001..5000", "5001..10000", ">10000",
    "0..9"
  ];

  for (let r = startRangeIndex; r < ranges.length; r++) {
    const range = ranges[r];
    console.log(`\nSlicing Range [${r}]: followers:${range}`);

    let page = (r === startRangeIndex) ? startPage : 1;
    let hasMore = true;

    while (hasMore && page <= 10) {
      try {
        let tokenData;
        try {
          tokenData = await getBestToken();
        } catch (e: any) {
          if (e.message.includes("rate-limited")) {
            console.log(`  🕒 All tokens exhausted. Waiting 5 minutes before retry...`);
            await sleep(WAIT_TIME_MS);
            continue;
          }
          throw e;
        }

        const octokit = new Octokit({ auth: tokenData.token });
        const q = `location:"${location}" followers:${range} type:user`;

        console.log(`  Fetching Registry Page ${page}...`);
        const { data } = await octokit.search.users({ q, page, per_page: 100 });

        const usernames = data.items.map(u => u.login);
        if (usernames.length === 0) { hasMore = false; break; }

        console.log(`    Processing ${usernames.length} users in range ${range}`);

        // Freshness Check
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const existingFresh = await db.select({ id: analyses.id })
          .from(analyses)
          .where(sql`${analyses.id} IN ${usernames.map(u => u.toLowerCase())} AND ${analyses.cachedAt} > ${oneHourAgo}`);

        const freshSet = new Set(existingFresh.map(f => f.id.toLowerCase()));

        for (let i = 0; i < usernames.length; i += CONCURRENCY) {
          const batch = usernames.slice(i, i + CONCURRENCY);
          const todo = batch.filter(u => !freshSet.has(u.toLowerCase()));

          if (todo.length === 0) continue;

          let success = false;
          while (!success) {
            try {
              await Promise.all(todo.map(async (username) => {
                const rawData = await fetchUserAnalysis(username);
                const scored = computeScore(rawData);

                // Use raw SQL insertion to bypass schema issues
                await insertUserData(scored, username);

                if (scored.totalScore > 0) {
                  console.log(`      [RANKED] ${username} -> ${scored.totalScore.toFixed(1)}`);
                } else {
                  console.log(`      [ADDED] ${username} (Score: 0.0)`);
                }
              }));
              success = true;
              await sleep(BATCH_DELAY_MS); // Small delay to avoid secondary rate limit
            } catch (batchError: any) {
              if (batchError.message.includes("rate limited") || batchError.message.includes("rate-limited")) {
                console.log(`      🕒 Batch rate limited (likely secondary/speed). Waiting 5 minutes...`);
                await sleep(WAIT_TIME_MS);
              } else {
                console.log(`      ⚠️ Batch error: ${batchError.message}. Skipping batch segment.`);
                success = true;
              }
            }
          }
        }

        if (usernames.length < 100) hasMore = false;
        page++;
      } catch (e: any) {
        console.error(`  Range Error:`, e.message);
        if (e.message.includes("rate-limited")) {
          await sleep(WAIT_TIME_MS);
        } else {
          hasMore = false;
        }
      }
    }
  }
  console.log(`\nMission Complete.`);
}

const location = process.argv[2] || "Sydney";
const startIdx = parseInt(process.argv[3]) || 0;
const startPage = parseInt(process.argv[4]) || 1;

bulkDiscover(location, startIdx, startPage).catch(console.error);