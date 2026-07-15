import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';
import { eq } from 'drizzle-orm';

const slug = 'ebs-workflow-diagnostics-fnd-top-sql-performance';

const newSection = `## Workflow Schema LOB and BLOB Segment Sizes

The standard table size query — checking \`dba_segments\` by segment name — reports only the table segment size and misses a critical second component: LOB segments. Oracle stores large object column values (CLOB, BLOB, NCLOB) in separate LOB segments whose names are system-generated and distinct from the table name. On a Workflow schema that has never been purged, the LOB segments for \`WF_NOTIFICATION_ATTRIBUTES\` and \`WF_ITEM_ATTRIBUTE_VALUES\` frequently exceed their table segments by a factor of ten or more, and a size query that skips LOB segments will dramatically understate how much space the schema is consuming.

### Which WF tables have LOB columns and what they store

**WF_NOTIFICATION_ATTRIBUTES** — stores the rendered notification body: the full HTML or plain-text content of every email notification ever sent. The \`TEXT_VALUE\` and \`CONTENT_VALUE\` columns are CLOB. For HTML-formatted notifications with rich formatting, tables, or embedded images, each row's LOB can be several kilobytes. Multiplied by millions of historical notifications on a large unmanaged installation, this LOB segment is typically the largest single object in the Workflow schema.

**WF_ITEM_ATTRIBUTE_VALUES** — stores all workflow item attribute values. Attributes of type DOCUMENT, BLOB, or CLOB — used to attach files, store XML document snapshots, carry PL/SQL-rendered output, or embed base64-encoded attachments — are stored as LOBs. Each such attribute per workflow item contributes a separate LOB locator and LOB chunk allocation.

**WF_NOTIFICATIONS** — the \`BODY\` and \`BODY_HTML\` columns store the notification message body as CLOB. Even for moderate-length notifications the per-row CLOB size is meaningful, and with millions of rows the aggregate LOB segment is substantial.

**WF_ITEMS** — generally the smallest LOB footprint of the four. Can carry CLOB-type item attributes in custom workflow implementations but is typically close to zero in standard EBS workflows.

### The combined table and LOB size query

\`\`\`sql
SELECT
    t.table_name,
    t.num_rows                                                             AS estimated_rows,
    ROUND((t.blocks * 8192) / 1024 / 1024, 2)                             AS table_size_mb,
    ROUND(NVL(l.lob_size_mb, 0), 2)                                        AS blob_segment_size_mb,
    ROUND(((t.blocks * 8192) / 1024 / 1024) + NVL(l.lob_size_mb, 0), 2)   AS total_combined_mb
FROM
    all_tables t
LEFT JOIN (
    SELECT
        table_name,
        SUM(bytes) / 1024 / 1024 AS lob_size_mb
    FROM
        dba_segments
    WHERE
        segment_type = 'LOBSEGMENT'
        AND owner    = 'APPLSYS'
    GROUP BY
        table_name
) l ON t.table_name = l.table_name
WHERE
    t.owner = 'APPLSYS'
    AND t.table_name IN (
        'WF_NOTIFICATION_ATTRIBUTES',
        'WF_ITEM_ATTRIBUTE_VALUES',
        'WF_NOTIFICATIONS',
        'WF_ITEMS'
    )
ORDER BY
    total_combined_mb DESC;
\`\`\`

The subquery joins against \`dba_segments\` filtered to \`segment_type = 'LOBSEGMENT'\` and sums all LOB chunks allocated for each table. The \`NVL(..., 0)\` handles tables with no LOB columns or tables whose LOB values are all stored inline — Oracle keeps LOB values inline when they are at or below the \`ENABLE STORAGE IN ROW\` threshold (4000 bytes by default), so small attribute values never appear in a separate LOB segment.

### Sample output and interpretation

\`\`\`
TABLE_NAME                   EST_ROWS    TABLE_MB  LOB_MB    TOTAL_MB
---------------------------- ----------- --------- --------- ---------
WF_NOTIFICATION_ATTRIBUTES     4,823,901    412.00  3,840.00  4,252.00
WF_NOTIFICATIONS               1,204,720    289.00    980.00  1,269.00
WF_ITEM_ATTRIBUTE_VALUES       9,312,044    720.00    182.00    902.00
WF_ITEMS                       1,204,720     88.00      0.00     88.00
\`\`\`

**LOB_MB much larger than TABLE_MB:** Normal and expected for \`WF_NOTIFICATION_ATTRIBUTES\`. The table segment stores row metadata (column values, row directory entries) while the LOB segment stores the actual large content. A LOB-to-table ratio of 5:1 or higher is common on installations that have not been purged regularly.

**LOB_MB = 0 for a table:** Either the table has no LOB columns, or all its LOB values are stored inline within the row. \`WF_ITEMS\` typically shows zero or near-zero LOB size in standard EBS configurations.

**Total combined MB in the thousands:** The schema has accumulated years of historical notification and item data. At this scale, the Purge Obsolete Workflow Runtime concurrent program will run for hours. Schedule it with an age threshold (start with items older than 90 days) and repeat weekly rather than running a single all-history purge that locks the schema during business hours.

**Estimated rows not matching expectations:** \`num_rows\` in \`all_tables\` is only updated by \`ANALYZE\` or \`DBMS_STATS\`. On tables that grow rapidly between statistics collections, the figure may be days or weeks stale. For an accurate current count run \`SELECT COUNT(*) FROM applsys.wf_notifications;\` — but note this performs a full table scan and will be slow on a large schema. Use it after a purge to confirm how many rows were removed, not as a routine check.

### Why LOB size matters for purge performance

When the Purge Obsolete Workflow Runtime concurrent program deletes rows from \`WF_NOTIFICATIONS\`, \`WF_NOTIFICATION_ATTRIBUTES\`, and \`WF_ITEMS\`, Oracle must also reclaim the associated LOB chunks. LOB space reclamation marks the chunks as free in the LOB index segment but does not compact or release the allocated extents back to the tablespace immediately. Over time, a LOB segment with heavy insert-delete churn develops significant internal fragmentation — the segment occupies a large amount of space on disk but much of it consists of free LOB chunks that cannot be reused efficiently until the segment is shrunk.

The symptoms of LOB segment fragmentation on the WF schema:
- High logical and physical I/O on WF table scans even when row counts are moderate after a purge
- \`wfitmcnt.sql\` takes longer to run than the row count would predict
- Workflow AQ operations (enqueue and dequeue on \`WF_DEFERRED\` and \`WF_NOTIFICATION_IN\`) show elevated buffer busy waits if the WF LOB tablespace is contended

### Identifying LOB segment names for specific columns

\`\`\`sql
SELECT l.table_name,
       l.column_name,
       l.segment_name,
       s.tablespace_name,
       ROUND(s.bytes / 1024 / 1024, 0) AS allocated_mb
FROM   dba_lobs l
JOIN   dba_segments s ON s.segment_name  = l.segment_name
                     AND s.owner         = l.owner
WHERE  l.owner = 'APPLSYS'
AND    l.table_name IN (
         'WF_NOTIFICATION_ATTRIBUTES',
         'WF_ITEM_ATTRIBUTE_VALUES',
         'WF_NOTIFICATIONS',
         'WF_ITEMS'
       )
ORDER  BY s.bytes DESC;
\`\`\`

This query maps each LOB column to its system-generated segment name and allocated size. Use the segment name returned here to target a specific LOB for shrink or analysis.

### Reclaiming space after a large purge

After running the Purge Obsolete Workflow Runtime concurrent program, re-run the combined size query to confirm the row count and block allocation dropped. If \`total_combined_mb\` remains high despite a large number of deleted rows, the LOB segments need to be explicitly shrunk to release the fragmented free space.

Shrinking a LOB segment requires acquiring a brief DDL lock on the table. Run during a maintenance window and confirm no concurrent manager or Notification Mailer jobs are running against the WF tables.

\`\`\`sql
-- Shrink WF_NOTIFICATION_ATTRIBUTES LOB segments
ALTER TABLE applsys.wf_notification_attributes
  MODIFY LOB (text_value) (SHRINK SPACE CASCADE);

ALTER TABLE applsys.wf_notification_attributes
  MODIFY LOB (content_value) (SHRINK SPACE CASCADE);

-- Shrink WF_NOTIFICATIONS LOB segments
ALTER TABLE applsys.wf_notifications
  MODIFY LOB (body) (SHRINK SPACE CASCADE);

ALTER TABLE applsys.wf_notifications
  MODIFY LOB (body_html) (SHRINK SPACE CASCADE);

-- Shrink WF_ITEM_ATTRIBUTE_VALUES LOB segment
ALTER TABLE applsys.wf_item_attribute_values
  MODIFY LOB (text_value) (SHRINK SPACE CASCADE);
\`\`\`

The \`CASCADE\` keyword also shrinks the associated LOB index segment. Re-run the combined size query and the LOB segment detail query after each shrink to confirm space was reclaimed. On heavily fragmented segments it is not uncommon to recover 50–70% of the LOB segment allocation after a thorough purge and shrink cycle.`;

async function main() {
  const [current] = await db
    .select({ content: posts.content })
    .from(posts)
    .where(eq(posts.slug, slug));

  if (!current) {
    console.error('Post not found:', slug);
    process.exit(1);
  }

  // Insert before the final Summary section
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
