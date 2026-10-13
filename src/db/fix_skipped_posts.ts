import { config } from 'dotenv';
config({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID ?? '' },
});

// Same author roster and category mapping as rewrite_all_posts.ts
interface Author { name: string; country: string; gender: 'male' | 'female'; title: string; proseStyle: string; }

const AUTHORS: Record<string, Author> = {
  rajiv:      { name: 'Rajiv Krishnamurthy', country: 'India',       gender: 'male',   title: 'Dr.',   proseStyle: 'Authoritative and structured. Opens with first principles before moving to implementation. Uses precise technical language. Sentences are declarative and direct. Favors numbered reasoning chains.' },
  james:      { name: 'James Hartwell',       country: 'USA',         gender: 'male',   title: 'Prof.', proseStyle: 'Practical and case-study driven. Grounds every concept in a production scenario before explaining the theory. Direct, confident prose.' },
  heinrich:   { name: 'Heinrich Braunstein',  country: 'Germany',     gender: 'male',   title: 'Dr.',   proseStyle: 'Engineering-precise and methodical. Defines terms before using them. Moves systematically from prerequisites to implementation to verification.' },
  jeanpierre: { name: 'Jean-Pierre Beaumont', country: 'France',      gender: 'male',   title: 'Prof.', proseStyle: 'Philosophical framing before technical depth. Opens with the conceptual question the technology answers. Rich in analogy.' },
  wei:        { name: 'Wei Zhong',            country: 'China',       gender: 'male',   title: 'Dr.',   proseStyle: 'Systematic and pattern-focused. Identifies the class of problem before the specific instance. Prose is concise and tightly reasoned.' },
  kenji:      { name: 'Kenji Watanabe',       country: 'Japan',       gender: 'male',   title: 'Prof.', proseStyle: 'Meticulous and example-rich. Every concept is immediately followed by a concrete illustration. Careful about edge cases and failure modes.' },
  anil:       { name: 'Anil Mehta',           country: 'India',       gender: 'male',   title: 'Dr.',   proseStyle: 'Problem-first and analytically sharp. Frames each topic around what breaks and why. Transitions smoothly from diagnostic reasoning to corrective action.' },
  david:      { name: 'David Kowalski',       country: 'Poland',      gender: 'male',   title: 'Prof.', proseStyle: 'Rigorous and mathematically inclined. Quantifies wherever possible. Favors formal definitions followed by worked examples.' },
  carlos:     { name: 'Carlos Mendez',        country: 'Mexico',      gender: 'male',   title: 'Dr.',   proseStyle: 'Narrative-driven and context-rich. Opens with the operational reality before the technical solution. Warm but authoritative.' },
  anders:     { name: 'Anders Lindqvist',     country: 'Sweden',      gender: 'male',   title: 'Prof.', proseStyle: 'Minimalist and principle-focused. Every sentence is load-bearing; nothing decorative. States the core insight plainly, then works outward.' },
  ravi:       { name: 'Ravi Nair',            country: 'India',       gender: 'male',   title: 'Dr.',   proseStyle: 'Pragmatic and production-focused. Writes as someone who has operated the system under pressure. Honest about gotchas.' },
  marco:      { name: 'Marco Rossi',          country: 'Italy',       gender: 'male',   title: 'Prof.', proseStyle: 'Expressive and analogy-rich. Makes complex mechanisms vivid through comparison.' },
  yusuf:      { name: 'Yusuf Al-Rashid',      country: 'Saudi Arabia',gender: 'male',   title: 'Dr.',   proseStyle: 'Structured and authoritative. Organized around explicit phases and checkpoints.' },
  liam:       { name: 'Liam O\'Brien',        country: 'Ireland',     gender: 'male',   title: 'Prof.', proseStyle: 'Conversational yet rigorous. Engages the reader directly. Uses rhetorical questions to surface the issues a practitioner would actually face.' },
  park:       { name: 'Park Jae-won',         country: 'South Korea', gender: 'male',   title: 'Dr.',   proseStyle: 'Systematic and performance-focused. Organizes around measurable outcomes. Connects configuration choices to quantified impact.' },
  arjun:      { name: 'Arjun Sharma',         country: 'India',       gender: 'male',   title: 'Prof.', proseStyle: 'Theoretical foundation before practical application. Patient and thorough. Good at building layered understanding.' },
  robert:     { name: 'Robert van den Berg',  country: 'Netherlands', gender: 'male',   title: 'Dr.',   proseStyle: 'Pragmatic and cost-aware. Evaluates trade-offs explicitly. Writes for engineers who must justify decisions to management.' },
  mehmet:     { name: 'Mehmet Yilmaz',        country: 'Turkey',      gender: 'male',   title: 'Prof.', proseStyle: 'Scenario-based and diagnostic. Opens with a realistic incident before dissecting the root cause.' },
  dmitri:     { name: 'Dmitri Volkov',        country: 'Russia',      gender: 'male',   title: 'Dr.',   proseStyle: 'Mathematical and precise. Defines behavior in terms of invariants and constraints. Prose is terse and exact.' },
  santiago:   { name: 'Santiago Rivera',      country: 'Argentina',   gender: 'male',   title: 'Prof.', proseStyle: 'Real-world grounded and narrative. Anchors abstractions in concrete enterprise scenarios.' },
  ethan:      { name: 'Ethan Williams',       country: 'Australia',   gender: 'male',   title: 'Dr.',   proseStyle: 'Accessible and example-driven. Prioritizes clarity over comprehensiveness.' },
  bjorn:      { name: 'Björn Eriksson',       country: 'Sweden',      gender: 'male',   title: 'Prof.', proseStyle: 'Systematic and operationally focused. Writes in phases with explicit entry and exit conditions.' },
  priya:      { name: 'Priya Subramaniam',    country: 'India',       gender: 'female', title: 'Prof.', proseStyle: 'Incisive and authoritative. Weaves context before diving into implementation. Surfaces the non-obvious consequences of each decision.' },
  meiling:    { name: 'Mei-Ling Chen',        country: 'Singapore',   gender: 'female', title: 'Dr.',   proseStyle: 'Structured and benchmark-driven. Connects every configuration recommendation to measurable outcomes.' },
  sophie:     { name: 'Sophie Beaumont',      country: 'France',      gender: 'female', title: 'Prof.', proseStyle: 'Elegant framing with conceptual depth. Opens each topic from first principles, then narrows to implementation.' },
  emma:       { name: 'Emma Ashworth',        country: 'UK',          gender: 'female', title: 'Dr.',   proseStyle: 'Measured and evidence-based. Makes claims only as strong as the evidence supports.' },
  fatima:     { name: 'Fatima Al-Zahrani',    country: 'UAE',         gender: 'female', title: 'Prof.', proseStyle: 'Structured and formal. Organizes around explicit objectives and success criteria.' },
  ingrid:     { name: 'Ingrid Bergström',     country: 'Norway',      gender: 'female', title: 'Dr.',   proseStyle: 'Methodical and clear. Works through material in a logical order with no assumed background.' },
  ana:        { name: 'Ana Ferreira',         country: 'Brazil',      gender: 'female', title: 'Prof.', proseStyle: 'Narrative-rich and contextual. Situates technical material within the business processes it serves.' },
  yuki:       { name: 'Yuki Tanaka',          country: 'Japan',       gender: 'female', title: 'Dr.',   proseStyle: 'Precise and systematic. Meticulous about completeness. Surfaces edge cases and failure modes that others overlook.' },
};

const CATEGORY_AUTHORS: Record<string, string[]> = {
  'oracle-database': ['rajiv','james','priya'], 'ebs-suite': ['anil','ravi','emma'],
  'weblogic': ['heinrich','kenji'], 'golden-gate': ['wei','meiling'],
  'disaster-recovery': ['dmitri','park','sophie'], 'rac-clusterware': ['david','robert','priya'],
  'ebs-isg': ['ravi','emma'], 'soa-suite': ['jeanpierre','fatima'],
  'fusion-middleware': ['heinrich','kenji','ingrid'], 'linux-admin': ['bjorn','ethan'],
  'exadata': ['yusuf','park'], 'essbase': ['marco','ana'],
  'identity-management': ['arjun','david','meiling'], 'golden-gate-problems': ['wei','yuki'],
  'ebs-functional': ['carlos','fatima','priya'], 'postgresql': ['anders','dmitri','sophie'],
  'oracle-ml': ['wei','yuki'], 'exalogic': ['ravi','park'],
  'postgres-ml': ['anders'], 'appsdba': ['james','ethan','emma'],
  'performance-dw': ['rajiv','meiling'], 'netsuite': ['liam','ana'],
  'oracle-clinical': ['arjun','yuki'], 'fusion-cloud-erp': ['jeanpierre','sophie'],
  'oracle-security': ['yusuf','mehmet','fatima'], 'ebs-workflow': ['ravi','anil','emma'],
  'oracle-retail': ['carlos'], 'oracle-agile': ['santiago'],
  'oracle-siebel': ['marco','ana'], 'pharma-clinical-trials': ['arjun','ingrid'],
  'sap-hana': ['heinrich','ingrid'], 'oracle-google-cloud': ['james','ethan','priya'],
  'fusion-cloud-scm': ['jeanpierre'], 'obiee': ['rajiv'],
  'oracle-atg': ['liam','emma'], 'odoo': ['santiago'],
  'otm': ['carlos'], 'docker-oracle': ['bjorn','ethan'],
  'mulesoft': ['robert'], 'oracle-cloud-infra': ['rajiv','park'],
};

async function rewritePost(title: string, content: string, author: Author): Promise<string> {
  const genderContext = author.gender === 'female'
    ? 'The author is a woman. Her prose style: weaves context before diving in, surfaces non-obvious consequences, balances authority with nuance.'
    : 'The author is a man. His prose style: direct and structured, moves from first principles to implementation, declarative sentences.';

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    system: `You are ${author.name}, a practitioner from ${author.country} rewriting a technical blog post.
${genderContext}
Prose style: ${author.proseStyle}
Rules:
1. START with a single rhetorical statement or question (plain paragraph, no heading).
2. Maintain a professor's lecture tone throughout.
3. END with a "## Summary" section with 3–5 bullet points.
4. PRESERVE every code block EXACTLY as-is.
5. Preserve all section headings (## and ###) exactly.
6. Rewrite only the prose paragraphs.
7. Do NOT add a byline.
8. Do NOT change technical facts or recommendations.
9. Keep total length similar to original.`,
    messages: [{ role: 'user', content: `Rewrite this post titled "${title}":\n\n${content}` }],
  });
  return response.content[0].type === 'text' ? response.content[0].text.trim() : '';
}

async function main() {
  const posts = await sql`
    SELECT id, title, slug, category, content FROM posts
    WHERE published = true ORDER BY category, id
  ` as { id: number; title: string; slug: string; category: string; content: string }[];

  const toRewrite = posts.filter(p => !p.content.startsWith('By '));
  console.log(`${toRewrite.length} posts need rewriting.`);

  const categoryCounters: Record<string, number> = {};
  let processed = 0, errors = 0;

  for (const post of toRewrite) {
    try {
      const pool = CATEGORY_AUTHORS[post.category] ?? ['james'];
      const idx = categoryCounters[post.category] ?? 0;
      const authorKey = pool[idx % pool.length];
      categoryCounters[post.category] = idx + 1;
      const author = AUTHORS[authorKey];

      // Strip any existing Problem Statement or old byline before rewriting
      const stripped = post.content
        .replace(/^\*By [^\n]+\*\n\n?/, '')
        .replace(/^## Problem Statement[\s\S]*?(?=\n## |\n###|\n[A-Z])/, '');

      const rewritten = await rewritePost(post.title, stripped, author);

      // Clean byline inline: strip title prefix and country
      const byline = `By ${author.name}\n\n`;
      const finalContent = byline + rewritten;

      await sql`UPDATE posts SET content = ${finalContent} WHERE id = ${post.id}`;
      processed++;
      console.log(`[${processed}/${toRewrite.length}] ${post.slug} → ${author.name}`);
    } catch (err: any) {
      errors++;
      console.error(`ERROR ${post.slug}: ${err.message ?? err}`);
    }
  }

  console.log(`\nDone. Processed: ${processed}, Errors: ${errors}`);
}

main().catch(console.error);
