import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Demantra: Demand Forecasting with Naive Bayes and the Probabilistic Demand Sensing Engine',
  slug: 'oracle-demantra-demand-forecasting-naive-bayes',
  excerpt:
    'How Oracle Demantra models demand uncertainty using Naive Bayes classification, what the Bayesian engine actually computes, how causal factors interact with prior probability estimates, and why this matters for intermittent and lumpy demand patterns that break classical time-series methods.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `Oracle Demantra is Oracle's demand management and demand sensing product within the Oracle Value Chain Planning suite. It sits between the historical demand signal (sales history, shipments, point-of-sale data) and the supply planning engine (Oracle ASCP or Fusion Planning), producing a statistically defensible forecast that accounts for causal factors — promotions, price changes, seasonality, economic indicators — not just the raw demand history.

What separates Demantra from simpler time-series forecasters built into EBS is its forecasting engine architecture: a Bayesian probabilistic model that estimates the demand distribution rather than just a point forecast, enabling downstream supply decisions to be made with explicit uncertainty bounds.

---

## The Demand Forecasting Problem Demantra Solves

Classical time-series methods — Holt-Winters triple exponential smoothing, ARIMA, moving average — share a common assumption: demand is a continuous, reasonably regular signal that can be extrapolated from its own recent history. This assumption holds well for high-velocity consumer goods with stable demand patterns. It breaks for:

- **Intermittent demand**: SKUs with many zero-demand periods (spare parts, capital equipment consumables, pharmaceuticals). A moving average on a series with 70% zero periods produces a meaningless fractional forecast for every period.
- **Lumpy demand**: occasional large-volume orders (bulk buys, contract fulfilment) surrounded by silence. These inflate variance estimates and produce forecasts that are persistently wrong in both direction and magnitude.
- **Causal-driven demand**: products whose sales are driven primarily by external factors (promotions, competitor actions, weather, economic indicators) rather than their own history. The history contains the effect of past promotions — extrapolating it without modelling the causal relationship produces biased forecasts.

Demantra's Bayesian engine was designed specifically for these scenarios.

---

## The Naive Bayes Foundation

Naive Bayes is a probabilistic classifier based on Bayes' theorem with the "naive" conditional independence assumption: given the class label, all features are independent of each other. Despite this assumption being violated in almost every real dataset, Naive Bayes classifiers are empirically competitive with far more complex models, especially in high-dimensional feature spaces with limited training data.

In Demantra's context, the classification problem is: given the current feature vector (historical demand pattern, causal factor values, calendar attributes), what is the probability distribution over future demand states?

### Bayes' Theorem in Demand Forecasting

\`\`\`
P(demand_state | features) = P(features | demand_state) × P(demand_state) / P(features)
\`\`\`

- **P(demand_state)**: the prior probability of being in a given demand state — estimated from the historical frequency of each demand level in the item's history
- **P(features | demand_state)**: the likelihood — how probable is this combination of feature values given that demand is in this state
- **P(demand_state | features)**: the posterior — the updated probability of each demand state after observing the current feature values

Demantra discretises the continuous demand variable into demand states (bins) and estimates the posterior distribution over those bins for each future period. The mode of this distribution is the point forecast; the full distribution is used for safety stock calculations.

### The Naive Independence Assumption

The "naive" assumption in Demantra's implementation is that causal factors contribute independently to the demand probability update. If a product has both a promotion and a price reduction in the same period, Demantra multiplies the likelihood contributions from each factor independently rather than computing a joint likelihood.

This is computationally tractable — the alternative (computing full joint distributions over all combinations of causal factors) is NP-hard in the general case — and practically acceptable because:

1. Causal factors in retail and manufacturing are often genuinely near-independent (a media spend campaign is scheduled independently of a trade promotion)
2. Where interactions exist, they can be explicitly modelled as composite causal factors in Demantra's causal factor hierarchy
3. The error from the independence assumption is usually smaller than the error from having insufficient historical data to estimate the joint distribution accurately

---

## Demantra's Demand Profile Types

Before applying the Bayesian engine, Demantra classifies each item-location combination into a demand profile based on the statistical properties of its demand history:

| Profile | Characteristics | Forecasting Method Applied |
|---------|----------------|---------------------------|
| Smooth | Continuous, low CV, low intermittency | Holt-Winters or regression |
| Erratic | High CV, low intermittency | Weighted moving average with variance damping |
| Intermittent | High frequency of zeros, low CV when non-zero | Croston's method |
| Lumpy | High frequency of zeros AND high CV when non-zero | Bayesian (Naive Bayes engine) |
| Causal | Demand strongly correlated with external factors | Bayesian with causal factors |

The Naive Bayes engine is most active on lumpy and causal profiles. For smooth profiles, simpler time-series methods are computationally cheaper and empirically equivalent.

Demantra automatically assigns profiles during the collection cycle. DBAs can query the profile assignments:

\`\`\`sql
-- Check demand profile assignments for top items by historical demand
SELECT
  il.item_name,
  il.location_name,
  dp.profile_name,
  il.average_demand,
  il.cv_demand,
  il.intermittency_ratio
FROM demantra.item_locations il
JOIN demantra.demand_profiles dp
  ON il.demand_profile_id = dp.profile_id
WHERE il.average_demand > 0
ORDER BY il.average_demand DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\`

---

## How Causal Factors Enter the Bayesian Model

A causal factor in Demantra is any external variable that has a statistically demonstrable effect on demand for one or more items. The causal factor hierarchy is built in Demantra's UI, but the underlying computation is a regression of historical demand against the causal factor values.

### Causal Factor Registration

\`\`\`sql
-- View registered causal factors and their statistical significance
SELECT
  cf.factor_name,
  cf.factor_type,
  cf.regression_coefficient,
  cf.t_statistic,
  cf.p_value,
  cf.r_squared_contribution
FROM demantra.causal_factors cf
WHERE cf.p_value < 0.05   -- statistically significant at 95% confidence
ORDER BY ABS(cf.regression_coefficient) DESC;
\`\`\`

### How Lift Factors Scale the Posterior

For promotional causal factors, Demantra computes a lift factor: the multiplier applied to the base demand estimate when the promotion is active. The lift is derived from the Bayesian posterior update:

\`\`\`
posterior_demand = base_demand × lift_factor
lift_factor = P(features_with_promo | demand_state) / P(features_without_promo | demand_state)
\`\`\`

A lift factor of 1.0 means the promotion has no measurable effect. A lift of 2.5 means the promotion doubles-plus demand, historically. Lift factors are item-specific and location-specific — a promotion that lifts demand 3x at a flagship store may lift it 1.2x at a convenience outlet.

---

## Forecast Accuracy Metrics

Demantra tracks three primary accuracy metrics, each surfaced in the \`demantra.forecast_accuracy\` schema tables:

### MAPE (Mean Absolute Percentage Error)

\`\`\`
MAPE = (1/n) × Σ |actual - forecast| / actual × 100
\`\`\`

MAPE is intuitive but undefined when actual demand is zero (common in intermittent profiles). Demantra uses a variant (symmetric MAPE or WMAPE) for zero-heavy items.

### Bias

\`\`\`
Bias = (1/n) × Σ (forecast - actual)
\`\`\`

Persistent positive bias means Demantra is systematically over-forecasting — this drives excess inventory. Persistent negative bias drives stockouts. Bias should oscillate around zero in a well-calibrated model.

### Tracking Signal

\`\`\`
Tracking Signal = cumulative_sum_of_errors / mean_absolute_deviation
\`\`\`

A tracking signal outside ±4 indicates the model is systematically wrong and should be re-estimated. Demantra can trigger automatic re-estimation when the tracking signal breaches this threshold.

\`\`\`sql
-- Items with significant positive bias (over-forecasting) in the last 12 periods
SELECT
  fa.item_name,
  fa.location_name,
  ROUND(fa.mape_12, 1) mape_pct,
  ROUND(fa.bias_12, 0) bias_units,
  ROUND(fa.tracking_signal, 2) tracking_signal,
  fa.demand_profile
FROM demantra.forecast_accuracy fa
WHERE fa.bias_12 > 0
  AND ABS(fa.tracking_signal) > 2
ORDER BY fa.bias_12 DESC
FETCH FIRST 30 ROWS ONLY;
\`\`\`

---

## The Demantra Engine Execution Cycle

The Demantra forecasting engine runs as a batch process — typically nightly or weekly — on the Demantra application server. Each cycle:

1. **Collection**: pulls sales actuals, inventory levels, and causal factor values from EBS (via the Demantra-EBS integration tables) into Demantra's analytical schema
2. **Profile classification**: re-evaluates demand profile assignments based on rolling window statistics
3. **Model re-estimation**: updates Bayesian priors, regression coefficients for causal factors, and Holt-Winters smoothing parameters
4. **Forecast generation**: computes point forecasts and distribution parameters for each item-location-period combination
5. **Accuracy calculation**: computes MAPE, bias, and tracking signal for the previous periods where actuals are now available
6. **Export**: pushes the new forecast to the EBS MSC_DEMANTRA_MEASURES interface table for ASCP consumption

The Engine is Java-based and multi-threaded. Its configuration — number of threads, batch size, memory allocation — has significant impact on the duration of each engine run. A poorly configured Demantra Engine on a production instance with 50,000 item-location combinations can run for 12+ hours; a well-configured instance with the same data completes in 2–3 hours.

---

## Integration with Oracle ASCP

From ASCP's perspective, Demantra is a demand input source. ASCP consumes the Demantra forecast through the \`MSC_DEMANTRA_MEASURES\` interface:

\`\`\`sql
-- Check Demantra forecast has been transferred to the ASCP interface table
SELECT
  mdm.sr_inventory_item_id,
  mdm.sr_organization_id,
  mdm.period_type,
  mdm.bucket_date,
  mdm.quantity,
  mdm.last_update_date
FROM msc.msc_demantra_measures mdm
WHERE mdm.bucket_date BETWEEN SYSDATE AND SYSDATE + 90
ORDER BY mdm.sr_inventory_item_id, mdm.bucket_date;
\`\`\`

If this table is empty or stale, ASCP will use its own demand history-based forecast instead of Demantra's probabilistic forecast — often a significant planning accuracy regression.

---

## Why Naive Bayes Beats Exponential Smoothing for Lumpy Demand

For a SKU with demand history: 0, 0, 0, 47, 0, 0, 0, 0, 0, 83, 0, 0 (units per week):

- **Exponential smoothing** produces a forecast of ~3–5 units/week for every future period — technically "optimal" in MSE terms but practically useless: it recommends holding 3–5 units/week of safety stock for a product that either doesn't sell or sells in large batches
- **Naive Bayes** produces: P(zero demand) = 0.83, P(demand = 47–83) = 0.17 for any given week, with the distribution conditional on whether a known demand trigger (contract renewal, seasonal event) is scheduled

The planner's decision-making is fundamentally different when they see "83% probability of zero demand, 17% probability of a 47–83 unit demand event" versus "forecast: 4 units/week". Safety stock calculations grounded in the actual demand distribution prevent both excess inventory from over-forecasting and stockouts from under-forecasting lumpy demand.

The companion runbook covers the Oracle 19c database prerequisites, RHEL 9 installation procedure, post-install configuration, and the monitoring scripts and crontab entries needed to operate Demantra reliably in production.`,
};

async function main() {
  console.log('Inserting Oracle Demantra demand forecasting blog post...');
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
