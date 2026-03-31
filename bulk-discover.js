import { db } from "./src/db/dbClient";
import { analyses, leaderboard } from "./src/lib/schema";
import { sql } from "drizzle-orm";
import { Octokit } from "@octokit/rest";
import { getBestToken } from "./src/lib/pat-pool";
import { fetchUserAnalysis } from "./src/lib/github";
import { computeScore } from "./src/lib/scoring";
const CONCURRENCY = 3; // Lowered to avoid secondary rate limits
const WAIT_TIME_MS = 60 * 1000 * 5; // 5 minutes
const BATCH_DELAY_MS = 200; // Small delay between batch processing
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function bulkDiscover(location, startRangeIndex = 0, startPage = 1) {
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
                }
                catch (e) {
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
                if (usernames.length === 0) {
                    hasMore = false;
                    break;
                }
                console.log(`    Processing ${usernames.length} users in range ${range}`);
                // Freshness Check
                const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
                const existingFresh = await db.select({ id: analyses.id })
                    .from(analyses)
                    .where(sql `${analyses.id} IN ${usernames.map(u => u.toLowerCase())} AND ${analyses.cachedAt} > ${oneHourAgo}`);
                const freshSet = new Set(existingFresh.map(f => f.id.toLowerCase()));
                for (let i = 0; i < usernames.length; i += CONCURRENCY) {
                    const batch = usernames.slice(i, i + CONCURRENCY);
                    const todo = batch.filter(u => !freshSet.has(u.toLowerCase()));
                    if (todo.length === 0)
                        continue;
                    let success = false;
                    while (!success) {
                        try {
                            await Promise.all(todo.map(async (username) => {
                                const rawData = await fetchUserAnalysis(username);
                                const scored = computeScore(rawData);
                                await db.insert(analyses).values({
                                    id: username.toLowerCase(),
                                    username: scored.user?.login || username,
                                    totalScore: scored.totalScore || 0,
                                    aiScore: scored.aiScore || 0,
                                    backendScore: scored.backendScore || 0,
                                    frontendScore: scored.frontendScore || 0,
                                    devopsScore: scored.devopsScore || 0,
                                    dataScore: scored.dataScore || 0,
                                    uniqueSkillsJson: JSON.stringify(scored.uniqueSkills || []),
                                    linkedin: scored.user?.linkedin || null,
                                    topReposJson: JSON.stringify(scored.topRepositories || []),
                                    languagesJson: JSON.stringify(scored.languageBreakdown || {}),
                                    contributionCount: scored.contributionCount || 0,
                                    cachedAt: new Date(),
                                }).onConflictDoUpdate({
                                    target: analyses.id,
                                    set: {
                                        username: scored.user?.login || username,
                                        totalScore: scored.totalScore || 0,
                                        aiScore: scored.aiScore || 0,
                                        backendScore: scored.backendScore || 0,
                                        frontendScore: scored.frontendScore || 0,
                                        devopsScore: scored.devopsScore || 0,
                                        dataScore: scored.dataScore || 0,
                                        uniqueSkillsJson: JSON.stringify(scored.uniqueSkills || []),
                                        linkedin: scored.user?.linkedin || null,
                                        topReposJson: JSON.stringify(scored.topRepositories || []),
                                        languagesJson: JSON.stringify(scored.languageBreakdown || {}),
                                        contributionCount: scored.contributionCount || 0,
                                        cachedAt: new Date()
                                    }
                                });
                                await db.insert(leaderboard).values({
                                    username: scored.user?.login || username,
                                    name: scored.user?.name || username,
                                    avatarUrl: scored.user?.avatarUrl || `https://github.com/${username}.png`,
                                    url: scored.user?.url || `https://github.com/${username}`,
                                    totalScore: scored.totalScore || 0,
                                    aiScore: scored.aiScore || 0,
                                    backendScore: scored.backendScore || 0,
                                    frontendScore: scored.frontendScore || 0,
                                    devopsScore: scored.devopsScore || 0,
                                    dataScore: scored.dataScore || 0,
                                    uniqueSkillsJson: JSON.stringify(scored.uniqueSkills || []),
                                    company: scored.user?.company || null,
                                    blog: scored.user?.websiteUrl || null,
                                    location: scored.user?.location || location,
                                    email: scored.user?.email || null,
                                    bio: scored.user?.bio || null,
                                    twitterUsername: scored.user?.twitterUsername || null,
                                    linkedin: scored.user?.linkedin || null,
                                    hireable: scored.user?.isHireable || false,
                                    experienceLevel: scored.experienceLevel || 'Newcomer',
                                    createdAt: new Date(scored.user?.createdAt || Date.now()),
                                    updatedAt: new Date(),
                                }).onConflictDoUpdate({
                                    target: leaderboard.username,
                                    set: {
                                        name: scored.user?.name || username,
                                        avatarUrl: scored.user?.avatarUrl || `https://github.com/${username}.png`,
                                        url: scored.user?.url || `https://github.com/${username}`,
                                        totalScore: scored.totalScore || 0,
                                        aiScore: scored.aiScore || 0,
                                        backendScore: scored.backendScore || 0,
                                        frontendScore: scored.frontendScore || 0,
                                        devopsScore: scored.devopsScore || 0,
                                        dataScore: scored.dataScore || 0,
                                        uniqueSkillsJson: JSON.stringify(scored.uniqueSkills || []),
                                        company: scored.user?.company || null,
                                        blog: scored.user?.websiteUrl || null,
                                        location: scored.user?.location || location,
                                        email: scored.user?.email || null,
                                        bio: scored.user?.bio || null,
                                        twitterUsername: scored.user?.twitterUsername || null,
                                        linkedin: scored.user?.linkedin || null,
                                        hireable: scored.user?.isHireable || false,
                                        experienceLevel: scored.experienceLevel || 'Newcomer',
                                        updatedAt: new Date()
                                    }
                                });
                                if (scored.totalScore > 0) {
                                    console.log(`      [RANKED] ${username} -> ${scored.totalScore.toFixed(1)}`);
                                }
                                else {
                                    console.log(`      [ADDED] ${username} (Score: 0.0)`);
                                }
                            }));
                            success = true;
                            await sleep(BATCH_DELAY_MS); // Small delay to avoid secondary rate limit
                        }
                        catch (batchError) {
                            if (batchError.message.includes("rate limited") || batchError.message.includes("rate-limited")) {
                                console.log(`      🕒 Batch rate limited (likely secondary/speed). Waiting 5 minutes...`);
                                await sleep(WAIT_TIME_MS);
                            }
                            else {
                                console.log(`      ⚠️ Batch error: ${batchError.message}. Skipping batch segment.`);
                                success = true;
                            }
                        }
                    }
                }
                if (usernames.length < 100)
                    hasMore = false;
                page++;
            }
            catch (e) {
                console.error(`  Range Error:`, e.message);
                if (e.message.includes("rate-limited")) {
                    await sleep(WAIT_TIME_MS);
                }
                else {
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
//# sourceMappingURL=bulk-discover.js.map