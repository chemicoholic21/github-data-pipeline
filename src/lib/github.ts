import { graphql } from '@octokit/graphql';
import { getBestToken, updateTokenUsage } from './pat-pool';

interface User {
  login: string;
  name?: string;
  avatarUrl?: string;
  url?: string;
  company?: string;
  blog?: string;
  location?: string;
  email?: string;
  bio?: string;
  twitterUsername?: string;
  linkedin?: string;
  isHireable?: boolean;
  websiteUrl?: string;
  followers: number;
  following: number;
  createdAt: string;
  updatedAt: string;
}

interface Repository {
  name: string;
  ownerLogin: string;
  stargazerCount: number;
  primaryLanguage: string | null;
  pushedAt: string | null;
  isFork: boolean;
  mergedPrCount: number;
  mergedPrsByUserCount: number;
  topics: string[];
  languages: string[];
}

interface LanguageBreakdown {
  [language: string]: number;
}

interface UserAnalysis {
  user: User;
  repos: Repository[];
  languageBreakdown: LanguageBreakdown;
  contributionCount: number;
  uniqueSkills: string[];
}

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
    rateLimit { remaining cost }
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
    rateLimit { remaining cost }
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
) => {
  // 1. Check social accounts
  const linkedInAccount = socialAccounts?.find(account => account.provider === 'LINKEDIN');
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
  const tokenData = await getBestToken();

  const client = graphql.defaults({
    headers: {
      authorization: `token ${tokenData.token}`,
    },
  });

  try {
    // Fetch user analysis data
    const userRes = await client<UserAnalysisResponse>(USER_ANALYSIS_QUERY, {
      login: username,
    });

    if (!userRes.user) {
      throw new Error(`User "${username}" not found`);
    }

    const user = userRes.user;

    // Update token usage after first query
    updateTokenUsage(tokenData.token, userRes.rateLimit.remaining, Date.now() + 3600000); // 1 hour from now

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
          topics: node.repositoryTopics.nodes.map(n => n.topic.name),
          languages: node.languages.nodes.map(n => n.name),
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

        const searchQuery = `${repoQueries.join(" ")} is:pr is:merged author:${username}`;

        const searchRes = await client<SearchResponse>(SEARCH_MERGED_PRS_QUERY, {
          searchQuery,
        });

        // Update token usage after second query
        updateTokenUsage(tokenData.token, searchRes.rateLimit.remaining, Date.now() + 3600000);

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
    repos.forEach(repo => {
      if (repo.primaryLanguage) {
        languageBreakdown[repo.primaryLanguage] = (languageBreakdown[repo.primaryLanguage] || 0) + 1;
      }
    });

    // Calculate contribution count (total merged PRs by user)
    const contributionCount = repos.reduce((sum, repo) => sum + repo.mergedPrsByUserCount, 0);

    // Extract unique skills from languages and topics
    const uniqueSkills = Array.from(new Set([
      ...repos.flatMap(repo => repo.languages.map(l => l.toLowerCase())),
      ...repos.flatMap(repo => repo.topics.map(t => t.toLowerCase())),
    ].filter(Boolean)));

    return {
      user: {
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        url: user.url,
        company: user.company,
        blog: user.websiteUrl,
        location: user.location,
        email: user.email,
        bio: user.bio,
        twitterUsername: user.twitterUsername,
        linkedin: extractLinkedIn(user.socialAccounts.nodes, user.bio, user.websiteUrl),
        isHireable: user.isHireable,
        websiteUrl: user.websiteUrl,
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
}