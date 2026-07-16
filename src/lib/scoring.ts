import type { RepoHealthMetrics, ContributionScore } from '../types/repoHealth.js';

export type ExperienceLevel =
  | 'Newcomer'
  | 'Contributor'
  | 'Active Contributor'
  | 'Core Contributor'
  | 'Open Source Leader';

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

export function deriveExperienceLevel(totalScore: number): ExperienceLevel {
  if (totalScore < 10) return 'Newcomer';
  if (totalScore < 100) return 'Contributor';
  if (totalScore < 500) return 'Active Contributor';
  if (totalScore < 2000) return 'Core Contributor';
  return 'Open Source Leader';
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
  MIN_STARS: 10, // ignore repos below this star count
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
function recencyDecay(iso: string | null, halfLifeDays: number, nowMs: number): number | null {
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
    m.medianMergeHours != null ? inverseTime(m.medianMergeHours, cfg.TARGET_MERGE_HOURS) : null;
  const velocityScore =
    m.mergeVelocityPerMonth != null ? logNorm(m.mergeVelocityPerMonth, cfg.VELOCITY_CAP) : null;
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
