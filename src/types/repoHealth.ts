/**
 * Types for repository "contribution-friendliness" health signals.
 *
 * These capture how good a repository is to CONTRIBUTE to (does a PR get
 * reviewed + merged quickly, is the project alive, is it welcoming to
 * newcomers) — as opposed to the existing user-impact `repoScore`
 * (stars × userPRs/totalPRs), which measures how much a given user
 * contributed to a repo.
 */

/** Raw, un-normalized health metrics scraped per repository. */
export interface RepoHealthMetrics {
  fullName: string; // "owner/repo"
  ownerLogin: string;
  repoName: string;
  description: string | null; // GitHub "About" text
  primaryLanguage: string | null;
  stars: number;
  forkCount: number;

  // Liveness / gates
  isArchived: boolean;
  isDisabled: boolean;
  createdAt: string | null; // ISO, when the repo was created
  pushedAt: string | null; // ISO
  lastReleaseAt: string | null; // ISO, null if no releases

  // PR throughput / acceptance
  mergedPrCount: number; // repo-wide totalCount
  closedPrCount: number; // closed-without-merge totalCount
  openPrCount: number; // open backlog totalCount

  /** Median hours from PR open -> first review (null if not measurable). */
  medianFirstReviewHours: number | null;
  /** Median hours from PR open -> merge (null if not measurable). */
  medianMergeHours: number | null;
  /** merged / (merged + closed-unmerged), 0..1 (null if no signal). */
  acceptanceRate: number | null;
  /** Fraction of recently-merged PRs authored by non-owners, 0..1. */
  externalMergedRatio: number | null;
  /** Recently-merged PRs per month, estimated from the sampled window. */
  mergeVelocityPerMonth: number | null;

  // Newcomer-friendliness
  openIssuesCount: number;
  goodFirstIssues: number;
  helpWantedIssues: number;
  hasContributing: boolean;
  hasCodeOfConduct: boolean;
  mentionableUsers: number;

  /** How many recent PRs were analyzed for the medians (confidence). */
  sampleSize: number;
}

/** Per-pillar sub-scores (each 0..1) plus the combined score. */
export interface ContributionScore {
  /** 0..100 combined contribution-friendliness score. */
  score: number;
  responsiveness: number | null;
  throughput: number | null;
  acceptance: number | null;
  newcomer: number | null;
  liveness: number | null;
  /** 0..1 confidence based on PR sample size / data completeness. */
  confidence: number;
  /** Human-readable reason when score is gated to 0 (archived, etc). */
  gatedReason: string | null;
}
