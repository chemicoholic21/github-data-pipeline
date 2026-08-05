import { gitHubGraphqlClient } from '../github/graphqlClient.js';
import type { User, Repository, PullRequest } from '../types/github.js';
import type { RepoHealthMetrics, RepoIssue } from '../types/repoHealth.js';

/**
 * Fragment for rate limit information in GraphQL responses
 */
interface RateLimitFragment {
  rateLimit: {
    remaining: number;
    cost: number;
  };
}

/**
 * GitHub User Profile Response
 */
interface UserResponse extends RateLimitFragment {
  user: {
    login: string;
    name: string | null;
    avatarUrl: string;

    url: string;
    bio: string | null;
    followers: { totalCount: number };
    following: { totalCount: number };
    createdAt: string;
    updatedAt: string;
    isHireable: boolean;
    company: string | null;
    websiteUrl: string | null;
    location: string | null;
    email: string;
    twitterUsername: string | null;
    socialAccounts: {
      nodes: Array<{
        provider: string;
        url: string;
      }>;
    };
  };
}

/**
 * GitHub User Repositories Response
 */
interface RepoNode {
  name: string;
  owner: { login: string };
  description: string | null;
  stargazerCount: number;
  forkCount: number;
  primaryLanguage: { name: string } | null;
  createdAt: string | null;
  pushedAt: string | null;
  isFork: boolean;
  pullRequests: { totalCount: number };
  repositoryTopics: {
    nodes: Array<{ topic: { name: string } }>;
  };
  languages: {
    nodes: Array<{ name: string }>;
  };
}

interface UserReposResponse extends RateLimitFragment {
  user: {
    repositories: {
      nodes: Array<RepoNode>;
    };
    repositoriesContributedTo: {
      nodes: Array<RepoNode>;
    };
  };
}

/**
 * GitHub Repository Pull Requests Response
 */
interface RepoPrsResponse extends RateLimitFragment {
  repository: {
    pullRequests: {
      nodes: Array<{
        id: string;
        url: string;
        author: { login: string };
        state: string;
        mergedAt: string | null;
        createdAt: string;
      }>;
    };
  };
}

const GET_USER_QUERY = `
  query GetUser($login: String!) {
    user(login: $login) {
      login
      name
      avatarUrl
      url
      bio
      followers { totalCount }
      following { totalCount }
      createdAt
      updatedAt
      isHireable
      company
      websiteUrl
      location
      email
      twitterUsername
      socialAccounts(first: 10) {
        nodes {
          provider
          url
        }
      }
    }
  }
`;

const GET_USER_REPOS_QUERY = `
  query GetUserRepos($login: String!) {
    user(login: $login) {
      repositories(
        first: 50
        orderBy: { field: STARGAZERS, direction: DESC }
        ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      ) {
        nodes {
          name
          owner { login }
          description
          stargazerCount
          forkCount
          primaryLanguage { name }
          createdAt
          pushedAt
          isFork
          pullRequests(states: [MERGED]) {
            totalCount
          }
          repositoryTopics(first: 10) {
            nodes {
              topic {
                name
              }
            }
          }
          languages(first: 10) {
            nodes {
              name
            }
          }
        }
      }
      repositoriesContributedTo(
        first: 50
        contributionTypes: [PULL_REQUEST]
        orderBy: { field: STARGAZERS, direction: DESC }
      ) {
        nodes {
          name
          owner { login }
          description
          stargazerCount
          forkCount
          primaryLanguage { name }
          createdAt
          pushedAt
          isFork
          pullRequests(states: [MERGED]) {
            totalCount
          }
          repositoryTopics(first: 10) {
            nodes {
              topic {
                name
              }
            }
          }
          languages(first: 10) {
            nodes {
              name
            }
          }
        }
      }
    }
  }
`;

const GET_REPO_PRS_QUERY = `
  query GetRepoPrs($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: 100, states: [MERGED], orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {
          id
          url
          author {
            ... on User {
              login
            }
          }
          state
          mergedAt
          createdAt
        }
      }
    }
  }
`;

/**
 * Helper to extract LinkedIn URL
 */
const extractLinkedIn = (
  socialAccounts: Array<{ provider: string; url: string }> | undefined,
  bio: string | null,
  websiteUrl: string | null
): string | null => {
  const linkedInAccount = socialAccounts?.find((account) => account.provider === 'LINKEDIN');
  if (linkedInAccount) {
    console.log(`[SCRAPER] LinkedIn found via socialAccounts: ${linkedInAccount.url}`);
    return linkedInAccount.url;
  }

  const linkedinRegex = /(?:linkedin\.com\/in\/|lnkd\.in\/)([a-zA-Z0-9_-]+)/i;
  if (bio) {
    const match = bio.match(linkedinRegex);
    if (match) return `https://linkedin.com/in/${match[1]}`;
  }
  if (websiteUrl) {
    const match = websiteUrl.match(linkedinRegex);
    if (match) return `https://linkedin.com/in/${match[1]}`;
  }
  console.log(
    `[SCRAPER] No LinkedIn found for bio="${bio?.slice(0, 80)}" websiteUrl="${websiteUrl}"`
  );
  return null;
};

/**
 * Fetches a GitHub user profile.
 */
export async function fetchGithubUser(username: string, forceRefresh = false): Promise<User> {
  console.log(`[API] Fetching user profile: ${username}`);
  const res = await gitHubGraphqlClient.request<UserResponse>({
    query: GET_USER_QUERY,
    variables: { login: username },
    operationName: 'GetUser',
    useCache: true,
    cacheTTL: 30 * 24 * 60 * 60 * 1000, // 30 days
    forceRefresh,
  });

  if (!res.user) {
    throw new Error(`User "${username}" not found`);
  }

  const { user } = res;
  return {
    login: user.login,
    name: user.name ?? undefined,
    avatarUrl: user.avatarUrl,
    url: user.url,
    company: user.company ?? undefined,
    blog: user.websiteUrl ?? undefined,
    location: user.location ?? undefined,
    email: user.email,
    bio: user.bio ?? undefined,
    twitterUsername: user.twitterUsername ?? undefined,
    linkedin: extractLinkedIn(user.socialAccounts.nodes, user.bio, user.websiteUrl) ?? undefined,
    isHireable: user.isHireable,
    websiteUrl: user.websiteUrl ?? undefined,
    followers: user.followers.totalCount,
    following: user.following.totalCount,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * Fetches repositories a user has contributed to or owns.
 */
export async function fetchUserRepositories(
  username: string,
  forceRefresh = false
): Promise<Repository[]> {
  console.log(`[API] Fetching repositories for: ${username}`);
  const res = await gitHubGraphqlClient.request<UserReposResponse>({
    query: GET_USER_REPOS_QUERY,
    variables: { login: username },
    operationName: 'GetUserRepos',
    useCache: true,
    cacheTTL: 30 * 24 * 60 * 60 * 1000,
    forceRefresh,
  });

  if (!res.user) {
    throw new Error(`User "${username}" not found`);
  }

  const allNodes = [
    ...(res.user?.repositories?.nodes ?? []),
    ...(res.user?.repositoriesContributedTo?.nodes ?? []),
  ];

  const uniqueReposMap = new Map<string, Repository>();
  for (const node of allNodes) {
    if (!node?.owner?.login || !node?.name) continue;
    const fullName = `${node.owner.login}/${node.name}`;
    if (!uniqueReposMap.has(fullName)) {
      uniqueReposMap.set(fullName, {
        name: node.name,
        ownerLogin: node.owner.login,
        description: node.description ?? null,
        stargazerCount: node.stargazerCount ?? 0,
        forkCount: node.forkCount ?? 0,
        primaryLanguage: node.primaryLanguage?.name ?? null,
        createdAt: node.createdAt ?? null,
        pushedAt: node.pushedAt ?? null,
        isFork: node.isFork ?? false,
        mergedPrCount: node.pullRequests?.totalCount ?? 0,
        mergedPrsByUserCount: 0, // Placeholder
        topics: node.repositoryTopics?.nodes?.map((n) => n.topic.name) ?? [],
        languages: node.languages?.nodes?.map((n) => n.name) ?? [],
      });
    }
  }

  return Array.from(uniqueReposMap.values());
}

/**
 * Fetches merged pull requests for a specific repository.
 */
export async function fetchPullRequestsForRepo(
  owner: string,
  repo: string,
  forceRefresh = false
): Promise<PullRequest[]> {
  console.log(`[API] Fetching PRs for: ${owner}/${repo}`);
  const res = await gitHubGraphqlClient.request<RepoPrsResponse>({
    query: GET_REPO_PRS_QUERY,
    variables: { owner, name: repo },
    operationName: 'GetRepoPrs',
    useCache: true,
    cacheTTL: 30 * 24 * 60 * 60 * 1000,
    forceRefresh,
  });

  if (!res.repository) {
    throw new Error(`Repository "${owner}/${repo}" not found`);
  }

  const nodes = res.repository?.pullRequests?.nodes ?? [];
  return nodes.map((node) => ({
    id: node.id,
    url: node.url,
    repoId: `${owner}/${repo}`,
    authorLogin: node.author?.login || 'ghost',
    mergedAt: node.mergedAt || '',
    createdAt: node.createdAt,
  }));
}

// =============================================================================
// REPO HEALTH (contribution-friendliness) SCRAPING
// =============================================================================

interface RepoHealthResponse {
  repository: {
    nameWithOwner: string;
    owner: { login: string };
    name: string;
    isArchived: boolean;
    isDisabled: boolean;
    pushedAt: string | null;
    stargazerCount: number;
    primaryLanguage: { name: string } | null;
    mergedPRs: { totalCount: number };
    closedPRs: { totalCount: number };
    openPRs: { totalCount: number };
    recentPRs: {
      nodes: Array<{
        state: string;
        createdAt: string;
        mergedAt: string | null;
        author: { login: string } | null;
        reviews: { nodes: Array<{ submittedAt: string | null }> };
      }>;
    };
    openIssues: { totalCount: number };
    goodFirstIssues: { totalCount: number };
    helpWanted: { totalCount: number };
    contributing: { __typename: string } | null;
    codeOfConduct: { __typename: string } | null;
    releases: { nodes: Array<{ createdAt: string }> };
    mentionableUsers: { totalCount: number };
  } | null;
}

// One round-trip captures every contribution-friendliness signal for a repo.
// Crucially this is REPO-scoped (not user-scoped) so the PR sample is
// representative of all contributors — not just maintainer self-merges.
const GET_REPO_HEALTH_QUERY = `
  query GetRepoHealth($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      owner { login }
      name
      isArchived
      isDisabled
      pushedAt
      stargazerCount
      primaryLanguage { name }
      mergedPRs: pullRequests(states: MERGED) { totalCount }
      closedPRs: pullRequests(states: CLOSED) { totalCount }
      openPRs: pullRequests(states: OPEN) { totalCount }
      recentPRs: pullRequests(
        first: 50
        states: [MERGED, CLOSED]
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        nodes {
          state
          createdAt
          mergedAt
          author { login }
          reviews(first: 1) { nodes { submittedAt } }
        }
      }
      openIssues: issues(states: OPEN) { totalCount }
      goodFirstIssues: issues(states: OPEN, labels: ["good first issue"]) { totalCount }
      helpWanted: issues(states: OPEN, labels: ["help wanted"]) { totalCount }
      contributing: object(expression: "HEAD:CONTRIBUTING.md") { __typename }
      codeOfConduct: object(expression: "HEAD:CODE_OF_CONDUCT.md") { __typename }
      releases(first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { createdAt }
      }
      mentionableUsers { totalCount }
    }
  }
`;

const HOUR_MS = 3_600_000;

interface RepoGoodFirstIssuesResponse {
  repository: {
    goodFirstIssues: {
      totalCount: number;
      nodes: Array<{
        id: string;
        title: string;
        url: string;
        author: { login: string } | null;
        labels: { nodes: Array<{ name: string }> };
        createdAt: string | null;
      }>;
    };
  } | null;
}

const GET_GOOD_FIRST_ISSUES_QUERY = `
  query GetGoodFirstIssues($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      goodFirstIssues: issues(states: OPEN, labels: ["good first issue"], first: $first) {
        totalCount
        nodes {
          id
          title
          url
          author { login }
          labels(first: 10) { nodes { name } }
          createdAt
        }
      }
    }
  }
`;

export async function fetchGoodFirstIssues(
  owner: string,
  name: string,
  forceRefresh = false
): Promise<RepoIssue[]> {
  console.log(`[API] Fetching good-first issues: ${owner}/${name}`);
  const res = await gitHubGraphqlClient.request<RepoGoodFirstIssuesResponse>({
    query: GET_GOOD_FIRST_ISSUES_QUERY,
    variables: { owner, name, first: 100 },
    operationName: 'GetGoodFirstIssues',
    useCache: true,
    cacheTTL: 3 * 24 * 60 * 60 * 1000, // 3 days
    forceRefresh,
  });

  const repo = res.repository;
  if (!repo) return [];

  return repo.goodFirstIssues.nodes.map((node) => ({
    githubIssueId: node.id,
    title: node.title,
    url: node.url,
    authorLogin: node.author?.login ?? null,
    labels: node.labels.nodes.map((l) => l.name),
    createdAt: node.createdAt,
  }));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1] ?? 0;
    const hi = sorted[mid] ?? 0;
    return (lo + hi) / 2;
  }
  return sorted[mid] ?? null;
}

/**
 * Fetches and derives contribution-friendliness metrics for a single repo.
 *
 * Returns null only if the repository is not found. All derived medians/ratios
 * are null when the sampled PR window can't support them (the scorer treats
 * those pillars as "no data" rather than penalizing the repo).
 */
export async function fetchRepoHealth(
  owner: string,
  name: string,
  forceRefresh = false
): Promise<RepoHealthMetrics | null> {
  console.log(`[API] Fetching repo health: ${owner}/${name}`);
  const res = await gitHubGraphqlClient.request<RepoHealthResponse>({
    query: GET_REPO_HEALTH_QUERY,
    variables: { owner, name },
    operationName: 'GetRepoHealth',
    useCache: true,
    cacheTTL: 7 * 24 * 60 * 60 * 1000, // 7 days — health drifts faster than profiles
    forceRefresh,
  });

  const repo = res.repository;
  if (!repo) return null;

  const ownerLogin = repo.owner?.login ?? owner;
  const recent = repo.recentPRs?.nodes ?? [];

  const mergeHours: number[] = [];
  const firstReviewHours: number[] = [];
  const mergedCreatedAt: number[] = [];
  let mergedInSample = 0;
  let externalMerged = 0;

  for (const pr of recent) {
    const created = Date.parse(pr.createdAt);
    if (Number.isNaN(created)) continue;

    // Time-to-first-review (any PR with a review counts).
    const firstReview = pr.reviews?.nodes?.[0]?.submittedAt;
    if (firstReview) {
      const reviewed = Date.parse(firstReview);
      if (!Number.isNaN(reviewed) && reviewed >= created) {
        firstReviewHours.push((reviewed - created) / HOUR_MS);
      }
    }

    if (pr.state === 'MERGED' && pr.mergedAt) {
      const merged = Date.parse(pr.mergedAt);
      if (!Number.isNaN(merged) && merged >= created) {
        mergeHours.push((merged - created) / HOUR_MS);
        mergedCreatedAt.push(created);
        mergedInSample += 1;
        if (pr.author?.login && pr.author.login !== ownerLogin) externalMerged += 1;
      }
    }
  }

  // Merge velocity: merged PRs in the sample / months the sample spans.
  let mergeVelocityPerMonth: number | null = null;
  if (mergedCreatedAt.length >= 2) {
    const span = Math.max(...mergedCreatedAt) - Math.min(...mergedCreatedAt);
    const months = Math.max(span / (30 * 24 * HOUR_MS), 1 / 30); // floor ~1 day
    mergeVelocityPerMonth = mergedCreatedAt.length / months;
  }

  // Acceptance rate from repo-wide totals (closed = closed-without-merge).
  const merged = repo.mergedPRs?.totalCount ?? 0;
  const closed = repo.closedPRs?.totalCount ?? 0;
  const acceptanceRate = merged + closed > 0 ? merged / (merged + closed) : null;

  return {
    fullName: repo.nameWithOwner ?? `${ownerLogin}/${repo.name}`,
    ownerLogin,
    repoName: repo.name,
    primaryLanguage: repo.primaryLanguage?.name ?? null,
    stars: repo.stargazerCount ?? 0,
    isArchived: repo.isArchived ?? false,
    isDisabled: repo.isDisabled ?? false,
    pushedAt: repo.pushedAt ?? null,
    lastReleaseAt: repo.releases?.nodes?.[0]?.createdAt ?? null,
    mergedPrCount: merged,
    closedPrCount: closed,
    openPrCount: repo.openPRs?.totalCount ?? 0,
    medianFirstReviewHours: median(firstReviewHours),
    medianMergeHours: median(mergeHours),
    acceptanceRate,
    externalMergedRatio: mergedInSample > 0 ? externalMerged / mergedInSample : null,
    mergeVelocityPerMonth,
    openIssuesCount: repo.openIssues?.totalCount ?? 0,
    goodFirstIssues: repo.goodFirstIssues?.totalCount ?? 0,
    helpWantedIssues: repo.helpWanted?.totalCount ?? 0,
    hasContributing: repo.contributing != null,
    hasCodeOfConduct: repo.codeOfConduct != null,
    mentionableUsers: repo.mentionableUsers?.totalCount ?? 0,
    sampleSize: recent.length,
  };
}
