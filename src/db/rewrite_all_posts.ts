import { config } from 'dotenv';
config({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID ?? '' },
});

// ---------------------------------------------------------------------------
// Author roster — 70% male, 30% female, from top 30 global economies
// ---------------------------------------------------------------------------
interface Author {
  name: string;
  country: string;
  gender: 'male' | 'female';
  title: string;
  proseStyle: string;
}

const AUTHORS: Record<string, Author> = {
  rajiv: {
    name: 'Dr. Rajiv Krishnamurthy', country: 'India', gender: 'male', title: 'Dr.',
    proseStyle: 'Authoritative and structured. Opens with first principles before moving to implementation. Uses precise technical language. Sentences are declarative and direct. Favors numbered reasoning chains.',
  },
  james: {
    name: 'Prof. James Hartwell', country: 'USA', gender: 'male', title: 'Prof.',
    proseStyle: 'Practical and case-study driven. Grounds every concept in a production scenario before explaining the theory. Direct, confident prose. Short punchy sentences alternate with longer analytical ones.',
  },
  heinrich: {
    name: 'Dr. Heinrich Braunstein', country: 'Germany', gender: 'male', title: 'Dr.',
    proseStyle: 'Engineering-precise and methodical. Defines terms before using them. Moves systematically from prerequisites to implementation to verification. Avoids ambiguity; prefers explicit over implicit.',
  },
  jeanpierre: {
    name: 'Prof. Jean-Pierre Beaumont', country: 'France', gender: 'male', title: 'Prof.',
    proseStyle: 'Philosophical framing before technical depth. Opens with the conceptual question the technology answers. Rich in analogy. Connects each mechanism to a broader architectural principle.',
  },
  wei: {
    name: 'Dr. Wei Zhong', country: 'China', gender: 'male', title: 'Dr.',
    proseStyle: 'Systematic and pattern-focused. Identifies the class of problem before the specific instance. Prose is concise and tightly reasoned. Enumerates conditions and consequences explicitly.',
  },
  kenji: {
    name: 'Prof. Kenji Watanabe', country: 'Japan', gender: 'male', title: 'Prof.',
    proseStyle: 'Meticulous and example-rich. Every concept is immediately followed by a concrete illustration. Careful about edge cases and failure modes. Prose is measured and never overclaims.',
  },
  anil: {
    name: 'Dr. Anil Mehta', country: 'India', gender: 'male', title: 'Dr.',
    proseStyle: 'Problem-first and analytically sharp. Frames each topic around what breaks and why. Transitions smoothly from diagnostic reasoning to corrective action. Clinical and precise.',
  },
  david: {
    name: 'Prof. David Kowalski', country: 'Poland', gender: 'male', title: 'Prof.',
    proseStyle: 'Rigorous and mathematically inclined. Quantifies wherever possible. Favors formal definitions followed by worked examples. Prose is dense but every sentence carries weight.',
  },
  carlos: {
    name: 'Dr. Carlos Mendez', country: 'Mexico', gender: 'male', title: 'Dr.',
    proseStyle: 'Narrative-driven and context-rich. Opens with the operational reality before the technical solution. Warm but authoritative. Builds intuition through story before introducing formalism.',
  },
  anders: {
    name: 'Prof. Anders Lindqvist', country: 'Sweden', gender: 'male', title: 'Prof.',
    proseStyle: 'Minimalist and principle-focused. Every sentence is load-bearing; nothing decorative. States the core insight plainly, then works outward. Avoids jargon when plain language suffices.',
  },
  ravi: {
    name: 'Dr. Ravi Nair', country: 'India', gender: 'male', title: 'Dr.',
    proseStyle: 'Pragmatic and production-focused. Writes as someone who has operated the system under pressure. Honest about gotchas. Mixes command-level specificity with architectural context.',
  },
  marco: {
    name: 'Prof. Marco Rossi', country: 'Italy', gender: 'male', title: 'Prof.',
    proseStyle: 'Expressive and analogy-rich. Makes complex mechanisms vivid through comparison. Prose flows with natural cadence. Emphasizes the elegance or inelegance of design decisions.',
  },
  yusuf: {
    name: 'Dr. Yusuf Al-Rashid', country: 'Saudi Arabia', gender: 'male', title: 'Dr.',
    proseStyle: 'Structured and authoritative. Organized around explicit phases and checkpoints. Values completeness and leaves no assumption unstated. Formal register throughout.',
  },
  liam: {
    name: 'Prof. Liam O\'Brien', country: 'Ireland', gender: 'male', title: 'Prof.',
    proseStyle: 'Conversational yet rigorous. Engages the reader directly. Uses rhetorical questions to surface the issues a practitioner would actually face. Warm voice without sacrificing precision.',
  },
  park: {
    name: 'Dr. Park Jae-won', country: 'South Korea', gender: 'male', title: 'Dr.',
    proseStyle: 'Systematic and performance-focused. Organizes around measurable outcomes. Connects configuration choices to quantified impact. Clean, efficient prose with no wasted words.',
  },
  arjun: {
    name: 'Prof. Arjun Sharma', country: 'India', gender: 'male', title: 'Prof.',
    proseStyle: 'Theoretical foundation before practical application. Explains the internal mechanism before showing how to manipulate it. Patient and thorough. Good at building layered understanding.',
  },
  robert: {
    name: 'Dr. Robert van den Berg', country: 'Netherlands', gender: 'male', title: 'Dr.',
    proseStyle: 'Pragmatic and cost-aware. Evaluates trade-offs explicitly. Writes for engineers who must justify decisions to management. Clear, functional prose with a results orientation.',
  },
  mehmet: {
    name: 'Prof. Mehmet Yilmaz', country: 'Turkey', gender: 'male', title: 'Prof.',
    proseStyle: 'Scenario-based and diagnostic. Opens with a realistic incident before dissecting the root cause. Transitions naturally from symptom to investigation to resolution.',
  },
  dmitri: {
    name: 'Dr. Dmitri Volkov', country: 'Russia', gender: 'male', title: 'Dr.',
    proseStyle: 'Mathematical and precise. Defines behavior in terms of invariants and constraints. Prose is terse and exact. Favors formal correctness arguments over intuitive explanations.',
  },
  santiago: {
    name: 'Prof. Santiago Rivera', country: 'Argentina', gender: 'male', title: 'Prof.',
    proseStyle: 'Real-world grounded and narrative. Anchors abstractions in concrete enterprise scenarios. Accessible without being simplistic. Builds from the observable to the theoretical.',
  },
  ethan: {
    name: 'Dr. Ethan Williams', country: 'Australia', gender: 'male', title: 'Dr.',
    proseStyle: 'Accessible and example-driven. Prioritizes clarity over comprehensiveness. Uses concrete before abstract. Willing to state the obvious to ensure nothing is assumed.',
  },
  bjorn: {
    name: 'Prof. Björn Eriksson', country: 'Sweden', gender: 'male', title: 'Prof.',
    proseStyle: 'Systematic and operationally focused. Writes in phases with explicit entry and exit conditions. Values repeatability and predictability. Prose is clean and unadorned.',
  },
  // Female authors
  priya: {
    name: 'Prof. Priya Subramaniam', country: 'India', gender: 'female', title: 'Prof.',
    proseStyle: 'Incisive and authoritative. Weaves context before diving into implementation. Surfaces the non-obvious consequences of each decision. Confident without being dismissive of complexity.',
  },
  meiling: {
    name: 'Dr. Mei-Ling Chen', country: 'Singapore', gender: 'female', title: 'Dr.',
    proseStyle: 'Structured and benchmark-driven. Connects every configuration recommendation to measurable outcomes. Precise and economical with language. Anticipates the practitioner\'s next question.',
  },
  sophie: {
    name: 'Prof. Sophie Beaumont', country: 'France', gender: 'female', title: 'Prof.',
    proseStyle: 'Elegant framing with conceptual depth. Opens each topic from first principles, then narrows to implementation. Attentive to the architecture as a whole, not just the component at hand.',
  },
  emma: {
    name: 'Dr. Emma Ashworth', country: 'UK', gender: 'female', title: 'Dr.',
    proseStyle: 'Measured and evidence-based. Makes claims only as strong as the evidence supports. Careful about version differences and environmental caveats. Prose is clear and professionally restrained.',
  },
  fatima: {
    name: 'Prof. Fatima Al-Zahrani', country: 'UAE', gender: 'female', title: 'Prof.',
    proseStyle: 'Structured and formal. Organizes around explicit objectives and success criteria. Values completeness. Connects technical choices to organizational and compliance requirements.',
  },
  ingrid: {
    name: 'Dr. Ingrid Bergström', country: 'Norway', gender: 'female', title: 'Dr.',
    proseStyle: 'Methodical and clear. Works through material in a logical order with no assumed background. Definitions are precise. Comfortable with silence — does not over-explain what the examples show.',
  },
  ana: {
    name: 'Prof. Ana Ferreira', country: 'Brazil', gender: 'female', title: 'Prof.',
    proseStyle: 'Narrative-rich and contextual. Situates technical material within the business processes it serves. Accessible and warm without sacrificing rigor. Good at explaining why a problem matters.',
  },
  yuki: {
    name: 'Dr. Yuki Tanaka', country: 'Japan', gender: 'female', title: 'Dr.',
    proseStyle: 'Precise and systematic. Meticulous about completeness. Surfaces edge cases and failure modes that others overlook. Prose is careful and never ambiguous about scope or assumptions.',
  },
};

// ---------------------------------------------------------------------------
// Category → author pool (max 3). Authors are rotated across posts round-robin.
// ---------------------------------------------------------------------------
const CATEGORY_AUTHORS: Record<string, string[]> = {
  'oracle-database':        ['rajiv', 'james', 'priya'],
  'ebs-suite':              ['anil', 'ravi', 'emma'],
  'weblogic':               ['heinrich', 'kenji'],
  'golden-gate':            ['wei', 'meiling'],
  'disaster-recovery':      ['dmitri', 'park', 'sophie'],
  'rac-clusterware':        ['david', 'robert', 'priya'],
  'ebs-isg':                ['ravi', 'emma'],
  'soa-suite':              ['jeanpierre', 'fatima'],
  'fusion-middleware':      ['heinrich', 'kenji', 'ingrid'],
  'linux-admin':            ['bjorn', 'ethan'],
  'exadata':                ['yusuf', 'park'],
  'essbase':                ['marco', 'ana'],
  'identity-management':    ['arjun', 'david', 'meiling'],
  'golden-gate-problems':   ['wei', 'yuki'],
  'ebs-functional':         ['carlos', 'fatima', 'priya'],
  'postgresql':             ['anders', 'dmitri', 'sophie'],
  'oracle-ml':              ['wei', 'yuki'],
  'exalogic':               ['ravi', 'park'],
  'postgres-ml':            ['anders'],
  'appsdba':                ['james', 'ethan', 'emma'],
  'performance-dw':         ['rajiv', 'meiling'],
  'netsuite':               ['liam', 'ana'],
  'oracle-clinical':        ['arjun', 'yuki'],
  'fusion-cloud-erp':       ['jeanpierre', 'sophie'],
  'oracle-security':        ['yusuf', 'mehmet', 'fatima'],
  'ebs-workflow':           ['ravi', 'anil', 'emma'],
  'oracle-retail':          ['carlos'],
  'oracle-agile':           ['santiago'],
  'oracle-siebel':          ['marco', 'ana'],
  'pharma-clinical-trials': ['arjun', 'ingrid'],
  'sap-hana':               ['heinrich', 'ingrid'],
  'oracle-google-cloud':    ['james', 'ethan', 'priya'],
  'fusion-cloud-scm':       ['jeanpierre'],
  'obiee':                  ['rajiv'],
  'oracle-atg':             ['liam', 'emma'],
  'odoo':                   ['santiago'],
  'otm':                    ['carlos'],
  'docker-oracle':          ['bjorn', 'ethan'],
  'mulesoft':               ['robert'],
  'oracle-cloud-infra':     ['rajiv', 'park'],
};

// ---------------------------------------------------------------------------
// Rewrite a single post's content using Claude
// ---------------------------------------------------------------------------
async function rewritePost(
  title: string,
  content: string,
  author: Author,
): Promise<string> {
  const genderContext = author.gender === 'female'
    ? 'The author is a woman. Her prose style: weaves context before diving in, surfaces non-obvious consequences, balances authority with nuance, and connects technical detail to broader operational implications.'
    : 'The author is a man. His prose style: direct and structured, moves from first principles to implementation, declarative sentences, confident in asserting what must be done and why.';

  const systemPrompt = `You are ${author.name} (${author.title}), a professor and practitioner from ${author.country} rewriting a technical database/middleware blog post for a senior practitioner audience.

${genderContext}

Specific prose style for this author: ${author.proseStyle}

Rules for the rewrite:
1. START with a single rhetorical statement or question that captures the core tension or problem the post addresses. This is the first sentence of the post body — before any heading.
2. Maintain a professor's lecture tone throughout: authoritative, educational, building understanding layer by layer.
3. END with a "## Summary" section that synthesizes the key points and provides 3–5 bullet points of concrete guidance for the practitioner.
4. PRESERVE every code block EXACTLY as-is (SQL, bash, XML, JSON, PL/SQL — all code between triple backtick fences must not be touched).
5. Preserve all section headings (## and ###) exactly as written.
6. Rewrite only the prose paragraphs — the explanatory text between headings and code blocks.
7. Do NOT add a byline — that will be added separately.
8. Do NOT change the technical facts, steps, or recommendations. Only change the prose voice and structure.
9. Keep the total length similar to the original — do not pad or significantly compress.
10. The rhetorical opening statement should NOT be inside a heading — it is a plain paragraph before the first heading.`;

  const userPrompt = `Rewrite the following blog post titled "${title}" according to your author voice and the rules above.\n\n${content}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return text.trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Track which author index to use next per category (round-robin)
  const categoryCounters: Record<string, number> = {};

  // Fetch all published posts ordered by category then id
  const posts = await sql`
    SELECT id, title, slug, category, content
    FROM posts
    WHERE published = true
    ORDER BY category, id
  ` as { id: number; title: string; slug: string; category: string; content: string }[];

  console.log(`Processing ${posts.length} posts…`);

  const CONCURRENCY = 4;
  let processed = 0;
  let errors = 0;

  // Process in batches
  for (let i = 0; i < posts.length; i += CONCURRENCY) {
    const batch = posts.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async (post) => {
      try {
        const pool = CATEGORY_AUTHORS[post.category] ?? ['james'];
        const idx = categoryCounters[post.category] ?? 0;
        const authorKey = pool[idx % pool.length];
        categoryCounters[post.category] = idx + 1;

        const author = AUTHORS[authorKey];
        const byline = `*By ${author.name} — ${author.country}*\n\n`;

        // Strip existing byline if present
        const rawContent = post.content.replace(/^\*By [^\n]+\*\n\n/, '');

        const rewritten = await rewritePost(post.title, rawContent, author);
        const finalContent = byline + rewritten;

        await sql`UPDATE posts SET content = ${finalContent} WHERE id = ${post.id}`;

        processed++;
        console.log(`[${processed}/${posts.length}] ${post.slug} → ${author.name}`);
      } catch (err: any) {
        errors++;
        console.error(`ERROR on ${post.slug}:`, err.message ?? err);
      }
    }));

    // Brief pause between batches to stay within rate limits
    if (i + CONCURRENCY < posts.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\nDone. Processed: ${processed}, Errors: ${errors}`);
}

main().catch(console.error);
