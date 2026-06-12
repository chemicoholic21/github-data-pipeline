/**
 * Standalone sanity test for computeContributionScore.
 * Run: npx tsx src/scripts/test-contribution-score.ts
 *
 * No DB / network — pure function checks with a fixed `now` for determinism.
 */
import { computeContributionScore } from '../lib/scoring.js';
import type { RepoHealthMetrics } from '../types/repoHealth.js';

const NOW = Date.parse('2026-06-12T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const base: RepoHealthMetrics = {
  fullName: 'acme/widget',
  ownerLogin: 'acme',
  repoName: 'widget',
  primaryLanguage: 'TypeScript',
  stars: 5000,
  isArchived: false,
  isDisabled: false,
  pushedAt: daysAgo(2),
  lastReleaseAt: daysAgo(20),
  mergedPrCount: 800,
  closedPrCount: 200,
  openPrCount: 40,
  medianFirstReviewHours: 6,
  medianMergeHours: 18,
  acceptanceRate: 0.8,
  externalMergedRatio: 0.6,
  mergeVelocityPerMonth: 30,
  openIssuesCount: 120,
  goodFirstIssues: 15,
  helpWantedIssues: 8,
  hasContributing: true,
  hasCodeOfConduct: true,
  mentionableUsers: 200,
  sampleSize: 50,
};

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// 1. A great repo scores high.
const great = computeContributionScore(base, NOW);
check('great repo scores > 70', great.score > 70, `score=${great.score}`);
check('great repo has full confidence-ish', great.confidence >= 0.8, `conf=${great.confidence}`);
check('great repo not gated', great.gatedReason === null);

// 2. A sluggish repo scores much lower than the great one.
const sluggish = computeContributionScore(
  {
    ...base,
    medianFirstReviewHours: 720, // 30 days to first review
    medianMergeHours: 1440, // 60 days to merge
    acceptanceRate: 0.2,
    externalMergedRatio: 0.05,
    mergeVelocityPerMonth: 1,
    openPrCount: 1200, // big stale backlog
    goodFirstIssues: 0,
    helpWantedIssues: 0,
    hasContributing: false,
    hasCodeOfConduct: false,
    pushedAt: daysAgo(200),
    lastReleaseAt: daysAgo(400),
  },
  NOW
);
check('sluggish < great', sluggish.score < great.score, `${sluggish.score} < ${great.score}`);
check('sluggish scores low', sluggish.score < 35, `score=${sluggish.score}`);

// 3. Gates → 0 with a reason.
check(
  'archived gated to 0',
  computeContributionScore({ ...base, isArchived: true }, NOW).gatedReason === 'archived'
);
check(
  'disabled gated to 0',
  computeContributionScore({ ...base, isDisabled: true }, NOW).gatedReason === 'disabled'
);
check(
  'low stars gated',
  computeContributionScore({ ...base, stars: 3 }, NOW).gatedReason === 'below-star-threshold'
);
check(
  'thin PR history gated',
  computeContributionScore({ ...base, mergedPrCount: 2 }, NOW).gatedReason ===
    'insufficient-pr-history'
);

// 4. Missing-data repo: only liveness available -> still scores, lower confidence.
const sparse = computeContributionScore(
  {
    ...base,
    medianFirstReviewHours: null,
    medianMergeHours: null,
    acceptanceRate: null,
    externalMergedRatio: null,
    mergeVelocityPerMonth: null,
    goodFirstIssues: 0,
    helpWantedIssues: 0,
    hasContributing: false,
    hasCodeOfConduct: false,
    sampleSize: 0,
  },
  NOW
);
check('sparse still produces a score', sparse.score > 0, `score=${sparse.score}`);
check('sparse responsiveness is null', sparse.responsiveness === null);
check('sparse confidence is low', sparse.confidence < 0.5, `conf=${sparse.confidence}`);

// 5. Faster review strictly increases score (monotonic in responsiveness).
const slowerReview = computeContributionScore({ ...base, medianFirstReviewHours: 96 }, NOW);
check(
  'faster review => higher score',
  great.score > slowerReview.score,
  `${great.score} > ${slowerReview.score}`
);

// 6. Score is bounded 0..100.
check('score within [0,100]', great.score >= 0 && great.score <= 100);

console.log(`\n${failures === 0 ? '🎉 ALL PASSED' : `💥 ${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
