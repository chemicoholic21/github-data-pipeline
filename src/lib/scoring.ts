import type { UserAnalysis } from '../types/github.js';
import type { RepoHealthMetrics, ContributionScore } from '../types/repoHealth.js';

export type ExperienceLevel =
  | 'Newcomer'
  | 'Contributor'
  | 'Active Contributor'
  | 'Core Contributor'
  | 'Open Source Leader';

export interface TopRepositorySummary {
  name: string;
  ownerLogin: string;
  stars: number;
  userPRs: number;
  totalPRs: number;
  score: number;
  language: string | null;
}

export interface ScoredUser extends UserAnalysis {
  totalScore: number;
  aiScore: number;
  backendScore: number;
  frontendScore: number;
  devopsScore: number;
  dataScore: number;
  topRepositories: TopRepositorySummary[];
  experienceLevel: ExperienceLevel;
}

const MAX_REPO_SCORE = 10_000;

export function computeRepoScore({
  user_prs,
  total_prs,
  stars,
}: {
  user_prs: number;
  total_prs: number;
  stars: number | null | undefined;
}): number {
  if (!total_prs || total_prs <= 0) return 0;
  const safeStars = stars ?? 0;
  const score = safeStars * (user_prs / total_prs);
  return Math.min(score, MAX_REPO_SCORE);
}

function scoreRepo(stars: number, userPRs: number, totalPRs: number): number {
  if (stars < 10) return 0;
  if (totalPRs <= 0) return 0;
  const raw = stars * (userPRs / totalPRs);
  return Math.min(raw, MAX_REPO_SCORE);
}

export function deriveExperienceLevel(totalScore: number): ExperienceLevel {
  if (totalScore < 10) return 'Newcomer';
  if (totalScore < 100) return 'Contributor';
  if (totalScore < 500) return 'Active Contributor';
  if (totalScore < 2000) return 'Core Contributor';
  return 'Open Source Leader';
}

// Category mapping for skill categorization
export const CATEGORY_MAP = {
  AI: [
    'machine-learning',
    'deep-learning',
    'ai',
    'artificial-intelligence',
    'neural-network',
    'tensorflow',
    'pytorch',
    'keras',
    'scikit-learn',
    'nlp',
    'computer-vision',
  ],
  Backend: [
    'api',
    'server',
    'backend',
    'microservices',
    'rest',
    'graphql',
    'database',
    'postgresql',
    'mysql',
    'mongodb',
    'redis',
    'docker',
    'kubernetes',
  ],
  Frontend: [
    'frontend',
    'react',
    'vue',
    'angular',
    'javascript',
    'typescript',
    'html',
    'css',
    'web',
    'ui',
    'ux',
  ],
  DevOps: [
    'devops',
    'ci-cd',
    'automation',
    'infrastructure',
    'terraform',
    'ansible',
    'jenkins',
    'github-actions',
    'docker',
    'kubernetes',
    'aws',
    'azure',
    'gcp',
  ],
  Data: [
    'data',
    'analytics',
    'big-data',
    'data-science',
    'sql',
    'python',
    'r',
    'pandas',
    'numpy',
    'jupyter',
    'data-visualization',
  ],
};

export const LANGUAGE_HINTS: Record<string, keyof typeof CATEGORY_MAP> = {
  Python: 'AI',
  R: 'Data',
  Julia: 'AI',
  JavaScript: 'Frontend',
  TypeScript: 'Frontend',
  Java: 'Backend',
  'C#': 'Backend',
  Go: 'Backend',
  Rust: 'Backend',
  'C++': 'Backend',
  PHP: 'Backend',
  Ruby: 'Backend',
  SQL: 'Data',
  Shell: 'DevOps',
  Dockerfile: 'DevOps',
  HCL: 'DevOps', // Terraform
};

export function computeScore(analysis: UserAnalysis): ScoredUser {
  const { repos } = analysis;

  const scoredRepos: TopRepositorySummary[] = [];
  let totalScore = 0;
  let aiScore = 0;
  let backendScore = 0;
  let frontendScore = 0;
  let devopsScore = 0;
  let dataScore = 0;

  const skillCounts: Record<string, number> = {};

  for (const repo of repos) {
    const stars = repo.stargazerCount ?? 0;
    const userPRs = repo.mergedPrsByUserCount ?? 0;
    const totalPRs = repo.mergedPrCount ?? 0;

    // Collect skills from contributing repos
    if (userPRs > 0) {
      const repoSkills = new Set<string>();
      if (repo.primaryLanguage) repoSkills.add(repo.primaryLanguage.toLowerCase());
      repo.languages.forEach((l: string) => repoSkills.add(l.toLowerCase()));
      repo.topics.forEach((t: string) => repoSkills.add(t.toLowerCase()));

      repoSkills.forEach((skill) => {
        skillCounts[skill] = (skillCounts[skill] || 0) + 1;
      });
    }

    const score = scoreRepo(stars, userPRs, totalPRs);
    if (score <= 0) continue;

    totalScore += score;

    // Skill Categorization
    const repoCategories = new Set<keyof typeof CATEGORY_MAP>();

    // 1. Check topics
    for (const topic of repo.topics) {
      const lowerTopic = topic.toLowerCase();
      for (const [category, keywords] of Object.entries(CATEGORY_MAP)) {
        if (keywords.includes(lowerTopic)) {
          repoCategories.add(category as keyof typeof CATEGORY_MAP);
        }
      }
    }

    // 2. Check languages if no categories found via topics
    if (repoCategories.size === 0 && repo.primaryLanguage) {
      const hint = LANGUAGE_HINTS[repo.primaryLanguage];
      if (hint) {
        repoCategories.add(hint);
      }
    }

    // Apply score to categories
    if (repoCategories.has('AI')) aiScore += score;
    if (repoCategories.has('Backend')) backendScore += score;
    if (repoCategories.has('Frontend')) frontendScore += score;
    if (repoCategories.has('DevOps')) devopsScore += score;
    if (repoCategories.has('Data')) dataScore += score;

    scoredRepos.push({
      name: repo.name,
      ownerLogin: repo.ownerLogin,
      stars,
      userPRs,
      totalPRs,
      score,
      language: repo.primaryLanguage,
    });
  }

  // Sort by score descending and take top 10
  scoredRepos.sort((a, b) => b.score - a.score);
  const topRepositories = scoredRepos.slice(0, 10);

  // Language breakdown from top repos only
  const languageBreakdown: Record<string, number> = {};
  topRepositories.forEach((repo) => {
    if (repo.language) {
      languageBreakdown[repo.language] = (languageBreakdown[repo.language] ?? 0) + 1;
    }
  });

  // Top 10 skills by frequency
  const uniqueSkills = Object.entries(skillCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([skill]) => skill);

  const experienceLevel = deriveExperienceLevel(totalScore);

  return {
    ...analysis,
    totalScore,
    aiScore,
    backendScore,
    frontendScore,
    devopsScore,
    dataScore,
    topRepositories,
    languageBreakdown,
    uniqueSkills,
    experienceLevel,
  };
}

// =============================================================================
// CONTRIBUTION-FRIENDLINESS SCORE
// =============================================================================
//
// Answers a different question than computeRepoScore: "Is this repo a GOOD
// PLACE TO CONTRIBUTE?" i.e. do PRs get reviewed + merged quickly, is the
// project alive, and is it welcoming to newcomers — independent of any user.
//
// Design: each raw signal is normalized to 0..1, grouped into 5 pillars,
// then combined as a weighted average over ONLY the pillars we have data for
// (missing pillars are dropped and the remaining weights renormalized, so a
// repo is never penalized for gaps in OUR scrape). Hard gates zero out
// archived/disabled/too-small/low-star repos. Result is scaled to 0..100.

/** Pillar weights. Tuned toward "reviewed + merged quickly" being dominant. */
export const CONTRIBUTION_WEIGHTS = {
  responsiveness: 0.3, // time-to-first-review
  throughput: 0.25, // time-to-merge + merge velocity (× backlog penalty)
  acceptance: 0.2, // merge rate × external-contributor ratio
  newcomer: 0.15, // good-first-issues + CONTRIBUTING/CoC
  liveness: 0.1, // recency of pushes + releases
} as const;

/** Tunable gates and normalization targets. */
export const CONTRIBUTION_CONFIG = {
  MIN_STARS: 10, // mirror existing scoreRepo gate
  MIN_MERGED_PRS: 5, // need enough PR history to say anything
  TARGET_FIRST_REVIEW_HOURS: 48, // "good" = reviewed within ~2 days
  TARGET_MERGE_HOURS: 72, // "good" = merged within ~3 days
  VELOCITY_CAP: 50, // merged PRs/month that saturates the velocity term
  GFI_CAP: 20, // good-first + help-wanted issues that saturates
  BACKLOG_HALF: 200, // open-PR count at which throughput is halved
  PUSH_HALFLIFE_DAYS: 90, // recency decay half-life for last push
  RELEASE_HALFLIFE_DAYS: 180, // recency decay half-life for last release
  CONFIDENCE_FULL_SAMPLE: 30, // PR sample size that yields full confidence
} as const;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Lower-is-better time → 0..1. score(target) = 0.5; faster → toward 1. */
function inverseTime(hours: number, targetHours: number): number {
  if (!Number.isFinite(hours) || hours < 0) return 0;
  return 1 / (1 + hours / targetHours);
}

/** Diminishing-returns count → 0..1, saturating at `cap`. */
function logNorm(count: number, cap: number): number {
  if (count <= 0) return 0;
  return clamp01(Math.log1p(count) / Math.log1p(cap));
}

/** Exponential recency decay from a date → 0..1 (1 = just now). */
function recencyDecay(
  iso: string | null,
  halfLifeDays: number,
  nowMs: number
): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.max(0, (nowMs - t) / 86_400_000);
  return Math.pow(0.5, days / halfLifeDays);
}

/**
 * Compute the 0..100 contribution-friendliness score for one repo.
 * `nowMs` is injectable for deterministic testing.
 */
export function computeContributionScore(
  m: RepoHealthMetrics,
  nowMs: number = Date.now()
): ContributionScore {
  const cfg = CONTRIBUTION_CONFIG;

  // --- Hard gates -----------------------------------------------------------
  const gate = (reason: string): ContributionScore => ({
    score: 0,
    responsiveness: null,
    throughput: null,
    acceptance: null,
    newcomer: null,
    liveness: null,
    confidence: 0,
    gatedReason: reason,
  });
  if (m.isArchived) return gate('archived');
  if (m.isDisabled) return gate('disabled');
  if ((m.stars ?? 0) < cfg.MIN_STARS) return gate('below-star-threshold');
  if ((m.mergedPrCount ?? 0) < cfg.MIN_MERGED_PRS) return gate('insufficient-pr-history');

  // --- Pillar 1: Responsiveness (time-to-first-review) ----------------------
  const responsiveness =
    m.medianFirstReviewHours != null
      ? inverseTime(m.medianFirstReviewHours, cfg.TARGET_FIRST_REVIEW_HOURS)
      : null;

  // --- Pillar 2: Throughput (merge speed + velocity) × backlog penalty ------
  let throughput: number | null = null;
  const mergeTimeScore =
    m.medianMergeHours != null
      ? inverseTime(m.medianMergeHours, cfg.TARGET_MERGE_HOURS)
      : null;
  const velocityScore =
    m.mergeVelocityPerMonth != null
      ? logNorm(m.mergeVelocityPerMonth, cfg.VELOCITY_CAP)
      : null;
  if (mergeTimeScore != null || velocityScore != null) {
    const parts: number[] = [];
    if (mergeTimeScore != null) parts.push(0.6 * mergeTimeScore);
    if (velocityScore != null) parts.push(0.4 * velocityScore);
    const weightSum = (mergeTimeScore != null ? 0.6 : 0) + (velocityScore != null ? 0.4 : 0);
    const backlogPenalty = 1 / (1 + (m.openPrCount ?? 0) / cfg.BACKLOG_HALF);
    throughput = clamp01((parts.reduce((a, b) => a + b, 0) / weightSum) * backlogPenalty);
  }

  // --- Pillar 3: Acceptance (merge rate × external ratio) -------------------
  let acceptance: number | null = null;
  if (m.acceptanceRate != null || m.externalMergedRatio != null) {
    const parts: number[] = [];
    let weightSum = 0;
    if (m.acceptanceRate != null) {
      parts.push(0.6 * clamp01(m.acceptanceRate));
      weightSum += 0.6;
    }
    if (m.externalMergedRatio != null) {
      parts.push(0.4 * clamp01(m.externalMergedRatio));
      weightSum += 0.4;
    }
    acceptance = clamp01(parts.reduce((a, b) => a + b, 0) / weightSum);
  }

  // --- Pillar 4: Newcomer-friendliness --------------------------------------
  const gfi = logNorm((m.goodFirstIssues ?? 0) + (m.helpWantedIssues ?? 0), cfg.GFI_CAP);
  const docs = (m.hasContributing ? 0.6 : 0) + (m.hasCodeOfConduct ? 0.4 : 0);
  const newcomer = clamp01(0.6 * gfi + 0.4 * docs);

  // --- Pillar 5: Liveness (recency of push + release) -----------------------
  const pushScore = recencyDecay(m.pushedAt, cfg.PUSH_HALFLIFE_DAYS, nowMs);
  const releaseScore = recencyDecay(m.lastReleaseAt, cfg.RELEASE_HALFLIFE_DAYS, nowMs);
  let liveness: number | null = null;
  if (pushScore != null || releaseScore != null) {
    const parts: number[] = [];
    let weightSum = 0;
    if (pushScore != null) {
      parts.push(0.7 * pushScore);
      weightSum += 0.7;
    }
    if (releaseScore != null) {
      parts.push(0.3 * releaseScore);
      weightSum += 0.3;
    }
    liveness = clamp01(parts.reduce((a, b) => a + b, 0) / weightSum);
  }

  // --- Weighted average over AVAILABLE pillars (renormalized) ---------------
  const pillars: Array<[number | null, number]> = [
    [responsiveness, CONTRIBUTION_WEIGHTS.responsiveness],
    [throughput, CONTRIBUTION_WEIGHTS.throughput],
    [acceptance, CONTRIBUTION_WEIGHTS.acceptance],
    [newcomer, CONTRIBUTION_WEIGHTS.newcomer],
    [liveness, CONTRIBUTION_WEIGHTS.liveness],
  ];
  let weighted = 0;
  let weightSum = 0;
  for (const [value, weight] of pillars) {
    if (value == null) continue;
    weighted += value * weight;
    weightSum += weight;
  }
  const raw = weightSum > 0 ? weighted / weightSum : 0;

  // Confidence: scales with PR sample size and how many pillars had data.
  const sampleConfidence = clamp01((m.sampleSize ?? 0) / cfg.CONFIDENCE_FULL_SAMPLE);
  const coverage = weightSum; // sum of weights present, 0..1
  const confidence = clamp01(0.5 * sampleConfidence + 0.5 * coverage);

  return {
    score: Math.round(raw * 100 * 100) / 100, // 0..100, 2 dp
    responsiveness,
    throughput,
    acceptance,
    newcomer,
    liveness,
    confidence: Math.round(confidence * 100) / 100,
    gatedReason: null,
  };
}
