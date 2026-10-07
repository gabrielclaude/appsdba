export type PostType = 'concept' | 'problem-solution';

// Categories where every post is inherently a problem/solution
const PS_CATEGORIES = new Set([
  'golden-gate-problems',
  'appsdba',
]);

// Slug/title keywords that indicate a problem-solution post
const PS_SLUG_KEYWORDS = [
  'runbook',
  'case-study',
  'troubleshoot',
  'incident',
  'contention',
  'corruption',
  'lag',
  'failure',
  'failed',
  'problem',
  'ora-',
  'deadlock',
  'hang',
  'crash',
  'regression',
];

const PS_TITLE_KEYWORDS = [
  'runbook',
  'case study',
  'troubleshoot',
  'incident',
  'contention',
  'corruption',
  'problems',
  'problem',
  '& solutions',
  'and solutions',
  'diagnosing',
  'debugging',
  'resolving',
  'fixing',
  'failed',
  'failure',
  'deadlock',
  'hang ',
  'regression',
  'ora-',
];

export function classifyPost(slug: string, title: string, category: string): PostType {
  if (PS_CATEGORIES.has(category)) return 'problem-solution';

  const s = slug.toLowerCase();
  const t = title.toLowerCase();

  if (PS_SLUG_KEYWORDS.some(kw => s.includes(kw))) return 'problem-solution';
  if (PS_TITLE_KEYWORDS.some(kw => t.includes(kw))) return 'problem-solution';

  return 'concept';
}
