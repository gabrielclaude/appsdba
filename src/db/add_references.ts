import { config } from 'dotenv';
config({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID ?? '' },
});

async function generateReferences(title: string, category: string, contentSnippet: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: `You generate Oracle and related technology documentation reference sections for technical blog posts.
Output ONLY a markdown References section with 4-6 hyperlinks. Use only real, publicly accessible documentation URLs.

Known valid Oracle documentation base URLs:
- Oracle Database 19c: https://docs.oracle.com/en/database/oracle/oracle-database/19/
- Oracle Database 21c: https://docs.oracle.com/en/database/oracle/oracle-database/21/
- Oracle E-Business Suite 12.2: https://docs.oracle.com/cd/E26401_01/
- Oracle WebLogic Server 14c: https://docs.oracle.com/en/middleware/standalone/weblogic-server/14.1.1.0/
- Oracle WebLogic Server 12.2.1: https://docs.oracle.com/middleware/12213/wls/
- Oracle GoldenGate 21c: https://docs.oracle.com/en/middleware/goldengate/core/21.3/
- Oracle Data Guard 19c: https://docs.oracle.com/en/database/oracle/oracle-database/19/sbydb/
- Oracle RAC 19c: https://docs.oracle.com/en/database/oracle/oracle-database/19/racad/
- Oracle Grid Infrastructure 19c: https://docs.oracle.com/en/database/oracle/oracle-database/19/cwlin/
- Oracle ASM 19c: https://docs.oracle.com/en/database/oracle/oracle-database/19/ostmg/
- Oracle Exadata: https://docs.oracle.com/en/engineered-systems/exadata-database-machine/dbmso/
- Oracle Essbase 21c: https://docs.oracle.com/en/database/oracle/essbase/21/
- Oracle Identity Manager: https://docs.oracle.com/en/middleware/idm/identity-governance/12.2.1.4/
- Oracle Access Manager: https://docs.oracle.com/en/middleware/idm/access-manager/12.2.1.4/
- Oracle SOA Suite 12c: https://docs.oracle.com/middleware/12213/soasuite/
- Oracle Fusion Middleware 12c: https://docs.oracle.com/middleware/12213/
- Oracle OCI: https://docs.oracle.com/en-us/iaas/Content/home.htm
- Oracle Linux: https://docs.oracle.com/en/operating-systems/oracle-linux/
- PostgreSQL 16: https://www.postgresql.org/docs/16/
- Oracle OBIEE 12c: https://docs.oracle.com/middleware/12213/biee/
- Oracle Fusion Cloud ERP: https://docs.oracle.com/en/cloud/saas/financials/
- Oracle NetSuite: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/
- Oracle Siebel CRM: https://docs.oracle.com/cd/E14004_01/
- Oracle OTM: https://docs.oracle.com/en/applications/supply-chain-management/transportation-management/
- SAP HANA: https://help.sap.com/docs/SAP_HANA_PLATFORM
- MuleSoft: https://docs.mulesoft.com/
- Oracle OCI Documentation: https://docs.oracle.com/en-us/iaas/

Output format (exactly):
## References

- [Descriptive link title](URL)
- [Descriptive link title](URL)
...

No other text before or after. 4-6 links only.`,
    messages: [{
      role: 'user',
      content: `Blog post title: "${title}"
Category: ${category}
Content snippet: ${contentSnippet}

Generate the References section.`,
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return '\n\n' + text.trim();
}

async function main() {
  const posts = await sql`
    SELECT id, title, slug, category, content
    FROM posts
    WHERE published = true
    ORDER BY category, id
  ` as { id: number; title: string; slug: string; category: string; content: string }[];

  const toProcess = posts.filter(p => !p.content.includes('## References'));
  console.log(`${posts.length} total posts. ${toProcess.length} need References sections.`);

  const CONCURRENCY = 6;
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async (post) => {
      try {
        const snippet = post.content.slice(0, 600).replace(/```[\s\S]*?```/g, '').trim();
        const refs = await generateReferences(post.title, post.category, snippet);
        const newContent = post.content + refs;

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
