import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Clinical Resource Allocation with Multi-Layer Perceptron: Matching Staff Capacity to Trial Phase Demands',
  slug: 'oracle-clinical-mlp-resource-allocation-clinical-trials',
  excerpt:
    'Oracle Clinical tracks everything about a study — enrollment, discrepancies, adverse events, monitoring visits — but it does not tell you how much of a Medical Monitor or CRA a project needs next month. A Multi-Layer Perceptron trained on historical allocation records and real-time Oracle Clinical signals can predict FTE demand for each role by trial phase, turning a capacity problem that most organizations solve with spreadsheets into a model-driven recommendation.',
  category: 'oracle-clinical' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Clinical (OC) is Oracle's clinical trial management system — the authoritative data store for study protocols, patient enrollment, CRF (Case Report Form) data collection, discrepancy management, adverse events, and site monitoring. It is the operational backbone of most large pharmaceutical and CRO clinical operations.

What Oracle Clinical does not do is tell you how to staff your studies. Resource allocation in clinical trials is one of the most persistently manual operations in the industry. Portfolio managers maintain spreadsheets of FTE commitments, capacity planners hold weekly meetings to move people between projects, and the result is always a lag — the spreadsheet reflects last week's reality while enrollment rates, SAE surges, and protocol amendments are changing this week.

The problem has a known structure. Each clinical trial phase has a predictable demand profile for each role. A Phase I first-in-human study needs heavy Medical Director and Principal Scientist involvement at protocol finalization, but almost no CRA presence because there are only a handful of sites and very few patients. A Phase III study running at peak enrollment across fifty sites has inverted demand — CRAs are the scarce resource, and Medical Director hours are consumed by SAE reviews rather than protocol design. These are non-linear, phase-dependent relationships. When you layer in enrollment velocity, query density, SDV backlog, and milestone proximity, the decision becomes complex enough that a rules-based approach breaks down quickly.

A Multi-Layer Perceptron trained on historical Oracle Clinical data learns these non-linear relationships directly from the record of what allocation patterns correlated with good outcomes — on-time milestones, low protocol deviation rates, acceptable data quality scores. The output is a predicted FTE fraction for each role, per project, updated as the underlying Oracle Clinical signals change.

---

## Oracle Clinical Architecture

Oracle Clinical is a relational application built on Oracle Database. Its schema organizes data around studies, phases, sites, and patients, with supporting tables for discrepancy management, lab data, and regulatory tracking.

The key modules relevant to resource allocation signals are:

| Module | Purpose | Resource Signal |
|--------|---------|-----------------|
| Protocol Management | Study design, phases, arms | Phase, amendment count |
| Patient Management | Enrollment, randomization, disposition | Enrollment rate, dropout rate |
| Data Collection | CRF layouts, DCM data entry | CRF completion rate, query density |
| Discrepancy Management | Data queries, resolution tracking | Open query count, age of queries |
| Lab Data Management | Centralized lab results and flags | Lab flag rate (Medical Monitor signal) |
| Adverse Event Tracking | SAE/AE entry and causality | SAE rate (Medical Director demand driver) |
| Site Management | Investigator site records | Active sites, monitoring visit backlog |

The monitoring visit backlog — pages awaiting source data verification (SDV) at each site — is the primary CRA demand signal. When the SDV backlog grows, more CRA time is needed. When enrollment slows between visits, CRA demand temporarily compresses.

---

## Role Demand Profiles by Trial Phase

Understanding the phase-dependent demand curve for each role is the prerequisite for understanding why an MLP is the right model family.

### Medical Director / Doctor (DR)

The DR role is consumed by two distinct tasks: protocol-level medical decisions (front-loaded at study startup and after amendments) and individual patient safety decisions (SAE review and medical query resolution, distributed throughout enrollment and treatment). Demand peaks twice: at protocol finalization before Phase I opens, and again at peak enrollment during Phase II/III when SAE volume is highest. The relationship is not linear — a doubling of enrollment does not double DR hours because many SAE reviews are resolved at the Medical Monitor level and only escalate to the DR for complex cases.

### Principal Scientist (PS)

Principal Scientist demand is highest during the design and close-out stages: protocol development, statistical analysis plan (SAP) creation, interim analysis, and final clinical study report (CSR). During active enrollment, PS hours are lower but not zero — amendment impact assessments, data review meetings, and regulatory agency interactions sustain a baseline. The PS demand profile is bimodal and phase-lagged: high at Phase I start, then a trough during Phase II enrollment, then a spike again as Phase III moves toward lock and analysis.

### Medical Monitor (MM)

The Medical Monitor is the continuous safety surveillance role. MM demand is directly correlated with patient exposure: active patients receiving treatment generate lab results, AE reports, and medical queries at a rate roughly proportional to the number of patient-days on study. MM demand tracks the enrollment curve smoothly, without the spiky discontinuities seen in DR and PS demand. This makes MM allocation the most predictable of the four roles and the easiest to model with a linear approximation — but interactions with SAE rate and lab flag density make a linear model underfit when SAE clusters occur.

### Clinical Research Associate (CRA)

CRA demand is the most site-count-driven. Each active investigator site requires periodic monitoring visits for source data verification. The frequency scales with enrollment velocity — a fast-enrolling site may need monthly visits while a slow site can be monitored quarterly. Total CRA demand is approximately:

\`\`\`
CRA FTE ≈ (active_sites × visit_frequency × days_per_visit) / 20 working_days_per_month
\`\`\`

This formula gives a linear baseline, but the actual demand is non-linear because visit frequency is not constant — it increases when SDV backlog grows, when sites have high discrepancy rates, or when a for-cause audit is triggered. The MLP captures these non-linear adjustments that the formula misses.

---

## Why Multi-Layer Perceptron

Several model families can predict FTE allocation from structured tabular data. The choice of MLP over alternatives is motivated by three characteristics of the problem:

**Non-linear feature interactions.** The impact of SAE rate on DR demand depends on the trial phase and the number of active patients. During Phase I with ten patients, even a high SAE rate generates manageable absolute volume. During Phase III with two thousand patients, the same per-patient rate becomes overwhelming. A linear model cannot represent this multiplicative interaction; a decision tree can represent it only as a discrete split. An MLP with hidden layers naturally learns smooth, continuous interaction surfaces.

**Multi-output regression with correlated targets.** The four role allocations are not independent. When DR time is consumed by SAE review, Medical Monitor time typically rises simultaneously because MM is the first-line responder who decides what escalates to the DR. A single MLP with four output neurons allows the hidden layers to learn these inter-role correlations implicitly, which produces better-calibrated outputs than four independent single-output models.

**Historical pattern generalization.** Different therapeutic areas have characteristic demand patterns. Oncology studies have high SAE rates and high DR involvement; dermatology studies tend to have lower medical complexity but high enrollment counts requiring more CRA coverage. An MLP trained on a portfolio-wide historical dataset generalizes these patterns across new studies that are identified as belonging to a known therapeutic category, even if no historical data exists for that specific compound.

### Comparison with Alternatives

| Model | Advantage | Limitation for This Problem |
|-------|-----------|----------------------------|
| Linear regression | Interpretable coefficients | Cannot represent phase × enrollment rate interactions |
| Decision tree | Explicit rules | Discrete splits miss continuous demand gradients |
| Random forest | Handles non-linearity | Four independent models; misses inter-role correlations |
| LSTM / recurrent | Models temporal sequences | Adds complexity without benefit for cross-sectional allocation |
| MLP | Learns non-linear interactions, multi-output | Requires normalization, less interpretable than trees |

---

## Feature Engineering from Oracle Clinical

The MLP input is a feature vector computed per project per scoring period (typically monthly). All features are normalized to [0, 1] before being passed to the model.

### Feature Vector (11 Inputs)

| Index | Feature | Source Table | Rationale |
|-------|---------|-------------|-----------|
| 0 | \`phase_encoded\` | \`OC_STUDY_PHASES\` | Phase I=0.25, II=0.50, III=0.75, IV=1.00 |
| 1 | \`enrollment_pct\` | \`OC_PATIENT_POSITION\` | Enrolled / target enrollment |
| 2 | \`enrollment_velocity_ratio\` | \`OC_PATIENT_POSITION\` | Actual monthly rate / planned monthly rate |
| 3 | \`active_sites_pct\` | \`OC_SITE\` | Active sites / total planned sites |
| 4 | \`sae_rate_normalized\` | \`OC_ADVERSE_EVENT\` | SAEs per 100 patient-years, log-normalized |
| 5 | \`query_density\` | \`OC_DISCREPANCY\` | Open queries / completed CRF pages |
| 6 | \`sdv_backlog_pct\` | \`OC_MONITORING_VISIT\` | Unverified pages / total completed pages |
| 7 | \`amendment_count_log\` | \`OC_STUDY_PROTOCOL\` | log(1 + amendment_count) / log(10) |
| 8 | \`milestone_urgency\` | \`OC_MILESTONES\` | 1 - (days_to_milestone / 180), clipped to [0,1] |
| 9 | \`phase_elapsed_pct\` | \`OC_STUDY_PHASES\` | Days in phase / planned phase duration |
| 10 | \`lab_flag_rate\` | \`OC_LAB_DATA\` | Flagged lab results / total lab results |

### Signal Extraction Query

\`\`\`sql
SELECT
  s.study_id,
  s.study_name,
  sp.phase_code,
  CASE sp.phase_code
    WHEN 'I'  THEN 0.25
    WHEN 'II' THEN 0.50
    WHEN 'III' THEN 0.75
    WHEN 'IV' THEN 1.00
    ELSE 0.50
  END AS phase_encoded,

  -- Enrollment signals
  COUNT(DISTINCT pp.patient_id) / NULLIF(s.target_enrollment, 0) AS enrollment_pct,
  (COUNT(DISTINCT pp.patient_id) / NULLIF(MONTHS_BETWEEN(SYSDATE, sp.actual_start_date), 0))
    / NULLIF(s.planned_monthly_enrollment, 0) AS enrollment_velocity_ratio,

  -- Site signals
  SUM(CASE WHEN si.site_status = 'ACTIVE' THEN 1 ELSE 0 END)
    / NULLIF(s.planned_sites, 0) AS active_sites_pct,

  -- Safety signal (SAE rate per 100 patient-years)
  ROUND(
    (COUNT(DISTINCT ae.ae_id) * 100)
      / NULLIF(SUM(pp.exposure_days) / 365.25, 0), 3
  ) AS raw_sae_rate,

  -- Data quality signals
  COUNT(DISTINCT d.discrepancy_id) / NULLIF(COUNT(DISTINCT crf.crf_page_id), 0) AS query_density,

  -- SDV backlog
  SUM(CASE WHEN mv.sdv_status = 'PENDING' THEN mv.page_count ELSE 0 END)
    / NULLIF(SUM(mv.page_count), 0) AS sdv_backlog_pct,

  -- Protocol complexity
  COUNT(DISTINCT pa.amendment_id) AS amendment_count,

  -- Milestone urgency
  MIN(mi.planned_date - SYSDATE) AS days_to_next_milestone,

  -- Phase elapsed
  (SYSDATE - sp.actual_start_date)
    / NULLIF(sp.planned_end_date - sp.planned_start_date, 0) AS phase_elapsed_pct,

  -- Lab signal
  COUNT(CASE WHEN ld.flag_type IS NOT NULL THEN 1 END)
    / NULLIF(COUNT(ld.lab_result_id), 0) AS lab_flag_rate

FROM oc_study_master s
JOIN oc_study_phases sp ON sp.study_id = s.study_id AND sp.is_current = 'Y'
LEFT JOIN oc_patient_position pp ON pp.study_id = s.study_id
LEFT JOIN oc_site si ON si.study_id = s.study_id
LEFT JOIN oc_adverse_event ae ON ae.study_id = s.study_id
  AND ae.sae_flag = 'Y'
  AND ae.event_date >= ADD_MONTHS(SYSDATE, -12)
LEFT JOIN oc_discrepancy d ON d.study_id = s.study_id AND d.status = 'OPEN'
LEFT JOIN oc_crf_page crf ON crf.study_id = s.study_id
LEFT JOIN oc_monitoring_visit mv ON mv.study_id = s.study_id
LEFT JOIN oc_protocol_amendment pa ON pa.study_id = s.study_id
LEFT JOIN oc_milestones mi ON mi.study_id = s.study_id
  AND mi.planned_date > SYSDATE
  AND mi.milestone_type IN ('REGULATORY_SUBMISSION','DATABASE_LOCK','CSR_COMPLETE')
LEFT JOIN oc_lab_data ld ON ld.study_id = s.study_id
  AND ld.result_date >= ADD_MONTHS(SYSDATE, -3)

WHERE s.study_status = 'ACTIVE'
GROUP BY s.study_id, s.study_name, sp.phase_code,
         sp.actual_start_date, sp.planned_start_date, sp.planned_end_date,
         s.target_enrollment, s.planned_monthly_enrollment, s.planned_sites;
\`\`\`

---

## MLP Architecture

The network has three hidden layers sized to progressively compress the 11-dimensional input into a 4-dimensional allocation output. Dropout layers prevent overfitting on smaller historical datasets (common in organizations with fewer than 100 completed studies in their training corpus).

\`\`\`
Input (11 features)
      │
  Dense(64, ReLU)
      │
  Dropout(0.20)
      │
  Dense(32, ReLU)
      │
  Dropout(0.20)
      │
  Dense(16, ReLU)
      │
  Dense(4, Sigmoid)
      │
Output (4 FTE fractions)
  [dr_fte, principal_scientist_fte, medical_monitor_fte, cra_fte]
\`\`\`

**Activation choices:**

- **ReLU** in hidden layers avoids vanishing gradients and is appropriate for positive-valued resource signals where the relationship is monotone in each direction.
- **Sigmoid** at the output constrains each role's allocation to [0.0, 1.0] — representing 0% to 100% FTE on a single project. A person working at 0.5 allocates half their capacity. The sigmoid allows the model to output fractions for each role independently, which is correct because one person can be allocated across multiple projects simultaneously (the constraint is at the portfolio level, not the project level).

**Loss function:** Mean Absolute Error (MAE) over the four output dimensions. MAE is preferred over MSE here because the allocation targets from historical data contain occasional outliers (emergency protocol amendments that temporarily consumed 100% of a Principal Scientist's time), and MAE is more robust to these without clipping the training labels.

**Training target:** Historical staff allocation records joined to project outcome scores. The training label for each (project, month) pair is the actual FTE fraction recorded in the staffing system. The inclusion of an outcome quality weight (higher weight for projects that met their milestones and quality targets) biases the model toward allocations that correlated with good outcomes rather than allocations that simply happened.

---

## Allocation Output and Portfolio View

The model outputs a per-project FTE fraction for each role. The portfolio summary aggregates across all active projects to show total demand versus available capacity:

\`\`\`
Study             Phase  DR_FTE  PS_FTE  MM_FTE  CRA_FTE
────────────────  ─────  ──────  ──────  ──────  ───────
ONCOLOGY-001      III    0.30    0.15    0.60    2.40
DERM-002          II     0.10    0.20    0.25    0.80
CARDIO-003        II     0.25    0.10    0.40    1.20
NEUROLOGY-004     I      0.40    0.35    0.20    0.30
────────────────────────────────────────────────────────
Total Demand      —      1.05    0.80    1.45    4.70
Available (FTE)   —      2.00    3.00    2.00    6.00
Capacity Slack    —      0.95    2.20    0.55    1.30
Alert             —      OK      OK      ⚠ LOW   OK
\`\`\`

The Medical Monitor capacity slack of 0.55 FTE flags a staffing risk: at current project demand, 73% of available MM capacity is consumed. If enrollment accelerates on ONCOLOGY-001 or CARDIO-003, or if an SAE cluster occurs, MM demand will exceed supply without intervention — either by contracting a CRO MM or by shifting timeline milestones.

This portfolio view is the primary deliverable. It converts the ML output into an actionable capacity planning signal that portfolio managers can act on one to two months before the gap materializes, rather than discovering it when a monitoring visit is overdue or a medical query sits unresolved for 30 days.

---

## Integration Pattern

The scoring pipeline runs monthly via a scheduled Oracle Database job:

1. **Extract**: the feature extraction query runs against Oracle Clinical, writing results to a staging table \`OC_ML_FEATURES_STAGING\`.
2. **Score**: a Python process (ora2py connection via cx_Oracle or python-oracledb) reads the staging table, applies the saved MLP weights, and writes allocation predictions to \`OC_ML_ALLOCATION_SCORES\`.
3. **Consume**: Oracle Clinical's custom reporting module (or a connected BI tool such as Oracle Analytics Cloud) reads \`OC_ML_ALLOCATION_SCORES\` and renders the portfolio capacity view.
4. **Feedback loop**: actual staff allocation records (from the HR or project management system) are imported monthly into \`OC_ACTUAL_ALLOCATIONS\` and used in the next quarterly retraining run.

---

## Summary

Oracle Clinical is the data-of-record system for clinical trials, but resource allocation remains a manual, lag-prone process in most organizations. The phase-dependent demand profiles of the four key roles — Medical Director, Principal Scientist, Medical Monitor, and Clinical Research Associate — contain non-linear feature interactions (phase × enrollment rate × SAE rate × site count) that a linear model cannot represent faithfully.

A Multi-Layer Perceptron with three hidden layers, trained on historical Oracle Clinical allocation records, learns these interaction surfaces from portfolio-wide data and produces a monthly FTE prediction per role per active study. The 11-feature input vector is derived entirely from signals already present in Oracle Clinical — enrollment counts, SAE tables, discrepancy records, monitoring visit logs, and milestone dates — requiring no new data collection infrastructure.

The model output converts a reactive staffing conversation into a proactive capacity signal: portfolio managers see predicted demand one to two months ahead, with explicit flags when any role is approaching full utilization across the portfolio. The companion runbook covers the complete implementation sequence: Oracle Clinical schema audit, feature extraction SQL, Python environment setup, MLP training with scikit-learn and TensorFlow/Keras, model deployment, Oracle integration via cx_Oracle, and the quarterly retraining schedule.`,
};

async function main() {
  console.log('Inserting Oracle Clinical MLP blog post...');
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
