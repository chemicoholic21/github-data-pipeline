/**
 * Unit tests for the pure scoring functions in src/lib/scoring.ts.
 *
 * Run with:  npm test   (node --import tsx --test test/*.test.ts)
 *
 * These functions are pure (no DB / no network), so we assert exact values
 * wherever the math is deterministic. computeContributionScore takes an
 * injectable nowMs so recency decay is reproducible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRepoScore,
  deriveExperienceLevel,
  computeContributionScore,
} from '../src/lib/scoring.js';
import type { RepoHealthMetrics } from '../src/types/repoHealth.js';

// --- A fixed "now" and a baseline healthy repo for contribution-score tests ---
const NOW = Date.parse('2026-01-01T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function baseMetrics(overrides: Partial<RepoHealthMetrics> = {}): RepoHealthMetrics {
  return {
    fullName: 'acme/widget',
    ownerLogin: 'acme',
    repoName: 'widget',
    description: 'A widget',
    primaryLanguage: 'TypeScript',
    stars: 100,
    forkCount: 10,
    isArchived: false,
    isDisabled: false,
    createdAt: daysAgo(365),
    pushedAt: daysAgo(0),
    lastReleaseAt: null,
    mergedPrCount: 50,
    closedPrCount: 0,
    openPrCount: 0,
    medianFirstReviewHours: 48, // == target -> responsiveness 0.5
    medianMergeHours: 72, // == target -> merge-time score 0.5
    acceptanceRate: 1,
    externalMergedRatio: null,
    mergeVelocityPerMonth: null,
    openIssuesCount: 0,
    goodFirstIssues: 0,
    helpWantedIssues: 0,
    hasContributing: true,
    hasCodeOfConduct: true,
    mentionableUsers: 10,
    sampleSize: 30, // full sample confidence
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeRepoScore: stars × (userPRs / totalPRs), capped at 10_000
// ---------------------------------------------------------------------------
test('computeRepoScore: zero when no total PRs', () => {
  assert.equal(computeRepoScore({ user_prs: 5, total_prs: 0, stars: 100 }), 0);
  assert.equal(computeRepoScore({ user_prs: 5, total_prs: -1, stars: 100 }), 0);
});

test('computeRepoScore: stars × share', () => {
  assert.equal(computeRepoScore({ user_prs: 5, total_prs: 10, stars: 100 }), 50);
  assert.equal(computeRepoScore({ user_prs: 1, total_prs: 4, stars: 200 }), 50);
});

test('computeRepoScore: capped at 10_000', () => {
  assert.equal(computeRepoScore({ user_prs: 1, total_prs: 1, stars: 1_000_000 }), 10_000);
});

test('computeRepoScore: null/undefined stars treated as 0', () => {
  assert.equal(computeRepoScore({ user_prs: 5, total_prs: 10, stars: null }), 0);
  assert.equal(computeRepoScore({ user_prs: 5, total_prs: 10, stars: undefined }), 0);
});

// ---------------------------------------------------------------------------
// deriveExperienceLevel: boundary checks
// ---------------------------------------------------------------------------
test('deriveExperienceLevel: boundaries', () => {
  assert.equal(deriveExperienceLevel(0), 'Newcomer');
  assert.equal(deriveExperienceLevel(9.99), 'Newcomer');
  assert.equal(deriveExperienceLevel(10), 'Contributor');
  assert.equal(deriveExperienceLevel(99), 'Contributor');
  assert.equal(deriveExperienceLevel(100), 'Active Contributor');
  assert.equal(deriveExperienceLevel(499), 'Active Contributor');
  assert.equal(deriveExperienceLevel(500), 'Core Contributor');
  assert.equal(deriveExperienceLevel(1999), 'Core Contributor');
  assert.equal(deriveExperienceLevel(2000), 'Open Source Leader');
  assert.equal(deriveExperienceLevel(100_000), 'Open Source Leader');
});

// ---------------------------------------------------------------------------
// computeContributionScore: hard gates
// ---------------------------------------------------------------------------
test('computeContributionScore: gates archived/disabled/small/thin to 0', () => {
  assert.deepEqual(
    pick(computeContributionScore(baseMetrics({ isArchived: true }), NOW)),
    { score: 0, gatedReason: 'archived' }
  );
  assert.deepEqual(
    pick(computeContributionScore(baseMetrics({ isDisabled: true }), NOW)),
    { score: 0, gatedReason: 'disabled' }
  );
  assert.deepEqual(
    pick(computeContributionScore(baseMetrics({ stars: 9 }), NOW)),
    { score: 0, gatedReason: 'below-star-threshold' }
  );
  assert.deepEqual(
    pick(computeContributionScore(baseMetrics({ mergedPrCount: 4 }), NOW)),
    { score: 0, gatedReason: 'insufficient-pr-history' }
  );
});

function pick(s: { score: number; gatedReason: string | null }) {
  return { score: s.score, gatedReason: s.gatedReason };
}

// ---------------------------------------------------------------------------
// computeContributionScore: deterministic full-coverage math
// ---------------------------------------------------------------------------
test('computeContributionScore: exact score with all pillars present', () => {
  // responsiveness=0.5, throughput=0.5, acceptance=1, newcomer=0.4, liveness=1
  // weighted = .3*.5 + .25*.5 + .2*1 + .15*.4 + .1*1 = .635 -> 63.5
  const s = computeContributionScore(baseMetrics(), NOW);
  assert.equal(s.gatedReason, null);
  assert.equal(s.responsiveness, 0.5);
  assert.equal(s.throughput, 0.5);
  assert.equal(s.acceptance, 1);
  assert.equal(s.newcomer, 0.4);
  assert.equal(s.liveness, 1);
  assert.equal(s.score, 63.5);
  assert.equal(s.confidence, 1); // full sample (30) + full coverage (1.0)
});

test('computeContributionScore: renormalizes over available pillars', () => {
  // Drop responsiveness/throughput/acceptance -> only newcomer(.4)+liveness(1)
  // weighted = .15*.4 + .1*1 = .16 ; weightSum = .25 ; raw = .64 -> 64
  const s = computeContributionScore(
    baseMetrics({
      medianFirstReviewHours: null,
      medianMergeHours: null,
      mergeVelocityPerMonth: null,
      acceptanceRate: null,
      externalMergedRatio: null,
    }),
    NOW
  );
  assert.equal(s.responsiveness, null);
  assert.equal(s.throughput, null);
  assert.equal(s.acceptance, null);
  assert.equal(s.score, 64);
  // confidence = .5*sampleConf(1) + .5*coverage(.25) = .625 -> 0.63
  assert.equal(s.confidence, 0.63);
});

test('computeContributionScore: liveness decays with push age (90d half-life)', () => {
  const s = computeContributionScore(baseMetrics({ pushedAt: daysAgo(90) }), NOW);
  assert.ok(s.liveness !== null);
  assert.ok(Math.abs((s.liveness as number) - 0.5) < 1e-9, `liveness=${s.liveness}`);
});

test('computeContributionScore: score always within 0..100', () => {
  const variants = [
    baseMetrics(),
    baseMetrics({ openPrCount: 5000, medianMergeHours: 0.1, mergeVelocityPerMonth: 1000 }),
    baseMetrics({ acceptanceRate: 1, externalMergedRatio: 1, goodFirstIssues: 999 }),
    baseMetrics({ medianFirstReviewHours: 0, pushedAt: daysAgo(0) }),
  ];
  for (const m of variants) {
    const s = computeContributionScore(m, NOW);
    assert.ok(s.score >= 0 && s.score <= 100, `score out of range: ${s.score}`);
  }
});
