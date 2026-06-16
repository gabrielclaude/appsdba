import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'NetSuite Payroll Setup: Configuration, Compliance, and the Processing Sequence',
  slug: 'netsuite-payroll-setup-configuration-guide',
  excerpt:
    'NetSuite SuitePeople Payroll is a fully native payroll engine — no third-party middleware, no export files, no separate reconciliation. But a payroll module that posts directly to the general ledger demands that every configuration decision be made correctly before the first pay run. This guide covers the setup sequence from GL account mapping through tax codes, payroll items, employee profiles, and pay schedule configuration, with the compliance and reporting requirements that determine whether you can close the quarter.',
  category: 'netsuite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `Payroll is the highest-stakes transaction type in any ERP system. It runs on a fixed schedule, posts to the general ledger immediately, generates regulatory filings, and directly affects employees' lives. A misconfigured revenue account on a sales order can be corrected with a credit memo. A payroll tax withheld at the wrong rate generates IRS correspondence, penalty calculations, and amended filings.

NetSuite SuitePeople Payroll is a fully native payroll engine — it runs inside your NetSuite instance with direct general ledger posting, no export files, no middleware, and no reconciliation between a separate payroll system and your books. That integration is the product's major advantage. It is also why getting the setup right before the first pay run is non-negotiable.

This guide covers the end-to-end payroll setup sequence for NetSuite SuitePeople Payroll, the GL account structure that payroll requires, the tax and compliance configuration, and the processing workflow from payroll batch creation through direct deposit and tax filing.

---

## SuitePeople Payroll vs. Third-Party Integration

Before configuring payroll, establish which model your organization is using. NetSuite supports two approaches:

**SuitePeople Payroll (native)**: The payroll engine runs inside NetSuite. Payroll journal entries post automatically. Tax tables are maintained by NetSuite. W-2s, 941s, and state filings are generated natively. This model is available for US-based employees and requires a SuitePeople Payroll license.

**Third-party payroll integration**: ADP, Paychex, Gusto, or similar providers process payroll externally. NetSuite receives a journal entry import (manual CSV or via integration) after each payroll run. The third-party system handles tax filing and direct deposit. GL accounts must be mapped in both systems. This model works for any geography but requires a reconciliation step between the payroll provider's reports and the NetSuite general ledger.

The configuration in this guide covers SuitePeople Payroll. If your organization uses a third-party provider, the GL account setup (Step 1 below) still applies — the difference is that entries arrive via journal import rather than automatic posting.

> **Geographic scope**: SuitePeople Payroll supports US payroll only as of mid-2026. Canadian and international employees require a third-party payroll provider or a manual journal entry workflow.

---

## Prerequisites Before Payroll Setup Begins

Payroll configuration depends on three things being in place before the first payroll item is created:

**1. Chart of accounts with payroll GL accounts defined.** Payroll posts to specific expense and liability accounts. Those accounts must exist in NetSuite before any payroll configuration references them. The minimum payroll account set is documented in the next section.

**2. SuitePeople HR module configured.** Employee records in NetSuite must exist before they can be enrolled in payroll. At minimum: legal name, SSN (stored encrypted), address, hire date, and employment status. Job classifications and compensation data from HR feed into payroll calculations.

**3. Banking setup complete.** The company bank account used to fund payroll must be configured in NetSuite as a bank account record with the correct GL account mapping. Direct deposit ACH file generation requires the bank routing number and account number in the company bank record.

---

## Step 1: GL Accounts for Payroll

Payroll generates two types of journal entry lines on every pay run:

- **Expense lines** (debit): compensation costs and employer-side taxes and benefits
- **Liability lines** (credit): amounts owed to employees (net pay), government agencies (withheld taxes), and benefits providers

The following accounts must exist in the chart of accounts before payroll items are configured:

**Expense Accounts:**

| Account Name | Type | Purpose |
|-------------|------|---------|
| Salaries & Wages Expense | Expense | Exempt and non-exempt employee earnings |
| Overtime Expense | Expense | Overtime earnings (if tracked separately) |
| Bonus Expense | Expense | Discretionary and performance bonuses |
| Employer Payroll Tax Expense | Expense | Employer FICA, FUTA, SUTA |
| Employee Benefits Expense | Expense | Employer health insurance, 401(k) match |

**Liability Accounts:**

| Account Name | Type | Purpose |
|-------------|------|---------|
| Payroll Clearing | Other Current Liability | Net pay awaiting ACH settlement |
| Federal Income Tax Payable | Other Current Liability | Employee FIT withheld, unremitted |
| State Income Tax Payable | Other Current Liability | Employee SIT withheld, unremitted |
| Employee FICA Payable | Other Current Liability | Employee SS + Medicare withheld |
| Employer FICA Payable | Other Current Liability | Employer SS + Medicare accrued |
| FUTA Payable | Other Current Liability | Federal unemployment tax accrued |
| SUTA Payable | Other Current Liability | State unemployment tax accrued |
| Health Insurance Payable | Other Current Liability | Employee and employer premiums pending remittance |
| 401(k) Payable | Other Current Liability | Employee deferrals and employer match pending remittance |

The payroll clearing account is the pivot point of the payroll entry. On payroll run: debit expense accounts, credit payroll clearing and liability accounts. On ACH settlement: debit payroll clearing, credit the bank account. The clearing account should net to zero after every pay cycle closes.

---

## Step 2: Enable Payroll Features

Navigate to **Setup > Company > Enable Features > Employees** tab.

Enable:
- **Payroll** — the core payroll engine
- **Direct Deposit** — ACH file generation for employee bank accounts
- **Payroll Liabilities** — tracks tax and benefit liabilities between pay runs and remittances
- **Time & Expenses** — required if hourly employees enter time that feeds payroll calculations

After enabling, **Setup > Payroll** appears in the navigation menu. The payroll setup wizard launches automatically on first access — do not use the wizard if you are configuring a production environment. The wizard makes assumptions and skips validation steps. Configure each component manually using the menu items under Setup > Payroll.

---

## Step 3: Tax Configuration

NetSuite SuitePeople Payroll maintains a library of federal and state tax codes. Your configuration task is to activate the codes relevant to your organization and supply the employer-specific rates and IDs.

Navigate to **Setup > Payroll > Tax Codes**.

**Federal taxes to configure:**

| Tax Code | Description | Configuration Required |
|----------|-------------|----------------------|
| FIT | Federal Income Tax (employee withholding) | Withholding method: Percentage Method Tables. NetSuite updates the tables automatically. |
| SS-EE | Social Security — Employee | Rate: 6.2% on first $176,100 (2026 wage base). NetSuite maintains the wage base. |
| MED-EE | Medicare — Employee | Rate: 1.45% (no wage base). Additional Medicare Tax: 0.9% over $200,000. |
| SS-ER | Social Security — Employer | Rate: 6.2% (matches employee). |
| MED-ER | Medicare — Employer | Rate: 1.45% (matches employee). |
| FUTA | Federal Unemployment | Rate: 6.0% on first $7,000 (reduced by state credit, effective 0.6% for most states). Enter your FEIN. |

**State taxes to configure:**

For each state where employees work (not necessarily where the company is headquartered):

1. Select the state tax code (e.g., CA-SIT for California State Income Tax)
2. Enter the State Employer Account Number (issued by the state after registration)
3. Enter the state unemployment (SUTA) rate assigned by the state — this varies by employer based on experience rating
4. Confirm the SUI wage base for the state (varies by state annually)

> **Multi-state employees**: An employee who works in a state different from their state of residence may trigger obligations in both states. NetSuite handles this through the employee's work location assignment on the payroll profile. Confirm with your tax advisor which state's income tax applies before the first payroll run.

---

## Step 4: Payroll Items

Payroll items are the line-item definitions that drive every calculation in the payroll engine. Each item specifies what it calculates, which GL account it posts to, and how it interacts with taxes.

Navigate to **Setup > Payroll > Payroll Items**.

### Earnings Items

Create one item for each compensation type:

**Regular Wages** (non-exempt / hourly):
- Type: Wage
- Default rate: blank (pulled from employee record)
- Multiplier: 1.0
- GL Account: Salaries & Wages Expense
- Subject to FIT, SS, Medicare: Yes

**Salary** (exempt):
- Type: Salary
- Default rate: blank (pulled from employee record)
- Pays per period: calculated from annual salary ÷ pay schedule periods
- GL Account: Salaries & Wages Expense
- Subject to FIT, SS, Medicare: Yes

**Overtime** (non-exempt):
- Type: Wage
- Multiplier: 1.5
- GL Account: Overtime Expense
- Subject to FIT, SS, Medicare: Yes

**Bonus**:
- Type: Bonus
- Federal withholding method: Flat 22% supplemental rate or aggregate (confirm with your CPA)
- GL Account: Bonus Expense
- Subject to FIT, SS, Medicare: Yes

### Deduction Items

**Federal Income Tax**:
- Type: Tax Deduction
- Tax Code: FIT
- GL Account: Federal Income Tax Payable
- Reduces net pay: Yes

**State Income Tax** (one per state):
- Type: Tax Deduction
- Tax Code: [state]-SIT
- GL Account: State Income Tax Payable
- Reduces net pay: Yes

**Employee FICA — Social Security**:
- Type: Tax Deduction
- Tax Code: SS-EE
- GL Account: Employee FICA Payable
- Rate: 6.2% (NetSuite applies automatically)

**Employee FICA — Medicare**:
- Type: Tax Deduction
- Tax Code: MED-EE
- GL Account: Employee FICA Payable
- Rate: 1.45% (+ 0.9% Additional Medicare Tax for high earners)

**Health Insurance — Employee Premium**:
- Type: Deduction
- Deduction type: Pre-tax (Section 125 cafeteria plan) or Post-tax
- GL Account: Health Insurance Payable
- Pre-tax deductions reduce FIT and FICA taxable wages — confirm plan type with your benefits administrator before configuring

**401(k) — Employee Deferral**:
- Type: Deduction
- Deduction type: Pre-tax (traditional) or Post-tax (Roth)
- GL Account: 401(k) Payable
- Contribution limit: NetSuite does not automatically cap at IRS annual limits — configure the limit in the employee's payroll profile

### Employer Contribution Items

**Employer FICA — Social Security**:
- Type: Employer Contribution
- Tax Code: SS-ER
- GL Account (expense): Employer Payroll Tax Expense
- GL Account (liability): Employer FICA Payable

**Employer FICA — Medicare**:
- Type: Employer Contribution
- Tax Code: MED-ER
- GL Account (expense): Employer Payroll Tax Expense
- GL Account (liability): Employer FICA Payable

**FUTA**:
- Type: Employer Contribution
- Tax Code: FUTA
- GL Account (expense): Employer Payroll Tax Expense
- GL Account (liability): FUTA Payable

**SUTA** (one per state):
- Type: Employer Contribution
- Tax Code: [state]-SUI
- GL Account (expense): Employer Payroll Tax Expense
- GL Account (liability): SUTA Payable

**Employer Health Insurance Premium**:
- Type: Employer Contribution
- GL Account (expense): Employee Benefits Expense
- GL Account (liability): Health Insurance Payable

**401(k) Employer Match**:
- Type: Employer Contribution
- Match formula: configured per plan (e.g., 100% of first 3% deferred)
- GL Account (expense): Employee Benefits Expense
- GL Account (liability): 401(k) Payable

---

## Step 5: Pay Schedules

A pay schedule defines the pay frequency and the dates on which payroll is processed and employees are paid.

Navigate to **Setup > Payroll > Pay Schedules**.

| Frequency | Periods per Year | Typical Use Case |
|-----------|----------------|-----------------|
| Weekly | 52 | Hourly / production workers |
| Biweekly | 26 | Most common — salaried and hourly |
| Semi-monthly | 24 | Salaried employees (1st and 15th) |
| Monthly | 12 | Executives, contractors paid monthly |

For each pay schedule, configure:
- **Pay frequency**: the period type above
- **Pay day**: the day employees receive payment (e.g., Friday for biweekly)
- **Processing deadline**: how many business days before the pay date the payroll batch must be submitted (ACH requires at least 2 business days lead time)
- **First pay date**: the date of the first payroll run under this schedule — drives the automatic generation of all future pay period dates

---

## Step 6: Employee Payroll Profiles

With payroll items and pay schedules configured, each employee's payroll profile can be completed.

Navigate to **Employees > Employees > [Employee Name] > Payroll subtab**.

For each employee, configure:

**Pay information:**
- Pay type: Salary or Hourly
- Pay rate: Annual salary or hourly rate
- Pay schedule: select from configured schedules
- Department and Class: for GL dimension posting on payroll journal lines

**Tax withholding:**
- Federal filing status: Single, Married, Head of Household
- Federal allowances or W-4 Step 3/4 adjustments (2020+ W-4 format)
- State filing status and withholding (per state of work location)
- Additional withholding amounts if the employee has requested them

**Direct deposit:**
- Employee bank account routing and account number (stored encrypted)
- Account type: Checking or Savings
- Multiple accounts supported: split between primary and secondary accounts by percentage or fixed amount

**Benefits enrollment:**
- Assign the health insurance deduction item and employee premium amount
- Assign the 401(k) deferral item and contribution percentage or flat amount
- Assign the employer match contribution item

**Tax exemptions:**
- If an employee is exempt from state income tax (non-resident with reciprocity agreement), mark the state SIT deduction item as inactive on the employee's profile

---

## Step 7: Payroll Processing Workflow

With all configuration complete, the standard pay run sequence is:

1. **Create Payroll Batch**: Payroll > Pay Employees > Payroll Batch. Select the pay schedule and pay period. NetSuite pre-populates all active employees assigned to that schedule.

2. **Enter time and earnings exceptions**: For hourly employees, confirm that approved timesheet hours have imported from the Time & Expenses module. For salaried employees, add any bonuses, commissions, or one-time adjustments.

3. **Calculate**: Run the payroll calculation. NetSuite applies all payroll items, calculates gross pay, deductions, employer contributions, and net pay for each employee.

4. **Review the payroll register**: Verify the calculated amounts against headcount, salary changes, and any manual adjustments entered this period. The payroll register is the pre-run audit tool — discrepancies found here are corrected before submission.

5. **Submit and approve**: The payroll batch moves from Draft to Pending Approval. The approver reviews and approves the batch.

6. **Generate pay stubs**: NetSuite generates PDF pay stubs for employee self-service access.

7. **Transmit direct deposit**: The ACH file is generated and transmitted to the bank. NetSuite creates the payroll journal entry at this step: debit expense accounts, credit net pay clearing and all liability accounts.

8. **Reconcile and remit liabilities**: After the pay date, remit withheld taxes to the IRS (EFTPS) and state agencies. Record each remittance in NetSuite via **Payroll > Payroll Liabilities > Pay Payroll Liabilities**, which debits the liability account and credits the bank.

---

## Compliance and Reporting

SuitePeople Payroll generates the federal and state compliance reports required for each pay period, quarter, and year-end.

**Quarterly filings:**
- **Form 941** (Employer's Quarterly Federal Tax Return): Navigate to **Payroll > Payroll Tax Forms > Form 941**. Select the quarter. NetSuite populates wages, FIT withheld, and employer and employee FICA from the payroll journal entries for the period. Review before submitting to the IRS.

**Annual filings:**
- **Form W-2**: Navigate to **Payroll > Payroll Tax Forms > W-2 / W-3**. NetSuite generates W-2 forms for all employees paid during the year. The W-3 transmittal form aggregates all W-2 amounts. Both must be filed with the SSA by January 31 following the tax year.
- **Form 940** (Annual FUTA Return): Generated at year-end. NetSuite calculates FUTA liability and credit offset from state unemployment taxes paid.

**State filings**: Each state generates its own quarterly wage report and annual reconciliation. Navigate to **Payroll > Payroll Tax Forms > State Tax Forms** and select the relevant state and form type.

---

## Summary

NetSuite SuitePeople Payroll eliminates the reconciliation gap between a separate payroll system and the general ledger — but it demands that every configuration layer be correct before the first pay run executes.

The five configuration rules that prevent the most expensive payroll errors:

1. **Get the GL accounts right before creating payroll items.** A payroll item that posts to the wrong account creates errors in every pay run until it is corrected, and correcting it requires retroactive journal entries for every affected period.

2. **Confirm pre-tax vs. post-tax status on every deduction before the first payroll.** A health insurance deduction configured as post-tax instead of pre-tax over-withholds FICA and FIT from employees for the entire year. The only fix is amended W-2s.

3. **Enter state registrations before adding employees in those states.** A payroll run for an employee in a state where the employer is not registered will calculate a liability with no corresponding remittance pathway.

4. **Test with a single employee before adding the full headcount.** Create one test employee in a sandbox, run one payroll batch, and trace every journal entry line to its source payroll item. Find configuration errors with one employee, not with forty.

5. **Set the ACH processing deadline correctly on every pay schedule.** A deadline set too tight means ACH transmission fails on a bank holiday and employees are not paid on time. Add one buffer day to the bank's stated ACH processing window.

The companion runbook covers the step-by-step setup procedure for each configuration phase, the verification checks at each stage, the payroll reconciliation procedure, and the quarterly and annual compliance checklist with due dates.`,
};

async function main() {
  console.log('Inserting NetSuite payroll setup blog post...');
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
