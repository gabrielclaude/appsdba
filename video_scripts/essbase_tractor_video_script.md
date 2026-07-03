# Video Script: Building an Essbase Application for Tractor Manufacturing
**Post:** https://appsdba.vercel.app/posts/essbase-tractor-manufacturing-application-outline-oci
**Target duration:** 12–14 minutes
**Format:** Narrated screen recording with animated diagram segments and AI-generated B-roll

---

## Production Notes

- **Narration style:** Direct, technical, no filler phrases. Pause 1 second between major sections.
- **Screen recording tool:** OBS Studio or Camtasia. Dark terminal theme (Dracula or Nord).
- **Diagrams:** Draw.io or Excalidraw, exported as MP4 animation or screen-recorded while drawing.
- **B-roll:** AI-generated clips (prompts in Section 11). Drop in at opener, transitions, and close.
- **Font for on-screen text:** JetBrains Mono for code; Inter for headings.

---

## Section 1 — Cold Open (0:00–0:30)

**[B-ROLL: AI-generated — see Prompt A]**
*Wide aerial shot of a tractor assembly line. Robotic arms welding frames. Finished green-and-yellow tractors rolling off the line.*

**NARRATION (V/O over B-roll):**
> "A tractor manufacturer has two plants, three product lines, twelve models — and a finance team that needs to know gross margin by model, by plant, by month, compared to budget. That question cannot be answered from an ERP transaction table without a cube. This video shows you how to build that cube in Oracle Essbase."

**[CUT TO: Terminal prompt on dark screen]**
**ON SCREEN TEXT (fade in):**
> Building an Essbase Application for Tractor Manufacturing
> Outlines · Calc Scripts · On-Premise vs OCI

---

## Section 2 — The Problem with ERP Alone (0:30–1:30)

**[SCREEN: Slide — simple diagram, two columns]**

Left column header: **ERP (Oracle EBS / SAP)**
Left column bullets:
- Rows and columns in relational tables
- Good at: "What was invoiced in January?"
- Slow at: Aggregating across 4 dimensions simultaneously
- Cannot: Hold Budget and Actual in the same query naturally

Right column header: **Essbase Cube**
- Data at every intersection of Model × Plant × Time × Scenario
- Good at: Gross margin by model by quarter vs plan, in milliseconds
- Supports: Write-back for budget input
- Powers: Smart View, Planning, OBIEE/OAC

**NARRATION:**
> "ERP systems are optimized for transaction recording. Essbase is optimized for multi-dimensional analysis. The question — what is the gross margin for the Compact series at the Waterloo plant in Q1 versus budget — requires simultaneously filtering on Model, Plant, Time, and Scenario. In a relational database, that's four joins and a complex aggregation. In Essbase, it's a single cell retrieval at the intersection of those four dimensions."

---

## Section 3 — IronField Equipment: The Business (1:30–2:30)

**[SCREEN: Slide — IronField Equipment org chart / product hierarchy]**

```
IronField Equipment
├── Compact Series        ← Augusta + Waterloo
│   ├── C40 (C40-4WD, C40-2WD, C40-HST)
│   ├── C50
│   └── C60
├── Utility Series        ← Augusta + Waterloo
│   ├── U75, U90, U110
└── Row Crop Series       ← Waterloo only
    ├── R8200, R8250, R8310
```

**NARRATION:**
> "Our fictional company, IronField Equipment, makes three product lines: Compact tractors under 60 horsepower, Utility mid-range machines, and high-HP Row Crop tractors. They have two plants — Waterloo, which assembles everything, and Augusta, which runs Compact and Utility only. The Row Crop line is Waterloo-exclusive."

**[SCREEN: Measures list — animate in line by line]**
```
Volume:     Units Produced | Units Shipped | Units On Hand
Revenue:    Gross Revenue  | Discounts     | Net Revenue
Cost:       Material Cost  | Labor Cost    | Plant Overhead
Margin:     Gross Margin   | Gross Margin %
Quality:    Defects        | Defect Rate %
Efficiency: Labor Hours    | Labor Hours per Unit
```

**NARRATION:**
> "The measures they track span volume, revenue, cost, margin, quality, and efficiency. Every one of these needs to be reported by model, by plant, by month, and compared to plan. That's the cube we're building."

---

## Section 4 — Dimension Design: Dense vs Sparse (2:30–4:30)

**[SCREEN: Slide — dimension table, animate rows appearing]**

| Dimension | Storage | Member Count | Why |
|-----------|---------|-------------|-----|
| Measures  | Dense   | 28 stored + 12 Dynamic Calc | Queried on every retrieval |
| Scenario  | Dense   | 3 (Actual, Budget, Forecast) | Small; always combined with Measures |
| Model     | Sparse  | 19 members | Not every plant builds every model |
| Plant     | Sparse  | 4 members | Natural sparse axis |
| Time      | Sparse  | 20 members | Time-series functions; keeps blocks manageable |
| Version   | Sparse  | 3 members | Adds blocks only for Budget/Forecast |

**NARRATION:**
> "The most important design decision in a BSO cube is which dimensions are dense and which are sparse. Dense dimensions are stored inside every data block — their member count directly multiplies block size. Sparse dimensions define the block addresses — a block only exists if data has been loaded at that intersection."

**[SCREEN: Block diagram — animate]**
*Draw a rectangle labeled "One BSO Block". Inside it, show a grid:*
- X axis: Scenario × 3 (Actual, Budget, Forecast)
- Y axis: Measures × 28
- Label: "84 cells × 8 bytes = 672 bytes per block"

**NARRATION:**
> "Our block size is 672 bytes. That comes from 28 stored Measures times 3 Scenario members, times 8 bytes for a double-precision float. Scenario and Measures are dense — they're always inside the block. Model, Plant, Time, and Version are sparse — they define which blocks exist. The combination of 9 leaf models times 2 plants times 12 months times 2 versions gives us about 430 populated blocks per year. Tiny cube. A real deployment with customer and region dimensions would scale to hundreds of thousands of blocks, but the design principles are identical."

---

## Section 5 — Consolidation Operators (4:30–5:15)

**[SCREEN: Slide — consolidation operator table]**

| Operator | Meaning | IronField Use Case |
|----------|---------|-------------------|
| + | Add to parent | All revenue and cost members |
| - | Subtract | Discounts subtracted from Gross Revenue |
| ~ | Ignore (do not roll up) | Plant Overhead at Unallocated node |
| ^ | Shared member | C40-4WD appearing under two parent nodes |

**NARRATION:**
> "Every member in every dimension carries a consolidation operator. The plus operator means add to the parent — most of our members are plus. The minus operator means subtract — Discounts subtract from Gross Revenue to give Net Revenue. The tilde means ignore — the Unallocated plant node carries overhead before it's distributed down to models, and we don't want it rolling up into the All Plants total twice. The caret means shared member — a sub-model can appear under two different parent nodes in the hierarchy without duplicating its data."

---

## Section 6 — Building the Outline in MaxL (5:15–7:00)

**[SCREEN: Terminal — dark theme. Type/paste MaxL commands. Highlight key lines.]**

**NARRATION:**
> "The outline is defined in MaxL — Oracle's DDL language for Essbase. We start by creating the application and the database."

**[TYPE ON SCREEN — slowly, with pause between blocks:]**
```sql
CREATE APPLICATION IronField;
CREATE DATABASE IronField.MfgPlan TYPE BSO;
ALTER DATABASE IronField.MfgPlan BEGIN OUTLINE;
```

**NARRATION:**
> "Then we add the Measures dimension — marked as Accounts type and Dense. The Accounts tag tells Essbase to apply time-balance properties and enables variance sign reversal for expense members."

**[HIGHLIGHT on screen:]**
```sql
ADD DIMENSION "Measures" AS ACCOUNTS DENSE;
ADD MEMBER "Gross Margin" TO "Measures" AS DYNAMIC_CALC
  FORMULA '"Net Revenue" - "Total Cost"';
```

**NARRATION:**
> "Gross Margin is Dynamic Calc — it has no stored value in the cube. The formula runs at query time. This saves storage and means the value is always current without a calc pass. Dynamic Calc is one of the most powerful performance tools in Essbase outline design."

**[HIGHLIGHT on screen — Model dimension hierarchy:]**
```sql
ADD MEMBER "Compact Series" TO "All Models";
  ADD MEMBER "C40"          TO "Compact Series";
    ADD MEMBER "C40-4WD"    TO "C40";
    ADD MEMBER "C40-2WD"    TO "C40";
    ADD MEMBER "C40-HST"    TO "C40";
```

**NARRATION:**
> "The Model dimension hierarchy reflects the product structure. Data is loaded at the sub-model level — C40-4WD, C40-2WD, C40-HST — and rolls up to C40, then Compact Series, then All Models. The hierarchy drives every drill-down and aggregation."

---

## Section 7 — Data Load from ERP (7:00–8:00)

**[SCREEN: Show CSV extract side by side with rules file mapping]**

Left panel — CSV extract:
```
PERIOD,PLANT,MODEL_CODE,UNITS_PRODUCED,...
Jan-2026,WATERLOO,C40-4WD,142,138,...
Jan-2026,WATERLOO,R8200,24,22,...
Jan-2026,AUGUSTA,C50-4WD,67,65,...
```

Right panel — Rules file mapping (animate arrows):
```
Field 1  →  Time dimension
Field 2  →  Plant dimension  (WATERLOO → "Waterloo")
Field 3  →  Model dimension
Field 4  →  "Units Produced" member
Field 5  →  "Units Shipped" member
...
Constant "Actual"  →  Scenario
Constant "Final"   →  Version
```

**NARRATION:**
> "EBS Discrete Manufacturing exports a CSV each month. The Essbase rules file maps each column to a dimension or a specific member. Field 2 is Plant — but the ERP uses uppercase WATERLOO while the outline uses mixed case Waterloo, so the rules file has a replace directive. Fields for Scenario and Version don't exist in the ERP extract because actuals always load as Actual slash Final — those are set as constants in the rules file. One MaxL import command loads the monthly data."

---

## Section 8 — Calc Scripts (8:00–9:15)

**[SCREEN: Terminal — CalcAll.csc with syntax highlighting]**

**NARRATION:**
> "The CalcAll script runs in two passes. Pass one is overhead allocation. Plant Overhead is stored at the Plant slash All Models level — a single number per plant per month. We need to split it down to each model proportionally, based on units produced. The FIX block locks us inside Waterloo, Actual, Final for the current period."

**[HIGHLIGHT on screen:]**
```
FIX(&CurYr, &CurPer, "Actual", "Final")
  FIX("Waterloo")
    "Plant Overhead" (
      IF ("Units Produced" -> "All Models" <> 0)
        "Plant Overhead" = "Plant Overhead" -> "All Models" *
          "Units Produced" / "Units Produced" -> "All Models";
```

**NARRATION:**
> "The arrow operator — right angle bracket — is a cross-dimensional reference in Essbase calc syntax. Units Produced arrow All Models means: the Units Produced value fixed at All Models in the Model dimension. This gives us the plant total, which we use as the denominator to compute each model's share of overhead. Pass two is a simple AGG — aggregate all four sparse dimensions up their hierarchies."

**[SCREEN: CalcBudget.csc — scroll through]**

**NARRATION:**
> "The budget seeding script copies prior year actuals into the Budget Working slice and applies growth factors — five percent on revenue, three percent on material cost to reflect inflation. Budget planners then adjust from that seed in Smart View rather than entering from zero."

---

## Section 9 — On-Premise vs OCI (9:15–10:45)

**[SCREEN: Side-by-side architecture diagram]**

Left: On-Premise
```
Physical Server
├── 32 GB RAM  ←  SGA + PGA + OS
├── 2 TB SAN   ←  ARBORPATH (.pag .ind files)
├── Essbase Agent  :1423
└── WebLogic Admin Server
```

Right: OCI Marketplace
```
OCI Compartment
├── VM.Standard.E4.Flex (4 OCPU / 64 GB)
├── Block Volume 500 GB  ←  /u01/config/essbase
├── Object Storage  ←  backups
└── Load Balancer  ←  HTTPS 443
```

**NARRATION:**
> "The on-premise sizing math starts from the outline. Block size is 672 bytes. With 432 blocks per year at full sub-model and plant depth, the raw cube is under a megabyte. Add five years of history and a customer region dimension and you're at a few gigabytes — a server with 32 GB RAM comfortably holds the entire block cache in memory."

**[SCREEN: Highlight cost comparison]**

| Period | On-Premise | OCI |
|--------|-----------|-----|
| Active planning (Aug–Nov) | Flat server cost | ~$600/month VM |
| Idle months (Jan–Jul) | Same flat cost | ~$25/month storage only |
| **Annual total** | **$15,000+ amortization** | **~$800 active + $175 idle** |

**NARRATION:**
> "Tractor manufacturing has a seasonal planning cycle — intensive in August through November for the annual budget, light the rest of the year. On-premise, you pay for the server year-round. On OCI, you stop the VM in January and pay only for Block Volume storage — about twenty-five dollars a month. Total OCI cost for a seasonal pattern is under a thousand dollars per year versus fifteen thousand in server amortization. That is the single most compelling reason to move a periodic-use Essbase deployment to OCI."

**[SCREEN: Terminal — OCI CLI provisioning commands scrolling]**

**NARRATION:**
> "Provisioning on OCI Marketplace takes about twenty minutes: create the VCN, launch the Essbase VM from the Marketplace image, attach and format the Block Volume for ARBORPATH, and run the outline MaxL script. The Essbase binary is identical to on-premise. The same MaxL commands work without modification."

---

## Section 10 — Monitoring Checklist (10:45–11:45)

**[SCREEN: Slide — monitoring table with green/amber/red status icons]**

| Monitor | Command | Alert Condition |
|---------|---------|----------------|
| App running | MaxL: QUERY SYSTEM LIST APPLICATIONS | IronField not LOADED |
| Load errors | Check error file size | Error file non-empty |
| Block count after calc | DB_STATS query | Count drops > 20% |
| Calc time | Time the MaxL execute | > 300 seconds |
| Data freshness | MDX spot check on CurPer | Units Produced = MISSING |
| OCI volume usage | df -h /u01/config/essbase | > 80% full |

**NARRATION:**
> "Six monitors cover the IronField application. The most important is the load error check — a single rejected row in Units Produced means the month-end total is understated, and managers will see wrong numbers. The data freshness MDX query is the second most important — it catches the case where the EBS extract was generated but the import MaxL command failed silently. Run these six checks as a cron job immediately after every monthly load."

---

## Section 11 — Closing (11:45–12:30)

**[B-ROLL: AI-generated — see Prompt B]**
*Server room with glowing rack lights. Data flowing as light streams. Cut to clean office with analyst looking at a dashboard on a monitor.*

**NARRATION:**
> "The IronField application is 430 blocks. A real deployment for a manufacturer with dealer networks and regional breakdowns might be two hundred thousand blocks. The outline design principles are identical — identify which dimensions are dense, classify everything else sparse, use Dynamic Calc for derived measures, and write calc scripts in two passes when overhead allocation precedes aggregation. The hosting decision follows from usage pattern. Seasonal and periodic loads belong on OCI. Permanent high-throughput OLTP planning belongs on-premise or on OCI with a dedicated shape."

**[SCREEN: End card]**
- Blog post URL: appsdba.vercel.app/posts/essbase-tractor-manufacturing-application-outline-oci
- Subscribe prompt
- Related post links: "Essbase Outlines, Applications, and Hosting" · "Oracle EBS Workflow Performance"

**NARRATION:**
> "The full working MaxL, calc scripts, and OCI CLI commands are in the blog post linked below. If this helped, subscribe — we cover Oracle EBS, Essbase, RAC, GoldenGate, and cloud migrations for DBAs who work with Oracle in production."

---

## Section 12 — AI Video Generation Prompts

These prompts are designed for **Google Veo 3** (aistudio.google.com) or **OpenAI Sora**.
Each generates a 5–10 second clip. Stitch in DaVinci Resolve or CapCut.

---

### Prompt A — Opening B-Roll (Cold Open, 0:00–0:30)

> Cinematic aerial footage of a modern tractor assembly plant interior. Wide shot looking down a production line. Large green-and-yellow agricultural tractors in various stages of assembly. Robotic welding arms moving precisely along tractor frames. Bright industrial lighting. Workers in high-visibility vests walking alongside the line. Camera slowly pushes forward down the center of the assembly hall. Photorealistic, 4K quality, warm industrial color grading. No text overlays. Duration 8 seconds.

---

### Prompt B — Closing B-Roll (11:45–12:00)

> A modern server room with blue and white LED rack lighting. Rows of black server racks extend into the distance. Subtle light streams animate along cable paths suggesting data flowing. Camera slowly dollies forward down the aisle between racks. Clean, professional, cinematic lighting. No people. Photorealistic. Duration 6 seconds.

---

### Prompt C — Transition: ERP to Cube (between Section 2 and 3)

> Abstract visualization of data transforming. On the left, rows of numbers and table cells in a spreadsheet grid. Lines of data lift off and rearrange into a glowing three-dimensional cube structure with labeled axes. The cube rotates slowly. Dark background with cool blue and orange accent lighting. Clean and technical aesthetic. Duration 5 seconds.

---

### Prompt D — Transition: On-Premise to Cloud (between Section 9 paragraphs)

> A physical server tower sitting on a desk slowly fades and dissolves into an abstract floating cloud shape made of connected light nodes. The transformation is smooth and elegant. Dark background. Blue and white color palette. No text. Duration 5 seconds.

---

### Prompt E — Thumbnail Image Prompt (for Veo image mode or Midjourney)

> Oracle Essbase cube visualization: a glowing three-dimensional translucent blue cube with labeled dimension axes — Model, Plant, Time, Scenario. In the foreground, a realistic compact tractor (green and yellow). Background: dark gradient. Text overlay space at top: "Essbase for Manufacturing". Cinematic, professional, 16:9 aspect ratio, photorealistic style with soft blue lighting.

---

## YouTube Video Metadata

**Title:**
Building an Essbase Application for Tractor Manufacturing — Outlines, Calc Scripts & OCI Hosting

**Description:**
```
A complete walkthrough of designing and deploying an Oracle Essbase BSO application for a tractor manufacturing business.

Covers:
0:00 – Introduction: why ERP alone can't answer multi-dimensional manufacturing questions
1:30 – IronField Equipment: business context, product lines, plants, and measures
2:30 – Dimension design: Dense vs Sparse classification with sizing math
4:30 – Consolidation operators: +, -, ~, ^ explained with real examples
5:15 – Building the outline in MaxL: CREATE APPLICATION through AGG
7:00 – Data load rules: mapping EBS CSV extract columns to Essbase dimensions
8:00 – Calc scripts: two-pass overhead allocation and budget seeding
9:15 – On-premise vs OCI Marketplace: architecture, sizing, and seasonal cost comparison
10:45 – Monitoring: six checks to run after every monthly data load

Full blog post with all MaxL commands, calc scripts, and OCI CLI:
https://appsdba.vercel.app/posts/essbase-tractor-manufacturing-application-outline-oci

Related posts:
→ Essbase Outlines, Applications, and Hosting: On-Premise vs OCI
→ EBS Workflow Slow Performance: Diagnosing Unsent Notifications

#OracleEssbase #EPM #OracleEBS #OCI #HyperionPlanning #OracleDBA
```

**Tags:**
Oracle Essbase, Essbase tutorial, Essbase outline, BSO cube, Hyperion Planning, Oracle EPM, OCI Essbase, Essbase MaxL, Essbase calc script, Oracle EBS integration, Essbase on OCI, manufacturing analytics, Oracle DBA, Essbase Dense Sparse

**Thumbnail:** Use Prompt E above. Add bold white text: "Essbase for Manufacturing" top-center, and "IronField Tractor Example" smaller below it.

**End screen (last 20 seconds):**
- Subscribe button
- Link card: "Essbase Outlines & Hosting" post
- Link card: "Oracle Host Performance Troubleshooting" post

---

## Recording Checklist

- [ ] Terminal: dark theme (Dracula), font size 18pt minimum, 1920×1080
- [ ] Slow down typing on MaxL — 30 WPM so viewers can read
- [ ] Pause 2 seconds on each key formula before moving on
- [ ] Diagrams: draw live on screen (Excalidraw) rather than revealing static slides — more engaging
- [ ] Record narration separately in a quiet room; sync to screen recording in post
- [ ] Generate AI B-roll clips (Prompts A–D) and insert at marked timestamps
- [ ] Export at 1080p60, H.264, for YouTube upload
- [ ] Set video chapters in YouTube description using the timestamps from this script
