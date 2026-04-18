export interface User {
  login: string;
  name?: string | undefined;
  avatarUrl?: string | undefined;
  url?: string | undefined;
  company?: string | undefined;
  blog?: string | undefined;
  location?: string | undefined;
  email?: string | undefined;
  bio?: string | undefined;
  twitterUsername?: string | undefined;
  linkedin?: string | undefined;
  isHireable?: boolean | undefined;
  websiteUrl?: string | undefined;
  followers: number;
  following: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
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

export interface PullRequest {
  id: string;
  url: string;
  repoId: string; // "owner/name"
  authorLogin: string;
  mergedAt: string;
  createdAt: string;
}

export interface LanguageBreakdown {
  [language: string]: number;
}

export interface UserAnalysis {
  user: User;
  repos: Repository[];
  pullRequests?: PullRequest[];
  languageBreakdown: LanguageBreakdown;
  contributionCount: number;
  uniqueSkills: string[];
}
