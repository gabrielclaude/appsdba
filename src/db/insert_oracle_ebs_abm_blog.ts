import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'oracle-ebs-account-based-marketing';

const content = `
Account based marketing turns the usual demand-generation model upside down. Instead of casting a wide net and hoping the right people find your content, you identify the specific companies and roles you want to reach, then build your entire outreach around them. For an audience as specialized as Oracle E-Business Suite professionals, this is not just a better strategy — it is the only strategy that produces reliable results at a reasonable cost.

This post lays out how to run ABM for Oracle EBS: who to target, where to find them, how to build a compliant contact list, what to say to each persona, and how to measure whether it is working.

---

## Why ABM Works for Oracle EBS

The Oracle EBS user base has three characteristics that make it ideal for ABM and hostile to broad-reach marketing:

**It is small.** Oracle has approximately 11,000 EBS customers globally. The number of people at those companies who actually work with the product day to day — DBAs, technical architects, functional consultants, IT directors — is in the low six figures. Broadcasting to a general technology audience to reach this group wastes most of the budget.

**It is technical and skeptical.** EBS professionals have seen vendor marketing for decades. They do not respond to generic "modernize your ERP" messaging. They respond to specific, accurate technical content from people who clearly understand the product — RMAN backups, AutoConfig template behavior, adop patching, RESETLOGS implications. Content that demonstrates deep familiarity with the product earns the attention that broad messaging never gets.

**It is organized.** This audience has a community infrastructure: the Quest Oracle Community (formerly OAUG), the COLLABORATE conference, Oracle community forums, and Stack Overflow. These are places where the people you want to reach actively discuss problems and share knowledge. ABM lets you engage where they already are instead of trying to pull them to a new destination.

---

## The Two Personas

All Oracle EBS ABM targets fall into one of two primary personas. Your messaging, channel choice, and content offer should differ for each.

### Persona 1: The Technical Practitioner

**Who they are:** Oracle Apps DBAs, EBS technical developers, integration engineers, and systems administrators who are responsible for the hands-on operation of the EBS platform. They own patching cycles, database performance, cloning, disaster recovery, and system configuration.

**What they care about:** Solving specific technical problems. They are searching for answers to RMAN-05578, trying to understand why AutoConfig overwrote their custom TNS descriptor, or debugging a Workflow mailer configuration. They have a concrete problem right now and are looking for someone who has solved it.

**How to reach them:** Oracle Community Forum (metalink.oracle.com equivalent), Stack Overflow (oracle, oracle-ebs tags), GitHub (searching for EBS automation scripts), OAUG/Quest technical sessions at COLLABORATE. They are not primarily on LinkedIn for professional content consumption.

**Content that works:** Runbooks, step-by-step troubleshooting guides, scripts they can adapt directly. A post titled "RMAN-05578 When Running Backup-Based Duplicate — Root Cause and Fix" will get found via search. A post titled "How Oracle EBS Can Transform Your Business" will not.

**Offer:** Free access to a technical runbook or a structured checklist. Do not ask for payment at first contact. Get an email opt-in with a gated PDF or runbook, then nurture toward a subscription.

---

### Persona 2: The EBS Manager or IT Director

**Who they are:** IT managers, Oracle applications directors, VP-level IT leadership who are responsible for the EBS platform from a budget, staffing, and roadmap perspective. They may have a technical background but are no longer doing hands-on DBA work.

**What they care about:** Risk, cost, compliance, and keeping the platform stable while the business evaluates a move to Oracle Fusion or SaaS. They are worried about losing institutional knowledge as experienced DBAs retire, about audit findings related to database security configuration, and about what it will cost to stay on EBS 12.2 through the 2032 Premier Support window.

**How to reach them:** LinkedIn (where they actually engage with professional content), COLLABORATE keynotes and management-track sessions, industry analyst reports that Oracle circulates, and peer referrals from other IT directors at non-competing companies.

**Content that works:** Cost-of-ownership analysis, risk assessment frameworks, team capability benchmarks, and strategic roadmap guidance. A guide titled "What Staying on EBS Through 2032 Actually Costs — and What to Do About It" addresses their real concern.

**Offer:** A consultation, a benchmark report, or a structured readiness assessment. The conversion event is a scheduled call or a trial of the subscription content that gives their team access to the runbook library.

---

## Where to Find Oracle EBS Professionals

### Quest Oracle Community / OAUG

Quest (formerly OAUG) is the primary professional organization for Oracle E-Business Suite users. Members include the technical practitioners and managers at exactly the companies you want to reach. The COLLABORATE conference (held annually in April) is the highest-concentration event in the EBS calendar.

**What you can do:** Present at COLLABORATE or SIG events (earns credibility and email opt-ins from attendees). Engage in the Quest online community. Sponsor the conference to get attendee list access under Quest's terms.

**What you cannot do:** Scrape or harvest attendee email addresses from conference materials. Quest member contact data is governed by their membership agreement.

### Oracle Community Forum

The community.oracle.com forum has dedicated boards for Oracle E-Business Suite. Technical practitioners post questions and answers there regularly. These posts are indexed by search engines, which means creating content that addresses the same questions drives organic discovery.

**What you can do:** Participate in the forum (answers that link to relevant content where appropriate). Monitor threads for questions your content answers. Use the question topics to inform your editorial calendar.

**What you cannot do:** Extract email addresses from forum profiles. Oracle's forum terms of service prohibit scraping.

### Stack Overflow

The \`oracle-ebs\` and \`oracle\` tags on Stack Overflow surface real technical problems from practitioners. High-quality answers to these questions build visibility with the technical persona.

### LinkedIn

LinkedIn Sales Navigator allows you to search by job title (Oracle DBA, EBS Technical Lead, Oracle Applications Manager), company size, and industry vertical. This is the most direct way to identify managers and directors at target accounts by name and title, and to send InMail to individuals who have not opted into your list.

**Compliance note:** LinkedIn InMail is governed by LinkedIn's platform terms, not CAN-SPAM. Unsolicited InMail is allowed within LinkedIn's limits. However, extracting LinkedIn profiles to build an off-platform cold email list violates LinkedIn's terms of service.

### Apollo.io and ZoomInfo

Both platforms aggregate business contact information from public sources and user-contributed data, with verified email addresses and opt-in compliance built into their data licensing agreements. This is the primary compliant mechanism for obtaining direct email addresses for cold outreach to professionals who have not yet opted into your list.

Cost: Apollo.io has a free tier sufficient for initial ABM seeding. ZoomInfo requires an annual contract but has broader coverage of enterprise accounts.

---

## Building a Compliant Contact List

Cold email to a list of verified business contacts is CAN-SPAM compliant in the United States when the following conditions are met:

1. The message identifies itself accurately (from name, subject line, and sender)
2. The message includes a physical postal address
3. The message includes a clear, functional opt-out mechanism
4. Opt-out requests are honored within 10 business days
5. The email addresses were not obtained through address harvesting (scraping websites or forums without consent)

Points 1 through 4 are handled by your email sending platform. Point 5 is where most ABM programs go wrong. Addresses obtained from Apollo.io or ZoomInfo (which include opt-in representations as part of their data licensing) satisfy point 5. Addresses scraped from Oracle Community Forum profiles or LinkedIn do not.

For contacts in the European Union, GDPR's "legitimate interest" basis can apply to B2B cold email targeting professionals in their professional capacity, provided you have a documented legitimate interest assessment and a functioning opt-out. If your target accounts include EU-headquartered companies (SAP competitors, European manufacturers running EBS), review this with a data privacy attorney before sending to EU contacts.

**Practical steps:**

1. Build your target account list in the CRM (companies you have identified as EBS users)
2. For each target account, use Apollo.io to identify the specific roles you want (DBA, EBS Manager, IT Director)
3. Export verified contacts and import them into the email contacts module with source tagged as \`apollo\` or \`zoominfo\`
4. Tag each contact with their persona segment (\`apps-dba\`, \`ebs-manager\`, etc.) and deployment type (\`ebs-onprem\` or \`ebs-cloud\`)
5. Build separate sequences for each persona — same company, different message

---

## Messaging Framework

### For the Technical Practitioner (Apps DBA / EBS Engineer)

The opening line should demonstrate technical specificity. Generic subject lines get deleted.

**Subject examples:**
- \`RMAN duplicate on 12.2 — the DBID clause mistake that costs hours\`
- \`AutoConfig overwriting your custom TNS — how to survive it\`
- \`adop fs_clone took 6 hours — here is what to check first\`

**Email body structure:**
- One specific technical scenario they have likely encountered
- One sentence establishing that this is a solved problem with documented steps
- A link to the runbook or blog post (no login required for first contact)
- A one-line opt-in offer at the end: "If this was useful, we publish one runbook per week — subscribe free below"

Do not mention the subscription in the subject line. Practitioners will not click a marketing email. They will click something that looks like a direct answer to a problem they have had.

### For the EBS Manager / IT Director

The opening line should name a risk or cost the reader is responsible for.

**Subject examples:**
- \`Your EBS 12.2 support window ends in 2032 — what that actually costs\`
- \`Three audit findings Oracle EBS shops get — and how to prevent them\`
- \`When your senior DBA retires: EBS institutional knowledge risk\`

**Email body structure:**
- One organizational risk or cost framed at the management level (not technical detail)
- Two to three concrete options for how organizations at their stage are addressing it
- A link to a strategic guide or framework (gated behind an email capture — these buyers expect to give their email for substantive content)
- A call to action: a 30-minute conversation, a benchmark assessment, or a trial subscription for the team

---

## Target Account Scoring

Not all Oracle EBS companies are equally worth pursuing. Score your target accounts on:

| Factor | Points |
|--------|--------|
| EBS 12.2 confirmed (vs older version) | +20 |
| 1,000+ employees | +15 |
| Active Oracle Community / OAUG presence | +15 |
| On-premise (vs already on Fusion) | +10 |
| Manufacturing or healthcare vertical | +10 |
| Multiple EBS modules (SCM + Financials + HR) | +10 |
| IT director identified by name | +10 |
| Conference presenter / session speaker | +10 |

Accounts scoring 60+ are tier-1 targets for direct outreach. Accounts scoring 40–59 are tier-2 for content marketing and community engagement. Accounts below 40 should receive organic traffic only — do not invest outreach budget.

---

## KPIs

Track these metrics by persona segment, not in aggregate. A 5% open rate on DBA-targeted emails and a 3% open rate on director-targeted emails are both signals you need to act on, but the actions are different.

| Metric | DBA/Engineer target | Manager/Director target |
|--------|--------------------|-----------------------|
| Cold email open rate | 25–35% (specific subject) | 20–28% |
| Click-through rate | 8–15% | 4–8% |
| List opt-in rate | 3–6% | 2–4% |
| Opt-in to trial conversion | — | 5–10% |
| Trial to paid conversion | — | 15–25% |

If cold email open rates fall below 15% for either persona, the subject line is not specific enough. If click-through rates are adequate but opt-in rates are low, the content is behind too high a registration barrier.

---

## 90-Day Plan

**Days 1–30:** Build the account list. Identify 50 tier-1 target companies. For each, use Apollo.io to find two contacts per company — one technical and one manager. Import into the CRM with source, stage, and persona tags. Do not send yet.

**Days 31–60:** Warm the list through content. Post five to eight high-specificity technical articles that address problems the technical persona is actively searching for. These will rank in search and create inbound opt-ins. Send a light LinkedIn engagement campaign to the manager persona at your 50 tier-1 accounts — comment on their posts, connect with a relevant note, do not sell.

**Days 61–90:** Launch direct outreach. Send the technical sequence to all DBA/engineer contacts — one email per week for four weeks, each pointing to a specific runbook or guide. Send the management sequence to director/manager contacts — two emails over four weeks, each addressing an organizational risk. Track opens and clicks by account. Any account where both the technical and manager personas have engaged is a high-priority account for a direct conversion conversation.

---

## Summary

ABM for Oracle EBS works because the audience is bounded, organized, and responsive to specific technical credibility. The failure mode is treating it like broad demand generation — generic subject lines, gated content that is not specific enough to justify the email, and sequences that do not differentiate between a DBA debugging a clone failure and a director evaluating what EBS support will cost through 2032.

The mechanics are straightforward: target companies you know run EBS, find verified contacts through Apollo.io or ZoomInfo, tag them by persona, send sequences calibrated to the specific problems each persona owns, and measure by persona segment rather than in aggregate. The content already on this site gives you the technical credibility to open doors with practitioners. The management-track content — risk, cost, roadmap — is the bridge to the people who approve subscriptions.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Account Based Marketing for Oracle EBS: A Practitioner\'s Guide',
    slug,
    excerpt: 'ABM is the only demand-generation model that works reliably for the Oracle EBS audience. This guide covers the two target personas (Apps DBA / EBS Engineer vs IT Manager / Director), where to find them (OAUG/Quest, Oracle Community, Apollo.io), how to build a CAN-SPAM-compliant contact list, persona-specific messaging frameworks, account scoring, and a 90-day execution plan.',
    content,
    category: 'appsdba',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
