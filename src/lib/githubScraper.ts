import { gitHubGraphqlClient } from '../github/graphqlClient.js';
import type { User, Repository, PullRequest } from '../types/github.js';

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
interface UserReposResponse extends RateLimitFragment {
  user: {
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
  if (linkedInAccount) return linkedInAccount.url;

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

/**
 * Fetches a GitHub user profile.
 */
export async function fetchGithubUser(username: string): Promise<User> {
  const res = await gitHubGraphqlClient.request<UserResponse>({
    query: GET_USER_QUERY,
    variables: { login: username },
    operationName: 'GetUser',
    useCache: false, // Per requirements: ONLY fetch data from GitHub
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
export async function fetchUserRepositories(username: string): Promise<Repository[]> {
  const res = await gitHubGraphqlClient.request<UserReposResponse>({
    query: GET_USER_REPOS_QUERY,
    variables: { login: username },
    operationName: 'GetUserRepos',
    useCache: false,
  });

  if (!res.user) {
    throw new Error(`User "${username}" not found`);
  }

  const allNodes = [
    ...(res.user.repositories.nodes ?? []),
    ...(res.user.repositoriesContributedTo.nodes ?? []),
  ];

  const uniqueReposMap = new Map<string, Repository>();
  for (const node of allNodes) {
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
        mergedPrsByUserCount: 0, // Placeholder
        topics: node.repositoryTopics.nodes.map((n) => n.topic.name),
        languages: node.languages.nodes.map((n) => n.name),
      });
    }
  }

  return Array.from(uniqueReposMap.values());
}

/**
 * Fetches merged pull requests for a specific repository.
 */
export async function fetchPullRequestsForRepo(owner: string, repo: string): Promise<PullRequest[]> {
  const res = await gitHubGraphqlClient.request<RepoPrsResponse>({
    query: GET_REPO_PRS_QUERY,
    variables: { owner, name: repo },
    operationName: 'GetRepoPrs',
    useCache: false,
  });

  if (!res.repository) {
    throw new Error(`Repository "${owner}/${repo}" not found`);
  }

  return res.repository.pullRequests.nodes.map((node) => ({
    id: node.id,
    url: node.url,
    repoId: `${owner}/${repo}`,
    authorLogin: node.author?.login || 'ghost',
    mergedAt: node.mergedAt || '',
    createdAt: node.createdAt,
  }));
}
