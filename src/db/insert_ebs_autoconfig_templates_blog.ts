import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-autoconfig-appl-top-templates';

const content = `
Oracle E-Business Suite generates virtually every configuration file on the application tier from templates. Apache configuration, TNS descriptors, environment scripts, Forms parameters, WebLogic startup properties — none of these are hand-edited files intended to survive across EBS lifecycle events. They are all the downstream output of a template rendering engine called AutoConfig. The templates live in \`$APPL_TOP\`, and understanding how they work is the difference between a configuration change that sticks and one that gets silently overwritten the next time a DBA runs AutoConfig.

This post explains the template system: where templates live, how they are structured, what drives their rendering, and how to use them correctly for durable configuration changes across EBS 11i, 12.1.3, and 12.2.x.

---

## What AutoConfig Does

AutoConfig is the EBS configuration management tool. When you run AutoConfig, it reads a context file (an XML document describing your installation's parameters — hostnames, ports, SIDs, paths, passwords) and renders each template in \`$APPL_TOP\` into its final configuration file.

The output files are placed in their target locations — Apache conf directories, TNS admin directories, Forms server directories, environment scripts — and the previous versions are overwritten. This means:

- Any hand-edit made directly to a generated file will be lost the next time AutoConfig runs.
- The only durable way to change a generated configuration file is to either change the context file parameter driving the template, or modify the template itself.

AutoConfig runs automatically after every patch applied with adpatch (11i/12.1.3) or adop (12.2.x). It also runs manually when DBAs change context parameters, reconfigure hostnames, or rotate SSL certificates.

---

## Where Templates Live

Templates are stored under \`$APPL_TOP\` and follow a naming convention that mirrors the path of the file they generate. The template extension is \`.tmp\` (or in some cases \`.tmpl\`).

\`\`\`bash
# Find all AutoConfig templates for a product top
find $FND_TOP -name "*.tmp" | head -20

# Find templates for a specific generated file
find $APPL_TOP -name "httpd.conf.tmp"
find $APPL_TOP -name "tnsnames.ora.tmp"
find $APPL_TOP -name "default.env.tmp"
\`\`\`

Common template locations:

| Generated file | Template location |
|---|---|
| \`httpd.conf\` | \`$FND_TOP/admin/template/httpd.conf.tmp\` |
| \`tnsnames.ora\` | \`$FND_TOP/admin/template/tnsnames.ora.tmp\` |
| \`default.env\` | \`$FND_TOP/admin/template/default.env.tmp\` |
| \`APPSORA.env\` | \`$FND_TOP/admin/template/APPSORA.env.tmp\` |
| \`wdbsvr.app\` | \`$FND_TOP/admin/template/wdbsvr.app.tmp\` |

The specific template paths vary by EBS version. In 12.2.x, templates are stored across multiple product tops and may differ between run and patch edition template sets.

---

## Template Syntax

AutoConfig templates use substitution tokens of the form \`%<variable_name>%\`. Each token maps to a parameter in the context file (\`$CONTEXT_FILE\`).

\`\`\`
# Example: a fragment from tnsnames.ora.tmp
%s_dbSid% =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = %s_dbhost%)(PORT = %s_dbport%))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = %s_dbServiceName%)
    )
  )
\`\`\`

When AutoConfig renders this template, it replaces \`%s_dbSid%\`, \`%s_dbhost%\`, \`%s_dbport%\`, and \`%s_dbServiceName%\` with the corresponding values from the context XML.

To find what token controls a specific value, search the template:

\`\`\`bash
grep -n "PARALLEL_EXECUTION_MESSAGE_SIZE" $APPL_TOP/admin/template/*.tmp
grep -n "FORMS_CATCHTERM" $FND_TOP/admin/template/default.env.tmp
\`\`\`

---

## The Context File

The context file is the master data source for all AutoConfig rendering. It is an XML file that contains every configurable parameter for the EBS installation.

\`\`\`bash
# Location of the context file (set automatically when you source the environment)
echo $CONTEXT_FILE

# Or find it manually
find $APPL_TOP/admin -name "*.xml" -maxdepth 2
\`\`\`

A parameter in the context file looks like:

\`\`\`xml
<s_dbhost oa_var="s_dbhost">dbserver1.example.com</s_dbhost>
<s_dbport oa_var="s_dbport">1521</s_dbport>
<s_dbSid oa_var="s_dbSid">EBSPROD</s_dbSid>
\`\`\`

The \`oa_var\` attribute is the token name referenced in templates as \`%s_dbhost%\`.

---

## How to Change a Generated Configuration

### Option 1: Change the context file parameter (preferred)

If the value you want to change is already controlled by a context parameter, update the context file and re-run AutoConfig.

In 11i and 12.1.3, edit the context XML directly (after backing it up):

\`\`\`bash
# Back up first
cp $CONTEXT_FILE $CONTEXT_FILE.bak.$(date +%Y%m%d)

# Edit the relevant parameter with a text editor
vi $CONTEXT_FILE

# Run AutoConfig to regenerate all files
$AD_TOP/bin/adautocfg.sh
\`\`\`

In 12.2.x, use \`txkSetContextParam.pl\` instead of editing the XML directly:

\`\`\`bash
# Safe way to set a context parameter in 12.2.x
perl $FND_TOP/patch/115/bin/txkSetContextParam.pl \
  --contextfile=$CONTEXT_FILE \
  --name=s_forms_catchterm \
  --value=1

# Then run AutoConfig on the run edition
$AD_TOP/bin/adautocfg.sh
\`\`\`

### Option 2: Add a custom token to the template

If the value you need to configure is not yet a parameterised token in the template, you can add a new context variable and reference it in the template. This is appropriate for adding a permanent new configuration entry, such as a custom TNS service descriptor.

\`\`\`bash
# 1. Add the custom value to the context file
# Add between the closing tags of the last existing parameter:
# <s_custom_tns_service oa_var="s_custom_tns_service">MYAPP_SVC</s_custom_tns_service>

# 2. Add the token to the template
# Edit $FND_TOP/admin/template/tnsnames.ora.tmp and append:
# %s_custom_tns_service% =
#   (DESCRIPTION = ...)

# 3. Run AutoConfig — the new entry appears in tnsnames.ora
$AD_TOP/bin/adautocfg.sh
\`\`\`

**Important:** Template files under \`$APPL_TOP\` are product-owned files. They may be overwritten by patches that update the template. If you modify a template, keep a record of your changes so you can reapply them after patches that touch the same template.

### Option 3: Post-AutoConfig hook (12.2.x)

In 12.2.x, you can place shell scripts in \`$AD_TOP/custom/\` that AutoConfig executes after rendering. This is useful for appending entries to generated files without modifying the template itself.

\`\`\`bash
# Create the custom hook directory if it does not exist
mkdir -p $AD_TOP/custom

# Create the hook script
cat > $AD_TOP/custom/post_autoconfig_tns.sh << 'EOF'
#!/bin/bash
# Append custom TNS entries after AutoConfig regenerates tnsnames.ora
TNS_FILE=$TNS_ADMIN/tnsnames.ora
grep -q "MYAPP_SVC" $TNS_FILE || cat >> $TNS_FILE << 'TNSEOF'

MYAPP_SVC =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = appserver.example.com)(PORT = 1521))
    (CONNECT_DATA = (SERVICE_NAME = myapp_service)(ENABLE = BROKEN))
  )
TNSEOF
EOF

chmod +x $AD_TOP/custom/post_autoconfig_tns.sh
\`\`\`

AutoConfig discovers and runs all scripts in \`$AD_TOP/custom/\` at the end of each AutoConfig execution.

---

## Finding Which Template Controls a Given File

Not every generated file comes from a single template. Some are assembled from multiple templates that are concatenated. Use the AutoConfig driver file to trace the relationship:

\`\`\`bash
# The driver file lists all templates and their output targets
less $AD_TOP/admin/driver/adautocfg.drv

# Search for a specific output file
grep "tnsnames.ora" $AD_TOP/admin/driver/adautocfg.drv
grep "httpd.conf" $AD_TOP/admin/driver/adautocfg.drv
\`\`\`

The driver file syntax shows: template path → output file path → permissions. This lets you trace any generated file back to its template source.

---

## Verifying AutoConfig Output

After running AutoConfig, verify the generated files contain the expected values:

\`\`\`bash
# Check that your context parameter change appeared in the output
grep "PARALLEL_EXECUTION_MESSAGE_SIZE" $TNS_ADMIN/tnsnames.ora
grep "FORMS_CATCHTERM" $INST_TOP/ora/10.1.2/forms/server/default.env

# Check AutoConfig log for errors
less $APPL_TOP/admin/$TWO_TASK/log/adconfig.log

# In 12.2.x, logs go to:
less $INST_TOP/admin/log/adconfig.log
\`\`\`

A successful AutoConfig run ends with:

\`\`\`
AutoConfig completed successfully.
\`\`\`

Any line containing \`ERROR\` or \`FAILED\` in the log indicates a template rendering problem, usually a missing or malformed context parameter.

---

## Common Template-Related Problems

### Generated file does not contain the expected value

Cause: the context file has the old value, or the AutoConfig token name is wrong.

\`\`\`bash
# Find the token name in the template
grep -n "EXPECTED_VALUE_PATTERN" $FND_TOP/admin/template/*.tmp

# Check the context file for the corresponding parameter
grep "s_token_name" $CONTEXT_FILE
\`\`\`

### AutoConfig overwrote a hand-edit

Cause: the edit was made directly to a generated file, not to the template or context file.

Resolution: identify the template, add the value as a context parameter or modify the template, re-run AutoConfig.

### Custom template changes lost after a patch

Cause: the patch delivered a new version of the template, overwriting the customisation.

Resolution: keep a patch-safe record of all template modifications. After applying patches that update templates, re-apply customisations and re-run AutoConfig.

\`\`\`bash
# Check if a patch touched a specific template
grep "default.env.tmp" $APPL_TOP/admin/$TWO_TASK/log/adpatch*.log
\`\`\`

---

## Summary

AutoConfig templates in \`$APPL_TOP\` are the authoritative source for every generated configuration file on the EBS application tier. The templates contain substitution tokens (\`%variable%\`) that are resolved from the context XML file at render time. Durable configuration changes must be made either by updating the context file parameter, modifying the template itself, or — in 12.2.x — using a post-AutoConfig hook in \`$AD_TOP/custom/\`. Direct edits to generated files are overwritten on every AutoConfig run. Understanding the template rendering pipeline is essential for any configuration change in EBS that needs to survive patches, cloning, and routine maintenance operations.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Oracle EBS AutoConfig Templates: How $APPL_TOP Templates Drive Every Configuration File',
    slug,
    excerpt: 'Every configuration file on the Oracle EBS application tier — Apache conf, tnsnames.ora, Forms default.env, WebLogic properties — is generated from a template in $APPL_TOP. Direct edits are overwritten on every AutoConfig run. This post explains the template syntax, context file substitution tokens, how to make durable changes using context parameters or the post-AutoConfig hook, and how to trace any generated file back to its template source across EBS 11i, 12.1.3, and 12.2.x.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
