import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';
import { eq } from 'drizzle-orm';

const MARKER = '## Version-Specific Notes';

const AUTOCONFIG_TEMPLATES = `\n\n---\n\n## Version-Specific Notes\n\n### EBS 11i (Release 11.5.x)\n\n**Description:** AutoConfig in 11i uses a single APPL_TOP and ORACLE_HOME. Context file is at \$APPL_TOP/admin/<SID>/<context>.xml. Templates are under \$FND_TOP/admin/template/. No post-AutoConfig hook support — use template modification for custom configuration not controlled by a context parameter.\n\n**Action plan:**\n1. Source environment: . \$APPL_TOP/APPSORA.env\n2. Locate context file: echo \$CONTEXT_FILE\n3. Back up: cp \$CONTEXT_FILE \${CONTEXT_FILE}.bak.\$(date +%Y%m%d)\n4. Edit context XML directly to change parameter values.\n5. Run AutoConfig: \$AD_TOP/bin/adautocfg.sh\n6. Verify: grep <expected_value> \$TNS_ADMIN/tnsnames.ora\n\n### EBS 12.1.3\n\n**Description:** AutoConfig in 12.1.3 populates both \$APPL_TOP and \$INST_TOP. Context file is at \$APPL_TOP/admin/<SID>/<context>.xml. Templates cover OHS, OC4J, Forms, and TNS. Direct XML editing of the context file is the standard approach.\n\n**Action plan:**\n1. Source environment: . \$INST_TOP/ora/10.1.2/EBSapps.env\n2. Back up context file: cp \$CONTEXT_FILE \${CONTEXT_FILE}.bak.\$(date +%Y%m%d)\n3. Edit context XML to change parameter values.\n4. Identify correct template: grep <value_to_change> \$FND_TOP/admin/template/*.tmp\n5. Run AutoConfig: \$AD_TOP/bin/adautocfg.sh\n6. Restart affected services (OHS, OC4J, Forms) to pick up changes.\n\n### EBS 12.2.x\n\n**Description:** AutoConfig in 12.2.x must run on both run and patch editions. Use txkSetContextParam.pl for all context edits to avoid breaking edition metadata. Post-AutoConfig hooks in \$AD_TOP/custom/ are the preferred way to add configuration not covered by templates.\n\n**Action plan:**\n1. Source run edition: . \$EBS_DOMAIN_HOME/EBSapps.env run\n2. Set context parameter: perl \$FND_TOP/patch/115/bin/txkSetContextParam.pl --contextfile=\$CONTEXT_FILE --name=<token> --value=<value>\n3. Run AutoConfig on run edition: \$AD_TOP/bin/adautocfg.sh\n4. Source patch edition and repeat: . \$EBS_DOMAIN_HOME/EBSapps.env patch && \$AD_TOP/bin/adautocfg.sh\n5. Verify generated files on both editions contain the expected value.`;

const slugs = [
  'ebs-autoconfig-appl-top-templates',
  'ebs-autoconfig-appl-top-templates-runbook',
];

async function main() {
  for (const slug of slugs) {
    const rows = await db.select({ content: posts.content }).from(posts).where(eq(posts.slug, slug));
    if (!rows.length) { console.log(`MISSING: ${slug}`); continue; }
    if (rows[0].content.includes(MARKER)) { console.log(`SKIP: ${slug}`); continue; }
    await db.update(posts).set({ content: rows[0].content + AUTOCONFIG_TEMPLATES }).where(eq(posts.slug, slug));
    console.log(`UPDATED: ${slug}`);
  }
}

main().catch(console.error);
