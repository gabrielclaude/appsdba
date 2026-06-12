import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'When a CTE Eats 1.5 TB of TEMP: Fixing Oracle Temporary Tablespace Explosion from Unindexed Materialization',
  slug: 'oracle-cte-materialize-temp-tablespace-explosion-fix',
  excerpt:
    'A single CTE query consuming 1.5 TB of Oracle TEMP before crashing: three structural defects — the MATERIALIZE hint forcing unindexed implicit GTT writes, a three-tier UNION ALL building hash join chains that spill when PGA is exhausted, and a misapplied USE_NL on a millions-row result set. Understand why Oracle writes to TEMP at each stage, and how replacing implicit materialization with a physical indexed GTT reduces temporary space consumption by orders of magnitude.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `A query arrives in the DBA's queue with a deceptively simple complaint: it runs for hours and eventually fills the TEMP tablespace — or the environment runs out of storage entirely. The alert shows 1.5 TB of TEMP consumed before the session errors out.

The query itself looks like a well-structured CTE chain. It has hints. It has a hierarchy. It even has comments explaining what each block does. But every one of those features is working against it at the scale this environment operates.

This post dissects the three structural reasons this query destroys TEMP and shows the architectural fix that eliminates the problem.

---

## What Oracle Does With TEMP

Before diagnosing the specific defects, it helps to understand when Oracle reaches for the TEMP tablespace:

1. **Sort operations that exceed PGA sort area:** ORDER BY, GROUP BY, DISTINCT, UNION (non-ALL), and window functions all require sorting. Oracle tries to sort in memory using the PGA work area. When the data exceeds the work area, Oracle writes sort runs to TEMP, merges them later from disk. This is a sort spill.

2. **Hash join build phases that exceed PGA:** Hash joins build an in-memory hash table from the smaller input, then probe it with the larger input. When the build side exceeds the work area, Oracle partitions the hash table to TEMP. Multi-pass hash joins — where neither side fits in memory — can write and re-read TEMP multiple times.

3. **Implicit materialization of CTEs with the \`MATERIALIZE\` hint:** Oracle's CTE optimizer can evaluate a CTE inline (as if it were a subquery expanded at each reference site) or materialize it once into a temporary store. The \`MATERIALIZE\` hint forces the latter, writing the entire CTE result to an internal implicit Global Temporary Table (GTT) in TEMP. This implicit GTT has no indexes.

4. **Large result sets passed between query stages:** In a multi-CTE query, later CTEs consume output from earlier ones. If earlier stages have not been materialized to an indexed structure, each consumer must re-join, re-sort, or re-hash the raw data.

At 1.5 TB, all four of these are happening simultaneously across multiple stages of the same query.

---

## Root Cause 1: The MATERIALIZE Hint Builds an Unindexed Implicit GTT

The \`FND\` CTE block uses \`/*+ MATERIALIZE */\` and pulls data from a primary FINDING table joined against a data dictionary lookup and another GTT:

\`\`\`sql
WITH FND AS (
  /*+ MATERIALIZE */
  SELECT F.FINDING_ID, F.SCORE_SET_ID, F.PARENT_FINDING_ID,
         FTC.CODE, F.LABEL, F.ENTITY_TYPE_ID
  FROM   STUDY.FINDING F
  JOIN   DATADICTIONARY.FINDING_TYPE_CODE FTC ON FTC.FINDING_TYPE_CODE_ID = F.FINDING_TYPE_CODE_ID
  JOIN   DT.GTT_EXTRACT_SCORE_SET SCSFP ON SCSFP.SCORE_SET_ID = F.SCORE_SET_ID
  WHERE  SCSFP.VISIT_ID IS NOT NULL
    AND  F.DELETE_DATE IS NULL
    AND  FTC.CODE IN ('Form', 'Measurement', ...)
)
\`\`\`

The \`MATERIALIZE\` hint does exactly what it says: it forces Oracle to evaluate \`FND\` once and write the entire result into an internal temporary segment in TEMP. The result set here contains millions of rows across all score sets and visit IDs that passed the filters.

**The hidden cost** is that the implicit GTT Oracle creates has no indexes. Zero. It is a heap-organized dump of rows in TEMP with no access structure. Every subsequent CTE that references \`FND\` must perform a full scan of that multi-million-row TEMP segment.

The intent of using \`MATERIALIZE\` — to avoid re-evaluating the FND join multiple times — is correct. The implementation is the problem. The correct solution is a physical GTT with explicit indexes, populated before the main query runs.

---

## Root Cause 2: Three-Tier UNION ALL Builds Cascading Hash Joins Against Unindexed TEMP

The \`FRMF\` CTE references the \`FORMS\` intermediate dataset (which itself is built from FND) three times, creating three join levels:

\`\`\`
FRMF Level 1: FORMS alone                   (Finding level = 1)
FRMF Level 2: FORMS JOIN FND (FNDC)         (Finding level = 2, child nodes)
FRMF Level 3: FORMS JOIN FND (FNDC)
                    JOIN FND (FNDCC)         (Finding level = 3, grandchild nodes)
\`\`\`

Because the FND dataset was written to an unindexed TEMP implicit GTT, joining against it at levels 2 and 3 requires either:
- **Hash join:** Build a hash table in PGA from FND rows, probe it with FORMS rows. At millions of FND rows, this hash table exceeds PGA limits and spills to TEMP. This happens twice — once for FNDC and again for FNDCC.
- **Merge join:** Sort both inputs. Since neither input is indexed or pre-sorted in TEMP, Oracle must sort millions of rows from TEMP, writing sort runs back to TEMP. This amplifies the TEMP consumption further.

The Level 3 branch is the worst case: it performs two hash joins against the same unindexed FND dataset in a single query block. With PGA exhausted from Level 2's hash build, Level 3's joins have almost no memory budget and spill both phases aggressively.

**The total TEMP write pattern:**
1. FND materialization → write millions of rows to TEMP (no indexes)
2. FORMS calculation → full scan of TEMP FND + sort/hash overhead
3. FRMF Level 2 hash join → hash table from TEMP FND spills back to TEMP
4. FRMF Level 3 hash join × 2 → two more hash tables from TEMP FND spill to TEMP
5. Final INSERT stage → merge of all three UNION ALL branches, potentially another sort

Each stage writes to TEMP, and the previous stage's TEMP output becomes the next stage's input. The cascade multiplies the base data size several times over before the final INSERT ever begins.

---

## Root Cause 3: USE_NL on a Millions-Row CTE Result

The final SELECT uses \`/*+ USE_NL(frmf sc) */\` to force a Nested Loop join between the FRMF output and \`STUDY.SCORE\`:

\`\`\`sql
SELECT /*+ USE_NL(frmf sc) */ :B1,
       FRMF.SCORE_SET_ID,
       FRMF.FINDING_ID,
       ...
FROM   FRMF
JOIN   STUDY.SCORE SC ON SC.FINDING_ID = FRMF.FINDING_ID
\`\`\`

Nested Loops work efficiently when the driving side is small and the inner side has an index. If FRMF returns 10 rows, a Nested Loop against \`STUDY.SCORE\` performs 10 indexed lookups — excellent.

If FRMF returns millions of rows across all three UNION ALL branches, the Nested Loop forces millions of individual lookups into \`STUDY.SCORE\`. When \`STUDY.SCORE\` is very large, even indexed lookups accumulate substantial random I/O. More critically, if Oracle's cost estimator determines that the FRMF cardinality makes Nested Loops prohibitively expensive and overrides the hint (which it can in some cases), it falls back to a sort-merge or hash join of the FRMF result against SCORE — adding another massive sort operation to the TEMP workload.

The correct join strategy here is a Hash Join: build a hash table from FRMF, probe it with a single scan of the relevant partition of STUDY.SCORE. Replace \`USE_NL(frmf sc)\` with \`USE_HASH(frmf sc)\` or remove the hint entirely and let the optimizer choose after the upstream defects are fixed.

---

## The Fix: Replace Implicit Materialization With a Physical Indexed GTT

The architectural solution addresses all three problems at their source: replace the unindexed implicit TEMP materialization with a physical Global Temporary Table that has explicit B-tree indexes on every join column.

### Step 1: Create the physical GTT (one-time DDL)

\`\`\`sql
CREATE GLOBAL TEMPORARY TABLE dt.tmp_fnd_extract (
  finding_id           NUMBER,
  score_set_id         NUMBER,
  parent_finding_id    NUMBER,
  finding_type         VARCHAR2(100),
  finding_label        VARCHAR2(4000),
  entity_type_id       NUMBER,
  CONSTRAINT pk_tmp_fnd_extract PRIMARY KEY (finding_id)
) ON COMMIT PRESERVE ROWS;

CREATE INDEX idx_tmp_fnd_parent
  ON dt.tmp_fnd_extract (parent_finding_id, finding_type);

CREATE INDEX idx_tmp_fnd_score_set
  ON dt.tmp_fnd_extract (score_set_id);
\`\`\`

\`ON COMMIT PRESERVE ROWS\` keeps the data for the session's lifetime rather than clearing it at each COMMIT, which is necessary for the two-phase pattern.

**Why the indexes matter:**
- \`PRIMARY KEY (finding_id)\`: the Level 2 and Level 3 joins use \`FINDING_ID = FNDC.PARENT_FINDING_ID\` — a direct key lookup instead of a full scan
- \`(parent_finding_id, finding_type)\`: the most selective join condition in FRMF, now resolved by a range scan instead of a hash join
- \`(score_set_id)\`: the final grouping dimension, allowing index-range scans instead of full scans for per-score-set operations

### Step 2: Populate the GTT cleanly in Phase 1

\`\`\`sql
INSERT INTO dt.tmp_fnd_extract
(finding_id, score_set_id, parent_finding_id, finding_type, finding_label, entity_type_id)
SELECT F.FINDING_ID, F.SCORE_SET_ID, F.PARENT_FINDING_ID,
       FTC.CODE, F.LABEL, F.ENTITY_TYPE_ID
FROM   STUDY.FINDING F
JOIN   DATADICTIONARY.FINDING_TYPE_CODE FTC
       ON FTC.FINDING_TYPE_CODE_ID = F.FINDING_TYPE_CODE_ID
JOIN   DT.GTT_EXTRACT_SCORE_SET SCSFP
       ON SCSFP.SCORE_SET_ID = F.SCORE_SET_ID
WHERE  SCSFP.VISIT_ID IS NOT NULL
  AND  F.DELETE_DATE IS NULL
  AND  FTC.CODE IN ('Form', 'Measurement', 'MaskMeasurement', 'MeasurementGroup',
                    'MeasurementChild', 'XMLGroup', 'ImportGroup', 'ImportChild',
                    'StructuredTableGroup', 'StructuredTableChild',
                    'SupplementalForms', 'GroovyPlugin');
COMMIT;
\`\`\`

This is the same SELECT that was inside the \`MATERIALIZE\` CTE, but now the result lands in an indexed structure. The insert populates the primary key index and both secondary indexes in a single pass — the index overhead at write time is vastly cheaper than the unindexed full-scan overhead paid dozens of times during the subsequent query.

### Step 3: Run the main INSERT referencing the physical GTT (Phase 2)

The main INSERT block is now rewritten to reference \`dt.tmp_fnd_extract\` instead of the inline FND CTE. The \`MATERIALIZE\` hint and the \`USE_NL\` hint are both removed:

\`\`\`sql
INSERT /*+ APPEND */ INTO DT.GTT_EXTRACT_SCORE_VERT
(TRANSFER_ID, SCORE_SET_ID, FINDING_ID, SCORE_TYPE_PATH, MAPPED_LABEL,
 MAPPED_SUB_LABEL, TEXT_VALUE, UNIT_OF_MEASURE_CODE_ID, ENTITY_TYPE_ID, ATTRIBUTE_TYPE_ID)
WITH FORMS AS (
  SELECT FND.FINDING_ID, FND.FINDING_TYPE, FND.FINDING_LABEL,
         FND.PARENT_FINDING_ID, FND.SCORE_SET_ID,
         FND.ENTITY_TYPE_ID AS FORM_ENTITY_TYPE_ID,
         S.FINDING_LABEL AS MAPPED_SUB_LABEL
  FROM   dt.tmp_fnd_extract FND
  LEFT JOIN dt.tmp_fnd_extract S
         ON S.FINDING_ID = FND.PARENT_FINDING_ID
        AND S.finding_type = 'SupplementalForms'
  WHERE  FND.finding_type = 'Form'
    AND  (FND.PARENT_FINDING_ID IS NULL OR S.FINDING_ID IS NOT NULL)
),
FRMF AS (
  SELECT FINDING_ID, 1 AS FINDING_LEVEL, '' AS MAPPED_LABEL,
         FORMS.MAPPED_SUB_LABEL,
         '/' || FORMS.FINDING_LABEL AS FINDING_LABEL_PATH2,
         SCORE_SET_ID, FORM_ENTITY_TYPE_ID
  FROM   FORMS
  UNION ALL
  SELECT FNDC.FINDING_ID, 2 AS FINDING_LEVEL, '' AS MAPPED_LABEL,
         FORMS.MAPPED_SUB_LABEL,
         '/' || FORMS.FINDING_LABEL || '/' || FNDC.FINDING_LABEL AS FINDING_LABEL_PATH2,
         FORMS.SCORE_SET_ID, FORMS.FORM_ENTITY_TYPE_ID
  FROM   FORMS
  JOIN   dt.tmp_fnd_extract FNDC
         ON FORMS.FINDING_ID = FNDC.PARENT_FINDING_ID
        AND FNDC.finding_type IN ('Measurement','MaskMeasurement','MeasurementGroup',
                                  'GroovyPlugin','XMLGroup')
  UNION ALL
  SELECT FNDCC.FINDING_ID, 3 AS FINDING_LEVEL,
         FNDCC.FINDING_LABEL AS MAPPED_LABEL,
         FORMS.MAPPED_SUB_LABEL,
         '/' || FORMS.FINDING_LABEL || '/' || FNDC.FINDING_LABEL AS FINDING_LABEL_PATH2,
         FORMS.SCORE_SET_ID, FORMS.FORM_ENTITY_TYPE_ID
  FROM   FORMS
  JOIN   dt.tmp_fnd_extract FNDC
         ON FORMS.FINDING_ID = FNDC.PARENT_FINDING_ID
        AND FNDC.finding_type IN ('MeasurementGroup','ImportGroup','StructuredTableGroup')
  JOIN   dt.tmp_fnd_extract FNDCC
         ON FNDC.FINDING_ID = FNDCC.PARENT_FINDING_ID
        AND FNDCC.finding_type IN ('MeasurementChild','ImportChild','StructuredTableChild')
)
SELECT :B1,
       FRMF.SCORE_SET_ID, FRMF.FINDING_ID,
       CASE WHEN SC.ATTRIBUTE_TYPE_ID IS NULL
            THEN FINDING_LABEL_PATH2 || '|' || STC.CODE || '|' || SC.LABEL
       END AS SCORE_TYPE_PATH,
       FRMF.MAPPED_LABEL, FRMF.MAPPED_SUB_LABEL,
       TRIM(
         TO_CHAR(SC.DATE_TIME_VALUE,'DD-MON-YYYY HH24:MI:SS') || ' ' ||
         CASE WHEN SC.DECIMAL_VALUE IS NAN OR SC.DECIMAL_VALUE IS NULL
              THEN NULL
              ELSE TO_CHAR(SC.DECIMAL_VALUE,'9999999999.9999999') END || ' ' ||
         TO_CHAR(SC.INTEGER_VALUE,'9999999999999999') || ' ' ||
         CASE WHEN SC.TEXT_VALUE IS NULL THEN ' '
              WHEN LENGTH(SC.TEXT_VALUE) <= 3900 THEN TO_CHAR(SC.TEXT_VALUE)
              WHEN LENGTH(SC.TEXT_VALUE) >  3900
              THEN TO_CHAR(DBMS_LOB.SUBSTR(SC.TEXT_VALUE,3900,1)) END || ' ' ||
         DECODE(SC.BOOLEAN_VALUE,1,'TRUE',0,'FALSE',NULL)
       ) AS TEXT_VALUE,
       SC.UNIT_OF_MEASURE_CODE_ID,
       FRMF.FORM_ENTITY_TYPE_ID,
       SC.ATTRIBUTE_TYPE_ID
FROM   FRMF
JOIN   STUDY.SCORE SC  ON SC.FINDING_ID  = FRMF.FINDING_ID
JOIN   DATADICTIONARY.SCORE_TYPE_CODE STC
                       ON STC.SCORE_TYPE_CODE_ID = SC.SCORE_TYPE_CODE_ID
WHERE  SC.DELETE_DATE IS NULL
  AND  STC.CODE NOT IN ('FormComplete','SliceIndex','Available');

TRUNCATE TABLE dt.tmp_fnd_extract;
\`\`\`

---

## Why This Works

| Stage | Before (MATERIALIZE) | After (Physical GTT) |
|-------|---------------------|----------------------|
| FND population | Full scan → unindexed TEMP GTT | Indexed INSERT → primary key + 2 indexes |
| FORMS build | Full scan of TEMP FND | Index range scan on finding_type = 'Form' |
| FRMF Level 2 join | Hash join of TEMP FND (spills to TEMP) | Index lookup via parent_finding_id + finding_type |
| FRMF Level 3 join | Two hash joins of TEMP FND (both spill) | Two index lookups — stays in memory |
| Final JOIN to SCORE | Forced NL or fallback sort-merge | Hash join with optimizer-chosen strategy |
| TEMP consumed | 1.5 TB (all stages cascade) | Near-zero (indexes eliminate hash spills) |

---

## Storage Array and PGA Considerations

Two infrastructure factors compound the SQL problem and must be addressed in parallel.

**Write-back cache on the storage array:** If the array's write-back cache is disabled or saturated, every TEMP write incurs synchronous latency instead of being buffered. Latencies above 500ms on TEMP writes are a strong indicator that the array is not caching writes — common when the write queue depth is exhausted by a concurrent large batch operation. The 2000ms spikes observed in this environment during the failing query are consistent with direct-to-disk writes bypassing cache. This makes each TEMP spill far more expensive than it would be on a properly configured array.

**PGA work area sizing:** The hash join spills and sort spills happen because the PGA work area is insufficient for the data volume. \`pga_aggregate_target\` governs the total PGA budget for all sessions. In a 2-node RAC environment running large batch INSERTs simultaneously on both nodes, the effective per-session work area is a fraction of \`pga_aggregate_target\`. If both nodes are running this query concurrently, each session's work area budget may be too small to hold even the first hash build phase in memory, forcing spills on every join stage.

The physical GTT fix reduces the data volume exposed to sort/hash operations significantly — index-driven joins do not build hash tables and do not spill. But correctly sizing PGA ensures that the remaining operations (the final SCORE join, the UNION ALL merge) execute in memory rather than spilling.

The companion runbook covers TEMP tablespace diagnosis SQL, PGA configuration analysis, storage latency verification commands, and the complete DDL and deployment sequence.`,
};

async function main() {
  console.log('Inserting CTE TEMP explosion blog post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      category: post.category,
      published: post.published,
      isPremium: post.isPremium,
      publishedAt: post.publishedAt,
      youtubeUrl: post.youtubeUrl,
    },
  });
  console.log('Inserted:', JSON.stringify(post.title));
}

main().catch(console.error);
