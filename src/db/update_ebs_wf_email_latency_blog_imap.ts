import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';
import { eq } from 'drizzle-orm';

const slug = 'ebs-workflow-email-approval-latency-notification-mailer';

const newSection = `## Critical Notification Mailer IMAP Configuration Checks

Two configuration items in the Notification Mailer are commonly left at their default or incorrect values and cause IMAP inbox degradation that compounds over time. Unlike poll interval or thread count tuning, these are not performance parameters — they are correctness settings. Getting them wrong means the mailer's inbox grows without bound or the mailer crashes when it tries to move a processed message to a folder that does not exist.

### Expunge Inbox on Close

**Where to find it:**
- **11i:** OAM → Workflow Manager → Notification Mailer → Edit → Inbound Email Account
- **R12.1.3:** System Administrator → OAM → Service Components → Workflow Notification Mailer → Edit → Inbound Email Account
- **R12.2.x:** Same navigation as R12.1. Confirm you are editing the configuration on the ICM node's active run edition.

The setting is labelled **Expunge Inbox on Close** (or, in some versions, the parameter \`EXPUNGE_INBOX_ON_CLOSE\` in the service component parameters).

**What it does:**

After each poll cycle, the EBS Notification Mailer closes its IMAP connection to the inbox. When Expunge Inbox on Close is enabled, it sends an IMAP \`EXPUNGE\` command immediately before closing. The EXPUNGE command permanently removes from the inbox all messages that were marked with the IMAP \\Deleted flag during that session — which includes every message the mailer successfully moved to the PROCESSED or DISCARD folder.

When it is disabled, the \`EXPUNGE\` command is never sent. Messages are copied to the PROCESSED or DISCARD folder and flagged for deletion, but the deletion flag is never flushed. The messages remain visible in the inbox on the IMAP server. On the next poll cycle the mailer sees them again, recognises that they have already been processed (because the NID in them was already handled), and skips them — but it still has to read and evaluate each one. Over weeks and months the inbox accumulates thousands of processed messages. Every poll cycle must scan the entire inbox, and the T2→T3 gap grows proportionally with the inbox size even though no actual work is being done on those messages.

**Set this to Yes / enabled on every EBS installation.** There is no valid reason to disable it.

**Verify the current value from the database (R12.1 / R12.2):**

\`\`\`sql
SELECT p.parameter_name,
       v.parameter_value
FROM   fnd_svc_comp_param_vals v
JOIN   fnd_svc_comp_params_vl  p ON v.parameter_id = p.parameter_id
JOIN   fnd_svc_components      c ON v.component_id = c.component_id
WHERE  c.component_type   = 'WF_MAILER'
AND    p.parameter_name   = 'EXPUNGE_INBOX_ON_CLOSE';
\`\`\`

Expected result: \`parameter_value = Y\`. If it returns \`N\` or no row, enable the setting in OAM and restart the mailer component.

**Immediate remediation if disabled:**

Enabling Expunge Inbox on Close going forward does not clean up the messages already accumulated in the inbox. After enabling and restarting the mailer, connect to the EBS IMAP inbox using any standard IMAP client (Thunderbird, Outlook, or a command-line tool such as \`imaptest\`) with the same credentials the mailer uses, and manually delete or move the backlog of already-processed messages. The inbox should contain only genuinely new, unread replies.

### IMAP Folder Structure Verification

The Notification Mailer is configured with three folder parameters:

| Parameter | Purpose |
|-----------|---------|
| \`INBOX_FOLDER\` | The folder the mailer polls for new incoming replies (typically \`INBOX\`) |
| \`PROCESSED_FOLDER\` | Where the mailer moves messages it has successfully parsed and enqueued |
| \`DISCARD_FOLDER\` | Where the mailer moves messages it could not match to a valid Notification ID |

If either the PROCESSED or DISCARD folder does not exist on the IMAP server at the exact path configured in the mailer parameters, the IMAP \`COPY\` command the mailer issues when trying to move a message will return an error. The mailer logs the error, marks the message as failed, and — depending on the error handling configuration — may leave the message in the inbox, stop processing the current batch, or crash the inbound thread entirely. The result is messages piling up in the inbox with no progress.

**Verify folder names configured in the mailer:**

\`\`\`sql
SELECT p.parameter_name,
       v.parameter_value
FROM   fnd_svc_comp_param_vals v
JOIN   fnd_svc_comp_params_vl  p ON v.parameter_id = p.parameter_id
JOIN   fnd_svc_components      c ON v.component_id = c.component_id
WHERE  c.component_type   = 'WF_MAILER'
AND    p.parameter_name   IN ('INBOX_FOLDER', 'PROCESSED_FOLDER', 'DISCARD_FOLDER')
ORDER  BY p.parameter_name;
\`\`\`

**Verify the folders exist on the mail server:**

Using the same IMAP credentials configured in the Notification Mailer, connect to the mail server and list the available folders:

\`\`\`bash
# Using curl (available on most Linux/Unix systems)
curl --silent \
  --url "imaps://mailserver.example.com/" \
  --user "ebsmailer@example.com:<password>" \
  --request "LIST \\"\\\" \\"*\\""

# Using Python (if curl is not available)
python3 -c "
import imaplib
m = imaplib.IMAP4_SSL('mailserver.example.com')
m.login('ebsmailer@example.com', '<password>')
status, folders = m.list()
for f in folders:
    print(f.decode())
m.logout()
"
\`\`\`

Compare the folder names returned against the values of \`PROCESSED_FOLDER\` and \`DISCARD_FOLDER\` in the mailer configuration. IMAP folder names are case-sensitive on most servers — \`Processed\` and \`PROCESSED\` are different folders.

**Common folder naming issues:**

- **Subfolder notation:** Some IMAP servers use \`INBOX/Processed\` while others use \`INBOX.Processed\` (period delimiter). The correct delimiter depends on the IMAP server implementation (Exchange/M365 uses \`/\`, Dovecot defaults to \`.\`). If the mailer is configured with the wrong delimiter, the COPY will fail even though the folder exists.
- **Folder was renamed on the mail server:** If the IT team renamed or restructured IMAP folders without updating the EBS Notification Mailer configuration, all COPY operations for that folder will fail silently from the mail server's perspective (it returns \`NO [TRYCREATE]\`) while the mailer logs an error and leaves the message unprocessed in the inbox.
- **Folder exists but permissions are wrong:** The IMAP account used by EBS must have both read and write access to the PROCESSED and DISCARD folders. If the account was recreated or its mailbox permissions were reset by the mail team, the folders may exist but be inaccessible.

**If the folders are missing, create them:**

On Exchange / Microsoft 365, use the Exchange Admin Center or PowerShell to create the folders in the EBS mailbox. On Dovecot or other IMAP servers, the folders can be created via any IMAP client connected with the EBS mailbox credentials.

After creating or correcting the folders, restart the Notification Mailer and monitor the log for the next poll cycle:

\`\`\`bash
# Confirm the next poll cycle moves messages successfully
grep -i "moved to processed\|moved to discard\|copy.*folder\|error.*folder" \
  \$APPLCSF/\$APPLLOG/FNDCPGSC*.txt | tail -30
\`\`\`

A successful COPY to PROCESSED shows a log entry like:

\`\`\`
[timestamp] Message NID[98765] processed successfully, moved to PROCESSED
\`\`\`

An IMAP folder error shows:

\`\`\`
[timestamp] Error moving message to PROCESSED: NO [TRYCREATE] Folder does not exist
\`\`\`

### Combined Configuration Checklist

Before closing any email approval latency investigation, verify all four Notification Mailer IMAP settings together:

| Setting | Expected value | Where to verify |
|---------|---------------|-----------------|
| \`EXPUNGE_INBOX_ON_CLOSE\` | Y | OAM Edit page; \`fnd_svc_comp_param_vals\` |
| \`INBOX_FOLDER\` | Folder that exists and is readable | IMAP client login with EBS credentials |
| \`PROCESSED_FOLDER\` | Folder that exists and is writable | IMAP client login with EBS credentials |
| \`DISCARD_FOLDER\` | Folder that exists and is writable | IMAP client login with EBS credentials |

All four can be checked in a single OAM session: navigate to the Notification Mailer Edit page, go to the Inbound Email Account section, verify the folder values, confirm Expunge Inbox on Close is checked, save, and restart the component. Then connect to the mailbox with an IMAP client and confirm each folder exists with the exact name and path shown in the configuration.`;

async function main() {
  const [current] = await db
    .select({ content: posts.content })
    .from(posts)
    .where(eq(posts.slug, slug));

  if (!current) {
    console.error('Post not found:', slug);
    process.exit(1);
  }

  const marker = '\n\n---\n\n## Summary\n';
  const insertAt = current.content.lastIndexOf(marker);

  let updatedContent: string;
  if (insertAt === -1) {
    updatedContent = current.content + '\n\n---\n\n' + newSection;
    console.warn('Summary marker not found — section appended at end');
  } else {
    updatedContent =
      current.content.slice(0, insertAt) +
      '\n\n---\n\n' +
      newSection +
      current.content.slice(insertAt);
  }

  await db.update(posts).set({ content: updatedContent }).where(eq(posts.slug, slug));
  console.log('Updated:', slug);
}

main().catch(console.error);
