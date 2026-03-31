import { UserAnalysis } from './github';

export type ExperienceLevel =
  | "Newcomer"
  | "Contributor"
  | "Active Contributor"
  | "Core Contributor"
  | "Open Source Leader";

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

function scoreRepo(stars: number, userPRs: number, totalPRs: number): number {
  if (stars < 10) return 0;
  if (totalPRs <= 0) return 0;
  const raw = stars * (userPRs / totalPRs);
  return Math.min(raw, MAX_REPO_SCORE);
}

export function deriveExperienceLevel(totalScore: number): ExperienceLevel {
  if (totalScore < 10) return "Newcomer";
  if (totalScore < 100) return "Contributor";
  if (totalScore < 500) return "Active Contributor";
  if (totalScore < 2000) return "Core Contributor";
  return "Open Source Leader";
}

// Category mapping for skill categorization
const CATEGORY_MAP = {
  AI: ['machine-learning', 'deep-learning', 'ai', 'artificial-intelligence', 'neural-network', 'tensorflow', 'pytorch', 'keras', 'scikit-learn', 'nlp', 'computer-vision'],
  Backend: ['api', 'server', 'backend', 'microservices', 'rest', 'graphql', 'database', 'postgresql', 'mysql', 'mongodb', 'redis', 'docker', 'kubernetes'],
  Frontend: ['frontend', 'react', 'vue', 'angular', 'javascript', 'typescript', 'html', 'css', 'web', 'ui', 'ux'],
  DevOps: ['devops', 'ci-cd', 'automation', 'infrastructure', 'terraform', 'ansible', 'jenkins', 'github-actions', 'docker', 'kubernetes', 'aws', 'azure', 'gcp'],
  Data: ['data', 'analytics', 'big-data', 'data-science', 'sql', 'python', 'r', 'pandas', 'numpy', 'jupyter', 'data-visualization']
};

const LANGUAGE_HINTS: Record<string, keyof typeof CATEGORY_MAP> = {
  'Python': 'AI',
  'R': 'Data',
  'Julia': 'AI',
  'JavaScript': 'Frontend',
  'TypeScript': 'Frontend',
  'Java': 'Backend',
  'C#': 'Backend',
  'Go': 'Backend',
  'Rust': 'Backend',
  'C++': 'Backend',
  'PHP': 'Backend',
  'Ruby': 'Backend',
  'SQL': 'Data',
  'Shell': 'DevOps',
  'Dockerfile': 'DevOps',
  'HCL': 'DevOps' // Terraform
};

export function computeScore(analysis: UserAnalysis): ScoredUser {
  const { user, repos } = analysis;

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
      repo.languages.forEach(l => repoSkills.add(l.toLowerCase()));
      repo.topics.forEach(t => repoSkills.add(t.toLowerCase()));

      repoSkills.forEach(skill => {
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
    if (repoCategories.has("AI")) aiScore += score;
    if (repoCategories.has("Backend")) backendScore += score;
    if (repoCategories.has("Frontend")) frontendScore += score;
    if (repoCategories.has("DevOps")) devopsScore += score;
    if (repoCategories.has("Data")) dataScore += score;

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
  topRepositories.forEach(repo => {
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