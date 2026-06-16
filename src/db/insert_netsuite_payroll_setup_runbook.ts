import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: NetSuite SuitePeople Payroll Setup — Configuration, Verification, and First Pay Run',
  slug: 'netsuite-payroll-setup-runbook',
  excerpt:
    'Step-by-step NetSuite SuitePeople Payroll configuration runbook: GL account setup, feature enablement, federal and state tax code configuration, payroll item definitions with pre/post-tax rules, employee payroll profile enrollment, pay schedule setup, ACH direct deposit, payroll batch processing, liability remittance, and quarterly/annual compliance filing procedures.',
  category: 'netsuite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `## Prerequisites

Before starting this runbook:

- [ ] NetSuite instance licensed for SuitePeople Payroll (US only)
- [ ] Chart of accounts includes all payroll GL accounts (see Phase 1)
- [ ] SuitePeople HR module configured with employee records (legal name, SSN, address, hire date)
- [ ] Federal Employer Identification Number (FEIN) available
- [ ] State employer account numbers for each state where employees work
- [ ] State SUTA (unemployment) rates confirmed with each state agency
- [ ] Company bank account routing and account numbers available for ACH setup
- [ ] Employee W-4 forms collected (2020+ format: Steps 1–4) and I-9s on file
- [ ] Benefits plan documents confirming pre-tax vs. post-tax status for each deduction type
- [ ] 401(k) plan document confirming match formula and any vesting schedule

---

## Phase 1: GL Account Setup

Create all payroll-related GL accounts before any payroll item is configured. Every payroll item references at least one GL account, and a missing account causes import failures during payroll item creation.

Navigate to **Lists > Accounting > Accounts > New** for each account below.

### 1.1 Expense Accounts

| Account Number | Name | Type | Department Posting |
|---------------|------|------|--------------------|
| 6010 | Salaries & Wages Expense | Expense | Yes — use employee's department |
| 6015 | Overtime Expense | Expense | Yes |
| 6020 | Bonus Expense | Expense | Yes |
| 6030 | Employer Payroll Tax Expense | Expense | Yes |
| 6040 | Employee Benefits Expense | Expense | Yes |

**Verification**: Navigate to **Reports > Financial > Trial Balance**. Confirm each expense account appears in the 6000s range under Operating Expenses.

### 1.2 Liability Accounts

| Account Number | Name | Type | Notes |
|---------------|------|------|-------|
| 2100 | Payroll Clearing | Other Current Liability | Should net to zero after each pay cycle |
| 2110 | Federal Income Tax Payable | Other Current Liability | FIT withheld, unremitted |
| 2120 | State Income Tax Payable | Other Current Liability | SIT withheld, unremitted |
| 2130 | Employee FICA Payable | Other Current Liability | Employee SS + Medicare withheld |
| 2140 | Employer FICA Payable | Other Current Liability | Employer SS + Medicare accrued |
| 2150 | FUTA Payable | Other Current Liability | Federal unemployment tax accrued |
| 2160 | SUTA Payable | Other Current Liability | State unemployment tax accrued |
| 2170 | Health Insurance Payable | Other Current Liability | Employee and employer premiums |
| 2180 | 401(k) Payable | Other Current Liability | Employee deferrals + employer match |
| 2190 | Garnishments Payable | Other Current Liability | Required for any wage garnishment orders |

**Verification**: Navigate to **Reports > Financial > Balance Sheet**. All 2100–2190 accounts should appear under Current Liabilities.

---

## Phase 2: Enable Payroll Features

### 2.1 Feature Enablement

1. Navigate to **Setup > Company > Enable Features**
2. Click the **Employees** tab
3. Enable the following features (check each box and save):
   - [ ] Payroll
   - [ ] Direct Deposit
   - [ ] Payroll Liabilities
   - [ ] Time & Expenses (required if hourly employees submit timesheets)
   - [ ] Employee Self Service (enables pay stub access for employees)
4. Click **Save**

**Verification**: Confirm **Setup > Payroll** menu appears in the top navigation. If it does not appear, log out and back in — role permission refresh is required.

### 2.2 Payroll Preferences

Navigate to **Setup > Payroll > Payroll Preferences**.

Configure:
- **Company FEIN**: enter your 9-digit Federal Employer Identification Number (format: XX-XXXXXXX)
- **Payroll contact name and phone**: used on tax forms
- **Default payroll expense account**: select Salaries & Wages Expense (6010)
- **Default payroll liability account**: select Payroll Clearing (2100)
- **ACH company ID**: your company's ACH originator ID from your bank (typically your FEIN or a bank-assigned ID)
- **ACH company name**: exactly as registered with your bank (appears on employees' bank statements)
- **NACHA file format**: Standard (CCD or PPD — PPD for personal accounts is most common for payroll)

**Verification**: Save and re-open Payroll Preferences. Confirm FEIN is displayed correctly (not blank or masked incorrectly).

---

## Phase 3: Tax Code Configuration

### 3.1 Federal Tax Codes

Navigate to **Setup > Payroll > Tax Codes**.

For each federal tax code, verify it is active and the GL account mapping is correct:

**FIT (Federal Income Tax — Employee):**
- [ ] Status: Active
- [ ] Liability GL Account: Federal Income Tax Payable (2110)
- [ ] Withholding method: Percentage Method Tables (do not change — NetSuite auto-updates)

**SS-EE (Social Security — Employee):**
- [ ] Status: Active
- [ ] Rate: 6.2%
- [ ] Wage base: $176,100 (2026 — NetSuite updates annually; verify in current tax year)
- [ ] Liability GL Account: Employee FICA Payable (2130)

**MED-EE (Medicare — Employee):**
- [ ] Status: Active
- [ ] Rate: 1.45%
- [ ] Additional Medicare Tax: 0.9% on wages over $200,000
- [ ] Liability GL Account: Employee FICA Payable (2130)

**SS-ER (Social Security — Employer):**
- [ ] Status: Active
- [ ] Rate: 6.2% (mirrors SS-EE)
- [ ] Expense GL Account: Employer Payroll Tax Expense (6030)
- [ ] Liability GL Account: Employer FICA Payable (2140)

**MED-ER (Medicare — Employer):**
- [ ] Status: Active
- [ ] Rate: 1.45%
- [ ] Expense GL Account: Employer Payroll Tax Expense (6030)
- [ ] Liability GL Account: Employer FICA Payable (2140)

**FUTA:**
- [ ] Status: Active
- [ ] Rate: 6.0% gross / 0.6% net (after FUTA credit — only adjust if your state has credit reduction)
- [ ] Taxable wage base: $7,000 per employee
- [ ] Expense GL Account: Employer Payroll Tax Expense (6030)
- [ ] Liability GL Account: FUTA Payable (2150)

### 3.2 State Tax Codes

For each state where employees perform work (not just where the company is registered):

1. Navigate to **Setup > Payroll > Tax Codes > New** (if the state code is not pre-loaded) or select the existing state code
2. Configure:
   - [ ] State: select from dropdown
   - [ ] Tax type: SIT (income tax), SUI (unemployment), SDI (disability, where applicable)
   - [ ] State employer account number: enter the number assigned by the state agency
   - [ ] SUI rate: enter your experience-rated SUTA percentage (obtain from state agency annual rate notice)
   - [ ] SUI wage base: varies by state (e.g., CA: $7,000; NY: $12,500; WA: $68,500 — verify for current year)
   - [ ] Liability GL Account: State Income Tax Payable (2120) for SIT; SUTA Payable (2160) for SUI

**States with SDI (State Disability Insurance):**
California, Hawaii, New Jersey, New York, Rhode Island, Washington require SDI configuration. Create a separate tax code for each SDI obligation with its own liability account or map to SUTA Payable if the state collects both through the same agency.

**Verification**: For each configured state, navigate to the tax code and confirm the employer account number is populated and the GL accounts are assigned. A missing account number will cause state tax filing generation to fail.

---

## Phase 4: Payroll Item Setup

Navigate to **Setup > Payroll > Payroll Items > New** for each item below. Complete all items before proceeding to employee profiles — the items must exist to be assigned to employees.

### 4.1 Earnings Items

**Regular Wages (hourly):**
- Name: Regular Wages
- Type: Wage
- Multiplier: 1.0
- Default rate: leave blank (populated from employee record)
- Subject to FIT: Yes
- Subject to FICA: Yes
- Expense GL Account: Salaries & Wages Expense (6010)

**Salary (exempt):**
- Name: Salary
- Type: Salary
- Pays per period: calculated automatically from annual rate ÷ periods in schedule
- Subject to FIT: Yes
- Subject to FICA: Yes
- Expense GL Account: Salaries & Wages Expense (6010)

**Overtime (FLSA 1.5x):**
- Name: Overtime
- Type: Wage
- Multiplier: 1.5
- Subject to FIT: Yes
- Subject to FICA: Yes
- Expense GL Account: Overtime Expense (6015)

**Bonus:**
- Name: Bonus
- Type: Bonus
- Federal withholding: Supplemental flat rate (22%) — confirm with CPA whether aggregate method applies
- Subject to FIT: Yes
- Subject to FICA: Yes (unless bonus is non-discretionary and paid separately — consult CPA)
- Expense GL Account: Bonus Expense (6020)

**Expense Reimbursement:**
- Name: Expense Reimbursement
- Type: Addition
- Subject to FIT: No (accountable plan reimbursements are not taxable wages)
- Subject to FICA: No
- Expense GL Account: use the specific expense account being reimbursed (Travel, Meals, etc.)

### 4.2 Employee Deduction Items

**Federal Income Tax:**
- Name: Federal Income Tax
- Type: Tax Deduction
- Tax Code: FIT
- Reduces gross for FICA: No (FIT is calculated on FICA-taxable wages, not the other way around)
- GL Account: Federal Income Tax Payable (2110)

**State Income Tax (one per state):**
- Name: [State] Income Tax (e.g., California Income Tax)
- Type: Tax Deduction
- Tax Code: [state]-SIT
- GL Account: State Income Tax Payable (2120)

**Employee Social Security:**
- Name: Employee Social Security
- Type: Tax Deduction
- Tax Code: SS-EE
- GL Account: Employee FICA Payable (2130)

**Employee Medicare:**
- Name: Employee Medicare
- Type: Tax Deduction
- Tax Code: MED-EE
- GL Account: Employee FICA Payable (2130)

**Health Insurance — Employee Premium (Pre-Tax):**
- Name: Health Insurance EE Pre-Tax
- Type: Deduction
- Pre/Post-tax: Pre-Tax (Section 125 — reduces FIT, SS, and Medicare taxable wages)
- GL Account: Health Insurance Payable (2170)
- Default amount: leave blank (set per employee based on plan election and tier)

> **Critical**: Confirm with the benefits administrator that the plan qualifies as a Section 125 cafeteria plan. If it does not, this deduction must be post-tax. Configuring a post-tax benefit as pre-tax reduces the employee's reported W-2 wages incorrectly.

**401(k) — Employee Deferral (Pre-Tax Traditional):**
- Name: 401(k) Deferral EE
- Type: Deduction
- Pre/Post-tax: Pre-Tax (reduces FIT taxable wages; FICA still applies)
- GL Account: 401(k) Payable (2180)
- Annual limit enforcement: NetSuite does NOT automatically stop contributions at the IRS annual limit ($23,500 for 2026). Set a per-employee override to enforce the cap, or rely on the payroll administrator to monitor.

**Roth 401(k) — Employee Deferral (Post-Tax):**
- Name: Roth 401(k) Deferral EE
- Type: Deduction
- Pre/Post-tax: Post-Tax (taxed before deferral; not deducted from FIT wages on W-2)
- GL Account: 401(k) Payable (2180)

**Wage Garnishment:**
- Name: Wage Garnishment
- Type: Deduction
- Pre/Post-tax: Post-Tax
- GL Account: Garnishments Payable (2190)
- Amount: set per employee per court order (do not set a default)

### 4.3 Employer Contribution Items

**Employer Social Security:**
- Name: Employer Social Security
- Type: Employer Contribution
- Tax Code: SS-ER
- Expense GL Account: Employer Payroll Tax Expense (6030)
- Liability GL Account: Employer FICA Payable (2140)

**Employer Medicare:**
- Name: Employer Medicare
- Type: Employer Contribution
- Tax Code: MED-ER
- Expense GL Account: Employer Payroll Tax Expense (6030)
- Liability GL Account: Employer FICA Payable (2140)

**FUTA:**
- Name: FUTA
- Type: Employer Contribution
- Tax Code: FUTA
- Expense GL Account: Employer Payroll Tax Expense (6030)
- Liability GL Account: FUTA Payable (2150)

**SUTA (one per state):**
- Name: [State] SUTA
- Type: Employer Contribution
- Tax Code: [state]-SUI
- Expense GL Account: Employer Payroll Tax Expense (6030)
- Liability GL Account: SUTA Payable (2160)

**Employer Health Insurance Premium:**
- Name: Health Insurance ER
- Type: Employer Contribution
- GL Expense Account: Employee Benefits Expense (6040)
- GL Liability Account: Health Insurance Payable (2170)
- Not subject to FIT or FICA (employer-paid premiums are excluded from employee taxable wages)

**401(k) Employer Match:**
- Name: 401(k) Match ER
- Type: Employer Contribution
- Match formula: enter in the item (e.g., 100% of first 3% deferred — NetSuite calculates per employee)
- Expense GL Account: Employee Benefits Expense (6040)
- Liability GL Account: 401(k) Payable (2180)

**Verification after all payroll items are created:**
- Navigate to **Setup > Payroll > Payroll Items**
- Confirm each item shows the correct type, tax code (where applicable), and GL accounts
- Confirm no items are in Draft status — all must be Active before employee assignment

---

## Phase 5: Pay Schedule Setup

Navigate to **Setup > Payroll > Pay Schedules > New**.

### 5.1 Create Each Pay Schedule

Create one schedule per pay frequency used in your organization.

**Example: Biweekly — Salaried Employees**
- Schedule name: Biweekly Salaried
- Pay frequency: Biweekly
- Pay period start: Monday
- Pay day: Friday (two Fridays after period start)
- Processing deadline: 3 business days before pay date (accounts for ACH transmission and bank processing)
- First period start date: the first Monday of the new payroll effective date
- First pay date: the first Friday two weeks after the first period start

**Example: Weekly — Hourly Employees**
- Schedule name: Weekly Hourly
- Pay frequency: Weekly
- Pay day: Friday
- Processing deadline: 3 business days before pay date
- Timesheet submission cutoff: Tuesday 5pm (ensure timesheets are approved before Wednesday payroll calculation)

**Verification**: After saving, navigate back to the schedule and confirm the next 4 pay period dates auto-populate correctly. If they do not, the first pay date configuration is incorrect.

---

## Phase 6: Employee Payroll Profile Enrollment

Navigate to **Employees > Employees**, open each employee record, and click the **Payroll** subtab.

### 6.1 Per-Employee Payroll Configuration Checklist

- [ ] **Pay type**: Salary or Hourly
- [ ] **Pay rate**: Annual salary (for salary type) or hourly rate (for hourly type)
- [ ] **Pay schedule**: assign the correct schedule
- [ ] **Department**: confirm (drives GL dimension on payroll journal lines)
- [ ] **Location**: confirm (drives state tax code selection for multi-state employees)

**Federal tax withholding (W-4 2020+ format):**
- [ ] Filing status: Single/MFS, MFJ/QSS, or Head of Household
- [ ] Step 3 amount: dependent tax credit total from W-4 (if provided)
- [ ] Step 4a amount: other income not from jobs (if provided)
- [ ] Step 4b amount: deductions beyond standard (if provided)
- [ ] Step 4c amount: additional withholding per pay period (if provided)
- [ ] Exempt from FIT: check only if employee submitted exempt claim on W-4 (valid for one calendar year only)

**State tax withholding:**
- [ ] State of work location: primary state for withholding
- [ ] Filing status per state form
- [ ] Additional state withholding if employee requested
- [ ] Exempt status if applicable (non-resident reciprocity agreement)

**Direct deposit:**
- [ ] Bank routing number (9 digits)
- [ ] Bank account number
- [ ] Account type: Checking or Savings
- [ ] Allocation: 100% to primary account OR split (configure secondary account and amounts)
- [ ] Prenote: NetSuite sends a zero-dollar prenote ACH entry for validation before the first live deposit — confirm bank requires or waives prenote

**Deductions and benefits:**
- [ ] Health Insurance EE Pre-Tax: enter employee premium per period
- [ ] 401(k) Deferral EE: enter contribution percentage or flat dollar amount
- [ ] 401(k) Match ER: verify match calculates automatically on save
- [ ] Health Insurance ER: enter employer premium per period
- [ ] Any garnishment orders: enter amount and garnishment payee per court order

**Verification after each employee enrollment:**
- Save the employee record
- Navigate to **Payroll > Pay Employees > Payroll Batch > New** (test mode)
- Add only this employee
- Run the calculation without submitting
- Verify gross pay, all deductions, employer contributions, and net pay match expectations
- Cancel the test batch (do not submit)

---

## Phase 7: First Payroll Batch Processing

### 7.1 Create the Payroll Batch

Navigate to **Payroll > Pay Employees > Payroll Batch > New**.

- [ ] Select Pay Schedule
- [ ] Select Pay Period (confirm start and end dates)
- [ ] NetSuite pre-populates all employees assigned to the selected schedule
- [ ] Verify the employee list — confirm no active employees are missing

### 7.2 Enter Earnings Adjustments

For the current pay period, review each category of adjustment:

**Hourly employees:**
- [ ] Confirm approved timesheets have imported (Time & Expenses > Time > Time Approval)
- [ ] Review regular hours and overtime hours per employee
- [ ] Add any missing hours manually if timesheet import is incomplete

**Salary employees:**
- [ ] No action required for full-period salary (auto-calculated)
- [ ] For new hires mid-period: adjust salary to prorated amount for days worked
- [ ] For terminations mid-period: adjust final paycheck to cover through last day worked
- [ ] Add any bonus payments as separate line items on the affected employee's record within the batch

### 7.3 Calculate Payroll

Click **Calculate**. NetSuite runs the payroll engine for all employees in the batch.

After calculation, review the **Payroll Register**:

| Column | What to Verify |
|--------|---------------|
| Gross Pay | Matches expected salary or hours × rate |
| FIT Withheld | Reasonable relative to gross pay and filing status |
| SS Withheld | 6.2% of gross (until wage base) |
| Medicare Withheld | 1.45% of gross (plus 0.9% over $200k) |
| State Tax | Reasonable relative to state and gross pay |
| Health Insurance | Matches employee election |
| 401(k) | Matches deferral percentage × gross |
| Net Pay | Gross minus all deductions |
| Employer SS | 6.2% of gross (mirrors employee) |
| Employer Medicare | 1.45% of gross |

**Red flags that require investigation before submission:**
- Any employee with $0 FIT withheld who did not claim exempt on W-4
- Net pay that is negative (deductions exceed gross — must be corrected)
- Overtime hours on employees classified as Exempt
- An employee missing from the batch who appears active in HR

### 7.4 Approve and Submit

- [ ] Payroll batch reviewed and approved by Controller or designated approver
- [ ] Submit the batch: status changes from Pending Approval to Submitted
- [ ] ACH file generated automatically
- [ ] Transmit ACH file to bank (confirm delivery receipt from bank's SFTP or web portal)
- [ ] Payroll journal entry posts automatically to the GL upon submission

**Verify the payroll journal entry:**

Navigate to the submitted payroll batch and open the associated journal entry. Confirm:
- Total debit (expense accounts) = gross payroll + employer taxes and benefits
- Total credit (payroll clearing + all liability accounts) = same total
- Journal entry date = pay date

### 7.5 ACH Processing and Pay Date Confirmation

On the pay date:
- [ ] Confirm with the bank that the ACH file settled (no rejected items)
- [ ] If any ACH returns exist (invalid account, closed account, non-sufficient funds): contact affected employees immediately, void the ACH entry in NetSuite, and issue a paper check or reprocess on the next pay date
- [ ] Record ACH return in NetSuite: debit Payroll Clearing, credit the bank account used to fund payroll — reverses the net pay credit for the affected employee

---

## Phase 8: Payroll Liability Remittance

After each payroll run, the liability accounts accumulate balances that must be remitted to government agencies and benefits providers on schedule.

### 8.1 Federal Tax Deposits (EFTPS)

**Deposit schedule (determined by IRS based on prior-year liability):**
- Lookback period under $50,000: Monthly depositor — deposit by the 15th of the following month
- Lookback period over $50,000: Semiweekly depositor — deposit by Wednesday (for Friday payrolls) or Friday (for Wednesday payrolls)
- New employers: monthly depositor for the first year

**Process in NetSuite:**
1. Navigate to **Payroll > Payroll Liabilities > Pay Payroll Liabilities**
2. Select date range covering the deposits to be remitted
3. Select the liabilities: FIT Payable, Employee FICA Payable, Employer FICA Payable
4. Click Pay — NetSuite creates a journal entry: debit the liability accounts, credit the bank account
5. Log in to EFTPS (eftps.gov) and initiate the same payment amount on the same dates

**Verification**: The total EFTPS payment must equal FIT withheld + Employee FICA (SS + Medicare) + Employer FICA (SS + Medicare) for the covered pay dates. Run the **Payroll Liability Balances** report in NetSuite to confirm the exact amounts before initiating the EFTPS payment.

### 8.2 State Tax Remittances

Each state has its own deposit schedule and online portal. Common schedules:
- California (EDD): quarterly if liability under $500, monthly if $500–$9,999, next-business-day if $10,000+
- New York (DTF): quarterly, monthly, or quarterly accelerated depending on annual liability

For each state: remit via the state's employer portal, then record in NetSuite via **Payroll > Payroll Liabilities > Pay Payroll Liabilities** selecting the state's SIT and SUI liability accounts.

### 8.3 Benefits Provider Remittances

Health insurance and 401(k) providers have their own payment schedules (typically monthly for health insurance, per-payroll or monthly for 401(k)).

Record remittances in NetSuite:
- Navigate to **Transactions > Bank > Write Check** (or **Make Payment** if using the AP module)
- Debit Health Insurance Payable (2170) or 401(k) Payable (2180)
- Credit the bank account

The Health Insurance Payable and 401(k) Payable accounts should net to zero after each remittance cycle.

---

## Phase 9: Quarterly and Annual Compliance

### 9.1 Form 941 — Quarterly Federal Tax Return

**Due dates**: April 30, July 31, October 31, January 31 (for Q1, Q2, Q3, Q4)

**In NetSuite:**
1. Navigate to **Payroll > Payroll Tax Forms > Form 941**
2. Select the quarter
3. Verify pre-populated amounts:
   - Line 1: Number of employees who received wages during the quarter
   - Line 2: Total wages, tips, and other compensation
   - Line 3: FIT withheld
   - Lines 5a/5b: Taxable SS/Medicare wages and taxes
   - Line 10: Total taxes before adjustments
   - Line 13: Total deposits made for the quarter (must equal Line 10 for no balance due)
4. Review for accuracy against the Payroll Register summary
5. File electronically via EFTPS or through a tax professional

### 9.2 Form 940 — Annual FUTA Return

**Due date**: January 31 (or February 10 if all FUTA taxes were deposited on time during the year)

**In NetSuite:**
1. Navigate to **Payroll > Payroll Tax Forms > Form 940**
2. Verify total FUTA wages and the credit for state unemployment taxes paid
3. Confirm FUTA liability was remitted quarterly (required if liability exceeded $500 in a quarter)

### 9.3 W-2 and W-3 — Annual Wage Statements

**Due dates**: Provide to employees by January 31. File with SSA by January 31.

**In NetSuite:**
1. Navigate to **Payroll > Payroll Tax Forms > W-2 / W-3**
2. Select the tax year
3. Review each employee W-2 for:
   - Box 1: Wages, tips, other compensation (gross minus pre-tax deductions)
   - Box 2: FIT withheld
   - Box 3: SS wages (limited to annual wage base)
   - Box 4: SS withheld
   - Box 5: Medicare wages (no limit)
   - Box 6: Medicare withheld
   - Box 12: Pre-tax benefits (401(k) deferrals appear here with Code D)
   - Box 14: Other deductions (post-tax items, state SDI, etc.)
4. Verify Box 1 + Box 12 Code D = gross wages for each employee
5. Distribute W-2s to employees via NetSuite Employee Self Service or paper
6. File the W-3 transmittal with the SSA

### 9.4 Year-End Payroll Reconciliation Checklist

Before closing the payroll year:

- [ ] Total Form 941 wages across all four quarters = total W-2 Box 1 wages
- [ ] Total FIT deposits per EFTPS = total FIT on all four Form 941s
- [ ] Total FICA deposits per EFTPS = total SS + Medicare on all four Form 941s
- [ ] Payroll Clearing account balance = $0 (if non-zero, investigate uncleared ACH entries)
- [ ] Federal Income Tax Payable balance = $0 (if non-zero, an EFTPS payment was missed)
- [ ] Employee FICA Payable balance = $0
- [ ] Employer FICA Payable balance = $0
- [ ] Health Insurance Payable balance = $0 (if non-zero, a benefits remittance was missed)
- [ ] 401(k) Payable balance = $0 (if non-zero, a 401(k) remittance was missed)

---

## Common Payroll Configuration Errors

| Error | Root Cause | Detection | Resolution |
|-------|-----------|-----------|-----------|
| Employee FIT withholding is $0 | Employee marked exempt on W-4 without basis, or W-4 data not entered | Review Payroll Register — FIT column | Collect updated W-4 from employee; update withholding on employee payroll profile |
| Net pay is negative | Deductions exceed gross pay | Payroll Register shows negative net | Reduce deduction amount for this period or process as a separate correction |
| FICA wages exceed SS wage base mid-year | No action — correct behavior | SS withheld drops to $0 once employee hits $176,100 | No action; FICA wages correctly stopped |
| Health insurance deduction is taxable (FICA reduces) | Deduction configured as post-tax instead of pre-tax | Compare Box 3 SS wages to Box 1 wages — should be equal if 401k is only pre-tax item | Change deduction to pre-tax; file corrected W-2 for affected year |
| State SIT amount seems too high | Employee filed status not entered (defaults to Single/0) | Employee payroll profile missing state W-4 equivalent | Enter employee's state withholding form data on payroll profile |
| ACH return — Account Not Found | Employee provided wrong account number | Bank returns R03 or R04 code within 2 business days | Collect corrected account info; void original ACH; reprocess |
| 401(k) match not calculating | Match formula not entered on employer contribution item | Payroll Register shows $0 employer match | Edit the 401(k) Match ER payroll item and enter the match formula |
| FUTA liability not accruing after $7,000 | Correct — FUTA wage base is $7,000 per employee | FUTA Payable stops increasing for the employee after $7,000 | No action needed |`,
};

async function main() {
  console.log('Inserting NetSuite payroll setup runbook...');
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
