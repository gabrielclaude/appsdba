import { config } from 'dotenv';
config({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import { neon } from '@neondatabase/serverless';
import { classifyPost } from '../lib/classify';

const sql = neon(process.env.DATABASE_URL!);
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID ?? '' },
});

async function generateProblemStatement(title: string, category: string, content: string): Promise<string> {
  const snippet = content.replace(/```[\s\S]*?```/g, '[code block]').slice(0, 1200);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: `You generate a concise "## Problem Statement" section for technical Oracle/middleware blog posts.

Output ONLY the Problem Statement section — no other text before or after.

Format exactly:
## Problem Statement

[1-2 sentences describing the specific problem, error condition, or operational scenario being addressed.]

**Tech Stack:** [comma-separated list of relevant technologies, e.g. Oracle E-Business Suite 12.2, Oracle Database 19c, Oracle WebLogic 12.2.1]
**OS:** [e.g. Oracle Linux 7.x / RHEL 7.x, or "Not specified" if unclear]
**Database Version:** [e.g. Oracle Database 19c (19.3.0+), or "Not specified" if not a DB post]
**Application Version:** [e.g. EBS 12.2.9, GoldenGate 21c, WebLogic 14.1.1, or "Not specified" if unclear]

Rules:
- Be specific and direct — name the error code, symptom, or failure mode if the post addresses one
- Derive versions from the content; if ambiguous use the most likely version for the category
- Tech Stack should list only the components actually discussed in this post`,
    messages: [{
      role: 'user',
      content: `Title: "${title}"
Category: ${category}

Content (first 1200 chars):
${snippet}`,
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
  return text;
}

function insertProblemStatement(content: string, problemStatement: string): string {
  const lines = content.split('\n');

  // Find insertion point: after byline + blank line, before first heading or paragraph
  let insertAt = 0;

  // Skip byline (first line if it starts with "By ")
  if (lines[0]?.startsWith('By ')) {
    insertAt = 1;
    // Skip trailing blank lines after byline
    while (insertAt < lines.length && lines[insertAt].trim() === '') {
      insertAt++;
    }
  }

  const before = lines.slice(0, insertAt).join('\n');
  const after = lines.slice(insertAt).join('\n');

  return before + (before ? '\n\n' : '') + problemStatement + '\n\n' + after;
}

async function main() {
  const posts = await sql`
    SELECT id, title, slug, category, content
    FROM posts
    WHERE published = true
    ORDER BY category, id
  ` as { id: number; title: string; slug: string; category: string; content: string }[];

  const toProcess = posts.filter(p =>
    classifyPost(p.slug, p.title, p.category) === 'problem-solution' &&
    !p.content.includes('## Problem Statement')
  );

  console.log(`${posts.length} total posts. ${toProcess.length} P&S posts need Problem Statement sections.`);

  const CONCURRENCY = 6;
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async (post) => {
      try {
        const ps = await generateProblemStatement(post.title, post.category, post.content);
        if (!ps.includes('## Problem Statement')) {
          throw new Error('Model returned unexpected output');
        }
        const newContent = insertProblemStatement(post.content, ps);
        await sql`UPDATE posts SET content = ${newContent} WHERE id = ${post.id}`;
        processed++;
        if (processed % 10 === 0 || processed <= 5) {
          console.log(`[${processed}/${toProcess.length}] ${post.slug}`);
        }
      } catch (err: any) {
        errors++;
        console.error(`ERROR ${post.slug}: ${err.message ?? err}`);
      }
    }));

    if (i + CONCURRENCY < toProcess.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`\nDone. Processed: ${processed}, Errors: ${errors}`);
}

main().catch(console.error);
