import { gitHubGraphqlClient } from '../github/graphqlClient.js';
import { getCachedUser, setCachedUser, getOrSetCache, cacheStats } from './cache.js';
import type { UserAnalysis } from '../types/github.js';
import type { User, Repository, LanguageBreakdown } from '../types/github.js';

export type { User, Repository, LanguageBreakdown, UserAnalysis };

const CACHE_STALE_TIME_MS = 30 * 24 * 60 * 60 * 1000;

interface RateLimitFragment {
  rateLimit: {
    remaining: number;
    cost: number;
  };
}

interface UserAnalysisResponse extends RateLimitFragment {
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
    repositories: {
      nodes: Array<{
        name: string;
        owner: { login: string };
        stargazerCount: number;
        primaryLanguage: { name: string } | null;
        pushedAt: string | null;
        isFork: boolean;
        pullRequests: { totalCount: number };
        repositoryTopics: {
          nodes: Array<{ topic: { name: string } }>;
        };
        languages: {
          nodes: Array<{ name: string }>;
        };
      }>;
    };
    repositoriesContributedTo: {
      nodes: Array<{
        name: string;
        owner: { login: string };
        stargazerCount: number;
        primaryLanguage: { name: string } | null;
        pushedAt: string | null;
        isFork: boolean;
        pullRequests: { totalCount: number };
        repositoryTopics: {
          nodes: Array<{ topic: { name: string } }>;
        };
        languages: {
          nodes: Array<{ name: string }>;
        };
      }>;
    };
  };
}

interface SearchResponse extends RateLimitFragment {
  search: {
    nodes: Array<{
      repository: {
        owner: { login: string };
        name: string;
      } | null;
    }>;
  };
}

const USER_ANALYSIS_QUERY = `
  query UserAnalysis($login: String!) {
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
      repositories(
        first: 50
        orderBy: { field: STARGAZERS, direction: DESC }
        ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      ) {
        nodes {
          name
          owner { login }
          stargazerCount
          primaryLanguage { name }
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
          stargazerCount
          primaryLanguage { name }
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

const SEARCH_MERGED_PRS_QUERY = `
  query SearchMergedPrs($searchQuery: String!) {
    search(query: $searchQuery, type: ISSUE, first: 100) {
      nodes {
        ... on PullRequest {
          repository {
            owner { login }
            name
          }
        }
      }
    }
  }
`;

// Helper to extract LinkedIn URL
const extractLinkedIn = (
  socialAccounts: Array<{ provider: string; url: string }> | undefined,
  bio: string | null,
  websiteUrl: string | null
): string | null => {
  // 1. Check social accounts
  const linkedInAccount = socialAccounts?.find((account) => account.provider === 'LINKEDIN');
  if (linkedInAccount) return linkedInAccount.url;

  // 2. Fallback to regex in bio or website
  const linkedinRegex = /(?:linkedin\.com\/in\/|lnkd\.in\/)([a-zA-Z0-9_-]+)/i;
  if (bio) {
    const match = bio.match(linkedinRegex);
    if (match) return `https://linkedin.com/in/${match[1]}`;
  }
  if (websiteUrl) {
    const match = websiteUrl.match(linkedinRegex);
    if (match) return `https://linkedin.com/in/${match[1]}`;
  }

  return null;
};

export async function fetchUserAnalysis(username: string): Promise<UserAnalysis> {
  return getOrSetCache(username, async () => {
    const cached = await getCachedUser(username);
    if (cached) {
      console.log(`[Cache] HIT for ${username}`);
      return cached;
    }

    console.log(`[Cache] MISS for ${username}, fetching from GitHub API`);
    cacheStats.misses++;

    try {
      // Fetch user analysis data using the centralized client with caching
      const userRes = await gitHubGraphqlClient.request<UserAnalysisResponse>({
        query: USER_ANALYSIS_QUERY,
        variables: { login: username },
        operationName: 'UserAnalysis',
        useCache: true,
        cacheTTL: 2592000, // 30 days
      });

      if (!userRes.user) {
        throw new Error(`User "${username}" not found`);
      }

      const user = userRes.user;

      // Combine owned repos and repos contributed to
      const allRepoNodes = [
        ...(user.repositories.nodes ?? []),
        ...(user.repositoriesContributedTo.nodes ?? []),
      ];

      // Deduplicate by full name
      const uniqueReposMap = new Map<string, Repository>();
      for (const node of allRepoNodes) {
        const fullName = `${node.owner.login}/${node.name}`;
        if (!uniqueReposMap.has(fullName)) {
          uniqueReposMap.set(fullName, {
            name: node.name,
            ownerLogin: node.owner.login,
            stargazerCount: node.stargazerCount,
            primaryLanguage: node.primaryLanguage?.name ?? null,
            pushedAt: node.pushedAt,
            isFork: node.isFork,
            mergedPrCount: node.pullRequests.totalCount,
            mergedPrsByUserCount: 0, // Will be filled below
            topics: node.repositoryTopics.nodes.map(
              (n: { topic: { name: string } }) => n.topic.name
            ),
            languages: node.languages.nodes.map((n: { name: string }) => n.name),
          });
        }
      }

      const repos = Array.from(uniqueReposMap.values());

      // Search for user's merged PRs in qualifying repos (≥10 stars)
      if (repos.length > 0) {
        const qualifyingRepos = repos.filter((r) => r.stargazerCount >= 10);

        if (qualifyingRepos.length > 0) {
          const repoQueries = qualifyingRepos
            .slice(0, 50) // Limit to avoid huge query strings
            .map((r) => `repo:${r.ownerLogin}/${r.name}`);

          const searchQuery = `${repoQueries.join(' ')} is:pr is:merged author:${username}`;

          const searchRes = await gitHubGraphqlClient.request<SearchResponse>({
            query: SEARCH_MERGED_PRS_QUERY,
            variables: { searchQuery },
            operationName: 'SearchMergedPrs',
            useCache: true,
            cacheTTL: 2592000,
          });

          // Count PRs per repository
          const countsByRepo = new Map<string, number>();
          for (const node of searchRes.search.nodes) {
            if (!node.repository) continue;
            const key = `${node.repository.owner.login}/${node.repository.name}`;
            countsByRepo.set(key, (countsByRepo.get(key) ?? 0) + 1);
          }

          // Update repos with user's PR counts
          for (const r of repos) {
            const key = `${r.ownerLogin}/${r.name}`;
            r.mergedPrsByUserCount = countsByRepo.get(key) ?? 0;
          }
        }
      }

      // Calculate language breakdown from all repos
      const languageBreakdown: LanguageBreakdown = {};
      repos.forEach((repo) => {
        if (repo.primaryLanguage) {
          languageBreakdown[repo.primaryLanguage] =
            (languageBreakdown[repo.primaryLanguage] || 0) + 1;
        }
      });

      // Calculate contribution count (total merged PRs by user)
      const contributionCount = repos.reduce((sum, repo) => sum + repo.mergedPrsByUserCount, 0);

      // Extract unique skills from languages and topics
      const uniqueSkills = Array.from(
        new Set(
          [
            ...repos.flatMap((repo) => repo.languages.map((l: string) => l.toLowerCase())),
            ...repos.flatMap((repo) => repo.topics.map((t: string) => t.toLowerCase())),
          ].filter(Boolean)
        )
      );

      return {
        user: {
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
          linkedin:
            extractLinkedIn(user.socialAccounts.nodes, user.bio, user.websiteUrl) ?? undefined,
          isHireable: user.isHireable,
          websiteUrl: user.websiteUrl ?? undefined,
          followers: user.followers.totalCount,
          following: user.following.totalCount,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
        repos,
        languageBreakdown,
        contributionCount,
        uniqueSkills,
      };
      await setCachedUser(username, {
        user: {
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
          linkedin:
            extractLinkedIn(user.socialAccounts.nodes, user.bio, user.websiteUrl) ?? undefined,
          isHireable: user.isHireable,
          websiteUrl: user.websiteUrl ?? undefined,
          followers: user.followers.totalCount,
          following: user.following.totalCount,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
        repos,
        languageBreakdown,
        contributionCount,
        uniqueSkills,
      });
      return {
        user: {
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
          linkedin:
            extractLinkedIn(user.socialAccounts.nodes, user.bio, user.websiteUrl) ?? undefined,
          isHireable: user.isHireable,
          websiteUrl: user.websiteUrl ?? undefined,
          followers: user.followers.totalCount,
          following: user.following.totalCount,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
        repos,
        languageBreakdown,
        contributionCount,
        uniqueSkills,
      };
    } catch (error: any) {
      if (error.message?.includes('not found') || error.status === 404) {
        throw new Error(`User ${username} not found`);
      }
      if (error.message?.includes('rate limit') || error.status === 403) {
        throw new Error('rate-limited');
      }
      throw error;
    }
  });
}

// Main function for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , username] = process.argv;
  if (!username) {
    console.error('Usage: tsx src/lib/github.ts <username>');
    process.exit(1);
  }
  fetchUserAnalysis(username)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error('Error:', error.message);
      process.exit(1);
    });
}
