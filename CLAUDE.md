# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Customer Balance Dashboard — Arabic RTL web app for tracking customer invoices, balances, fridge assets, and sales activity. Stack: React (Vite) + Node.js/Express + PostgreSQL, deployed via Docker Compose with Nginx.

## Commands

### Development & Deployment
```bash
# Full rebuild after any code change (required — code is baked into images)
docker compose build && docker compose up -d

# Quick restart without rebuild (only for config/env changes)
docker compose restart

# View logs
docker compose logs -f backend
docker compose logs -f frontend

# Access DB directly
docker exec -it cb_postgres psql -U cbuser -d customer_balance_db
```

### Local development (without Docker)
```bash
# Backend
cd backend && npm install && npm run dev   # nodemon on port 3000

# Frontend
cd frontend && npm install && npm run dev  # Vite on port 5173 (proxies /api → localhost:3000)
```

## Architecture

### Infrastructure
- `docker-compose.yml`: four services — `cb_postgres`, `cb_backend` (port 3000), `cb_frontend` (Vite build), `nginx` (port 80)
- `nginx.conf`: proxies `/api/` → `backend:3000`, SPA fallback, 60 MB upload limit
- DB credentials: `cbuser` / `cbpassword` / `customer_balance_db`

### Auto-Migrations
Backend runs all `.sql` files in `backend/src/db/migrations/` alphabetically on startup (tracked in a `migrations` table). To add a migration, create `0XX_description.sql` — it applies automatically on next `docker compose up`.

Key tables: `invoices`, `customers`, `regions`, `routes`, `sales_activity`, `fridges`, `fridge_transfers`, `sales_tasks`, `sales_supervisors`, `payments`.

### Authentication & RBAC
- JWT stored in `localStorage`, injected by axios interceptor (`frontend/src/api/client.js`); 401 → auto logout
- `useAuth()` hook from `frontend/src/context/AuthContext.jsx`
- Backend middleware in `backend/src/middleware/auth.js`:
  - `verifyToken` — validates JWT on every protected route
  - `requireRoles(...roles)` — restricts to specific roles (e.g. `['super_admin', 'it_admin']` for fridge writes)
  - `applyRegionFilter` — forces `region_id` filter for `region_manager` role

Roles: `super_admin`, `it_admin`, `region_manager`, `viewer`

### Backend Routes (`backend/src/routes/`)
- `invoices.js` — KPI aggregations, customer summaries, monthly/regional breakdowns; `buildConditions()` helper maps query params to SQL WHERE clauses
- `upload.js` — Excel file parsing (customer_balance, payments, sales_activity); route map building
- `fridges.js` — CRUD for fridges + fridge transfers; sales report with pre-aggregated join (see pattern below)
- `salesTasks.js` — Task management, file attachments, notes
- `auth.js` — Login, JWT issuing
- `lastUploads.js` — Returns timestamps of most recent upload per report type

### Frontend Pages & CSS Prefixes
Each page has a matching `.css` file with a unique class prefix to avoid collisions:

| Page | Prefix | Description |
|------|--------|-------------|
| `Dashboard.jsx` | `db-` | Main KPI dashboard |
| `FridgesPage.jsx` | `frg-` | Fridge list + sales report |
| `SalesActivityPage.jsx` | `sap-` | Sales activity report |
| `SalesTasksPage.jsx` | `stp-` | Sales tasks management |
| `NationalReportPage.jsx` | `nr-` | National summary report |
| `SummaryPage.jsx` | `sm-` | General summary: KPIs, charts, deviation |
| `RepDebtPage.jsx` | `rd-` | Rep debt drill-down (`/rep-debt/:repName`), invoices + per-customer net tabs |
| `HypermarketsPage.jsx` | `hm-` | Hypermarkets-category performance (hardcoded category) |
| `DiscountShopsPage.jsx` | `ds-` | Discount Shops performance — hardcoded **customer_code list** (40 codes), not `category_name` (see below) |
| `CategoryPerformancePage.jsx` | `cp-` | Same analytics for ANY customer category (`?category=`, "الكل" = no filter) + customer search/annual panel |
| `RegionPerformancePage.jsx` | `rp-` | Region assessment + growth forecast engine (`/region-performance`) |
| `QualityIssuesPage.jsx` | `qi-` | Quality-issue (توالف الجودة) upload + monthly region trend (`/quality-issues`) |

### Key Frontend Patterns

**React Query**: All data fetching via `@tanstack/react-query`. Cache keys include filter params so queries auto-refetch on filter change.

**`usePageLayout` hook** (`frontend/src/pages/usePageLayout.js`): Manages list/card layout toggle, persisted to localStorage key `sap-layout-v2`.

**Filter params**: `buildParams(filters)` in Dashboard.jsx converts filter state → API query params. Filters include `region_id`, `status`, `route_id`, `search`, `sales_rep_name`, `activeYears`, `activeMonths`, `includeDirect`.

## Critical Business Logic

### Fridge Sales Report — Pre-aggregation Pattern
The sales report joins `fridges` with `sales_activity`. To avoid Cartesian product when a customer has multiple fridges AND multiple invoices, `sales_activity` is pre-aggregated per `customer_code` in a subquery **before** joining:
```sql
WITH sa AS (
  SELECT customer_code, SUM(qty) AS total_qty, COUNT(*) AS invoice_count
  FROM sales_activity WHERE ...
  GROUP BY customer_code
)
SELECT f.*, sa.total_qty, sa.invoice_count,
  COUNT(DISTINCT f.id)::int AS fridge_count,
  COUNT(DISTINCT CASE WHEN f.status = 'active' THEN f.id END)::int AS active_fridge_count
FROM fridges f LEFT JOIN sa ON sa.customer_code = f.customer_code
GROUP BY ...
```

### Fridge sales report — the period filter reads `sales_activity`'s OWN dates
`report_year` / `month_num` / `day`, **never** `invoices.invoice_date`. The query used to INNER
JOIN `invoices` to take the date from there, which silently discarded every sale whose invoice is
absent from the balance file — that upload only carries invoices with an open balance. Effect on
production: **100% of Jeddah vanished** (806 units; the region has no invoice rows at all) plus 610
units of Riyadh, and those customers rendered as "غير متعاملة · 0" while their sales sat in the
table.

The join bought nothing measurable: across all 457,365 rows that DO match an invoice the two date
sources disagree on year, month and day exactly **zero** times. After the change August rose by
exactly 239 units / 3 customers (the Jeddah ones) and July was byte-identical at 301,634 — so the
fix recovered the missing data and moved nothing else. Any future "why is this customer showing
zero" starts by checking whether the query passes through `invoices`.

### Data-integrity check (`GET /api/upload/data-integrity`, panel on the Upload page)
All four files key on the **customer code**: `customers` (Customer List - CM, the only source of
route + salesman + supervisor) ← `invoices` (debt) ← `payments` (collection) ← `sales_activity`
(quantities). The panel reports, per region, how many of its customers appear in each file, and
flags the failure mode that is otherwise **invisible**: a region fully set up — customers, routes,
salesmen, live sales and collections — showing **zero debt only because the balance file contains
none of its rows**.

Live findings (15 Aug 2026): **Jeddah** — 74 customers, 13 with sales, 12 with collections,
**0 with invoices** → its debt reads 0 on the dashboard. Routes 1901–1904 exist in `routes` and map
to region 10 correctly, and no Jeddah invoice is misfiled under another region, so the mapping is
ready; the balance export simply omits Jeddah. Also reported: 19 payment codes + 3 sales codes
absent from the master (they can never gain a route or a salesman), and 5 of 51 master salesmen
with no sales activity.

**Two query shapes to avoid here** — both hung this endpoint for minutes before being rewritten
set-based: a correlated `EXISTS` against `sales_activity` (457K rows) evaluated per customer, and
`NOT EXISTS ... WHERE TRIM(a) = TRIM(b)`, which defeats `idx_sa_rep`. Use `DISTINCT` CTEs and hash
joins; the endpoint now answers in 1.5s.

### Daily Target Calculation
- Daily target per fridge: **40 units**
- Customer target = `40 × workingDays × active_fridge_count` (only `status = 'active'` fridges count)
- Working days MTD: count days from 1st to today (or month end), **skipping Friday only** (dow === 5); Saturday is a work day
- Achievement % = `total_qty / target × 100`

### Risk Levels (achievement %)
| Level | Threshold | Urgent |
|-------|-----------|--------|
| ✅ محقق | ≥ 100% | No |
| 🟢 جيد | ≥ 80% | No |
| ⚠️ متابعة | ≥ 60% | No |
| 🔶 خطر | ≥ 40% | Yes |
| 🔴 خطر عالي | ≥ 1% | Yes |
| 🚨 حرج | 0% | Yes |

Risk filter groups: "تحتاج أكشن فوري" = all urgent levels; "محقق وجيد" = top two levels.

### Invoice counts over `sales_activity` MUST be `COUNT(DISTINCT invoice_number)`
`sales_activity` holds one row per invoice **line**, averaging **2.17 lines per invoice**
(457,508 rows / 211,108 invoices), so `COUNT(*)` counts lines and overstates "عدد الفواتير" by
roughly 5×. On the Hypermarkets branch table it read 6,371 invoices when the true figure is
**1,285** (Riyadh 5,388 → 1,055). Fixed in 14 places: `hypermarkets.js` ×6,
`categoryPerformance.js` ×6, `coverage.js` ×2 (`invoice_count` and `day_orders` — an "order" is an
invoice, not a line).

Also fixed in `salesActivity.js` ×2 — the "إجمالي الفواتير" KPI and its per-month breakdown read
128,522 for 2026 when the true figure is **55,709** (July 18,804 → 8,169; August 9,791 → 4,230).
Safe to sum the months against the year: no invoice number appears in two different months
(verified on production), and the eight months now add up to 55,709 exactly.

A repo-wide sweep confirms every remaining `COUNT(*)` touching `sales_activity` is correct:
`invoice_lines` (named as lines on purpose), `visits` / `total_visits` (over a
`DISTINCT (rep, customer, day)` subquery), `active_customers` / `inactive_customers` (over
per-customer CTEs), and the integrity-panel CTE counts. `regionPerformance.js` already used
`COUNT(DISTINCT sa.invoice_number)` in all five of its invoice counts.

Two counts that legitimately stay `COUNT(*)`:
- over `invoices` (`aging.js`, `export.js`) — one row there **is** one invoice;
- `active_customers` in the hypermarkets/category summaries — it counts rows of a CTE already
  grouped by `customer_code`.

Quantities and customer counts were unaffected by the fix (94,578 qty / 17 customers before and
after); only the invoice column moved.

### Inactive Customer Count
Customers with `total_qty <= 0` (including returns/negative corrections) are counted as "غير متعاملة". Use `<= 0`, not `=== 0`.

### Debt Balance — the ONE rule
"رصيد الديون" / net debt is **always plain unconditional `SUM(balance)` with NO status filter**, at every grouping level (customer / rep / region / grand total). A `paid`-status invoice can carry a negative leftover balance (a return or credit note netted against it) and that negative **must** net into the total. Never reintroduce `status IN ('partial','unpaid')` on a `SUM(balance)` aggregate. Corollary: any list of invoices whose rows must foot to a net total filters on `balance <> 0`, **not** on status.

Two standard exclusions when reporting debt:
- `LOWER(TRIM(sales_rep_name)) <> 'direct'` — the central-warehouse pseudo-rep. Without it Shaqraa shows 8.49M instead of its real ~349K.
- Optional Carrefour toggle on SummaryPage: `customer_name NOT ILIKE '%كارفور%'` (~1,151 invoices / 593K).

**Carrefour toggle on AgingPage** (`exclude_carrefour=1`, `aging.js`): matches **both** name
columns (`customer_name ILIKE '%كارفور%'` OR `customer_name_en ILIKE '%carrefour%'`). They agree
on every current row — 434 open invoices, 13 customers, 560,649.07 either way — but relying on one
alone breaks the day a record fills in only the other. OFF by default: it is real debt and hiding
it unasked understates the book. **One state drives both the ageing tabs and the old-debt
tracker** (the tracker already had its own client-side Carrefour switch; it was lifted to page
scope rather than adding a second one that could disagree), and both endpoints take the param, so
no two tabs can show contradictory totals. The print header names every active exclusion — a
printed report that silently drops 560K would mislead whoever reads it away from the screen.

### Region name storage gotcha
`regions.name_ar` actually stores the **English** branch identifier ("Riyadh", "Al-Qassem", …), and `sales_activity.branch_name` matches it. But **live NetSuite feeds** (`webquery.nl`) return genuine Arabic location text ("الرياض", "القصيم"). Any route that scopes a live NetSuite feed by `req.regionFilter` therefore needs an English→Arabic translation map, or region-restricted users silently see zero rows. Already handled in `currentStock.js`, `collections.js`, `salesReport.js`.

### Visits & the daily-visit target
A **visit** = one distinct `(salesrep_name, customer_code, day)` row in `sales_activity`. Daily productivity is `visits ÷ distinct rep-days actually worked` (not ÷ official working days — an absent day shouldn't dilute it). Target band is **10–15 visits/day** (`regionPerformance.js`). Actual company-wide H1 2026 ran 7.0–8.8, so the gap is a real, priced growth lever.

### API-side page permissions
`requirePagePermission(pageKey, minLevel)` in `middleware/auth.js` reads the `page_permissions` table instead of a hardcoded role list, so granting a role access on the Permissions page actually takes effect on the API. `super_admin`/`it_admin` always pass. Use it for any new page whose API must honour the Permissions screen — `commissions.js` was broken until it did.

## PDF / Print Export Pattern
All pages use `window.print()` + `@media print` CSS — no external library needed (handles Arabic RTL natively).

Standard implementation per page:
1. `handlePrint` sets `document.title` (becomes PDF filename), calls `window.print()`, restores title via `window.onafterprint`
2. Hidden `<div className="XXX-print-header">` shown only in print (`display:none` → `display:flex !important`)  
3. `XXX-no-print` class hides action buttons, filter bars, navigation
4. `AppLayout.css` `@media print` globally hides `.navbar`, `.sidebar`, `.bottom-nav` and removes shell padding
5. Each page's `@media print` block: `@page { size: A4 landscape; margin: 1.2cm 1cm; }`, force `print-color-adjust: exact`

## Database Migrations Added This Session
- Migration 022: `fridges` table (id, customer_code, region_id, serial_number, model, capacity, status enum `fridge_status`, install_date, notes) + `fridge_transfers` table
- Migration 014: `sales_activity` table (invoice_number, customer_code, report_year, qty, ...), unique on `(invoice_number, report_year)`
- Migration 020: `sales_tasks`, `sales_supervisors`, `sales_task_files`, `sales_task_notes` tables
- Migration 047: `bad_return_qty INTEGER NOT NULL DEFAULT 0` added to `sales_activity`
- Migration 048: `page_permissions` rows for `summary` page key (all roles)
- Migration 070: `user_regions` join table — a user can hold multiple regions (JWT carries `region_ids[]`)
- Migration 071: `from_region_id` / `to_region_id` on `fridge_transfers` (repair pickup vs delivery region)
- Migration 072: `page_permissions` rows for `category_performance`
- Migration 073: `page_permissions` rows for `region_performance`
- Migration 074: `quality_issues` table + `page_permissions` rows for `quality_issues`
- Migration 075: adds `'quality_issues'` to the `upload_file_type` enum (`upload_batches.file_type`)
- Migration 076: `rep_debt_snapshots` table — freezes each rep's outstanding balance for a closed month on first read (`utils/debtSnapshot.js`), so commissions/performance for past months stop drifting
- Migration 082: `fridge_transfer_requests` + `notifications.fridge_request_id` — the fridge transfer request/approval workflow (see below)
- Migration 081: `customers.customer_name_ar` — Arabic name from the export's "Customer Name Arabic" column
- Migration 080: `customers` master table + `customer_list` upload enum value — the app had NO customer master before this (see below)
- Migration 079: `fridge_notes` + `fridge_notes_history` — user notes on a fridge with an append-only trail (see below)
- Migration 078: `fridges.pending_contract` / `pending_contract_since` + `fridge_transfers.pending_contract` — the "بانتظار توقيع العقد" flag (see below)
- Migration 077: `regions` row for Jeddah (id 10) — remember to also extend the EN→AR maps in `currentStock.js` / `collections.js` / `salesReport.js` / `qualityIssues.js` / `CoveragePage.jsx` for any future region

## Region Performance & Planning (`/region-performance`)

`backend/src/routes/regionPerformance.js` — two endpoints, `/filters` and `/assessment`.
`/assessment?branch=&year=&from_month=&to_month=&cust_category=` returns everything the page needs in one
round-trip: `monthly[]` (qty, revenue, ASP, active/inactive/new/lost customers, visits, visits_per_day,
active_reps, damages%, invoiced, collected, collection%, debt_ratio), `totals`, `current` (current_debt,
registered_customers, reps/routes on books, coverage%), `visit_gap` (priced at actual revenue-per-visit),
`trend` (least-squares slope + `slope_pct` per metric), `by_customer_category`, `by_item_category`,
`by_item`, `by_rep` (with per-rep monthly `series` + `visit_status`), `rep_month_matrix`,
`monthly_by_region`.

**`cust_category` is a REPEATED key**, listing the sales channels to KEEP — `custCatScope()`
normalises it (single value still accepted, de-duplicated, lower-cased) and every site matches with
`LOWER(TRIM(COALESCE(sa.category_name,''))) = ANY($n::text[])`. The UI (`CustCatPicker`) stores the
same KEEP list and treats **empty as "الكل"**, so an unfiltered request is byte-identical to the one
the old single-value `<select>` produced, and a channel added later is included by default rather
than silently dropping out of saved views. Because empty means all, the boxes render ticked when
nothing is picked — unticking one therefore yields "every channel except this one" in a single
click, which is how the exclusion case is expressed; the last remaining tick cannot be removed,
since an empty scope would read as "الكل" and show the opposite of what was asked. The scope is
passed straight through to the comparison and daily-ASP tabs so all three read the same slice.

Verified live (Jan–Jun 2026): the 8 channels picked together = the 8 picked one at a time =
unfiltered, all three at 4,542,121 units / 61,099,783.00 SAR (no uncategorised rows exist);
"الكل عدا Hypermarkets" = 4,482,828, exactly the total less Hypermarkets' 59,293; a value sent twice
and a value sent in the wrong case both match the single-value result. `Agents` and `Direct Sales`
legitimately return **zero** — `sales_activity` has no 2026 rows for them at all (last traded 2025
and 2024), which is data, not a filter fault.

**`from_day` / `to_day`** narrow the window *inside* the first and last selected month.
`dayClampSql()` expresses this as "drop what falls before `from_day` in the first month and after
`to_day` in the last month", never as a `BETWEEN` on a constructed date — the month grouping every
query depends on stays untouched, and a day that does not exist in that month (31 in June, 29 in a
non-leap February) can never raise a date-construction error. With 1 → 31 the fragment is **empty**,
so an unclamped request produces byte-identical SQL to the version before days existed. The clamp
is applied to `sales_activity`, `invoices`, `payments` and `quality_issues` (each with its own
month/day expression), and deliberately **not** to `fyWhere` or the year-reported census, which are
calendar-year constructs by design. `fromMonth === toMonth && toDay < fromDay` is a 400.

Verified live: Jan–Jun with and without `1..31` are identical to the unit and the halala
(4,542,121 / 61,099,783.00); August split at the 15th foots back to the whole month on qty,
invoiced and collected; a 5 Jun → 10 Aug window matches independent SQL exactly on all three
(1,694,272 units, 22,820,988.41 invoiced, 22,171,552.83 collected). August 16–31 reads zero because
every one of the three tables stops at day 15 — data, not a clamp fault. `sa.day` is NOT NULL on all
rows, so the comparisons need no COALESCE.

**`monthly_by_region`** is a flat `[{ branch, region_id, month_num, …same fields as monthly }]`
array powering the expandable region detail rows under each month in "التقييم الشهري التفصيلي".
Both series are produced by a single `buildMonthRow()` helper so a metric can never drift between
a month row and the region rows beneath it. Two things to know:
- The sales side keys on `sa.branch_name` while invoices / payments / quality issues key on
  `region_id`; they are stitched via the `regions` table, trying **both** `name_ar` and `name_en`
  (see the region-name gotcha above).
- Payments are booked to each customer's **primary** region (the one holding most of its
  invoices). A customer with invoices in two regions would otherwise have its payments counted
  in both, and the region rows would over-foot the month row.
Verified against production: qty, revenue, invoiced and qi_cost reconcile to the month row with
zero difference. `collected` can carry a tiny residual (~0.007%) — payments from customers who
have no invoice row with a `region_id` cannot be attributed to any region, so they land in the
month total but in no region row.

Each row also carries `prev_asp` / `asp_delta_pct` (ASP of the preceding month and the % change).
The preceding month is read even when it falls **outside** the selected range, so the first row
of a single-month view still compares against something real instead of rendering "—".

### Daily ASP tracking tab (`GET /asp-daily`)
`/region-performance` → «تتبع ASP اليومي». Day-precise ASP per region (same `make_date`
reconstruction as `/period-compare`), rendered as **one table per week** — a six-month range is
~150 days and 150 columns in a single table is unreadable at any font size. Each week block is
regions × that week's days + the week's own weighted average; a summary table below carries
**«المتوسط العام لجميع الأيام»** per region.

- **Weeks start Saturday** (`WEEK_START_DOW = 6`): the business works Sat–Thu and rests Friday, so
  a Sunday-start week splits every working week across two blocks.
- Every average is **weighted** (Σrevenue ÷ Σqty), never the mean of daily ASPs — a 300-unit
  Tuesday must not count the same as a 30,000-unit Sunday. Verified: the July total reads 13.4028,
  identical to `/period-compare`, and each region matches its period-compare figure exactly.
- **Three exclusions keep "cheapest region today" honest**, and each is visible in the grid rather
  than silently dropped:
  - days below `min_qty` (default 100 units, adjustable in the UI) — shown greyed with a «؟»;
  - days with **ASP ≤ 0**, i.e. returns-dominated (real case: Riyadh 2026-07-26, 311 units but
    −1,232 ر.س over 54 invoices) — shown in purple, and counted in an «أيام مرتجع» column. Left in,
    a negative day would win "lowest" every time, since no real price beats a negative number;
  - **the whole ranking is suppressed when only one region is in scope** (`meta.rank_lowest`) —
    filtered to Riyadh it was "lowest" on 208 of 214 days, true but useless.

### Period comparison tab (`GET /period-compare`)
`/region-performance` → «مقارنة فترتين». A region × metric matrix comparing **two arbitrary
date ranges**, each metric shown as ف1 · ف2 · الفرق · النمو% (7 metrics → 29 columns):
صافي الكميات · التوالف · توالف الجودة · العملاء · التحصيل · قيمة المبيعات · متوسط السعر.

Unlike every other reading on this page it is **day-precise**: `sales_activity` keeps
year/month/day in three smallints, so the date is rebuilt with
`make_date(report_year, month_num, day)`. Verified on production — `day` is populated on all
455,021 rows (2024–2026) and the reconstructed ranges reproduce the `month_num` aggregates
exactly, so nothing is dropped. It is deliberately independent of the page's year/month
sliders (the point is ranges the month filter cannot express), but the branch /
customer-category / item-category filters still apply.

- Growth is `(B−A)/A`, and **null when A ≤ 0** — a region that sold nothing in the first period
  has no growth rate, and ∞/100% would read as a real number in a scoreboard.
- Overlapping ranges put the shared days in period A only (the SQL `CASE` stops at its first
  true branch); the UI warns when it detects an overlap.
- `التوالف` and `توالف الجودة` are inverted for colouring — a drop is green. Both carry **two
  stacked lines inside one column** (كمية/قيمة and قيمة/كمية) rather than four more columns.
- **`damages_value`** is priced on the return line itself —
  `SUM(bad_return_qty * net_revenue/NULLIF(qty,0))`, not `damages × the group's ASP`. A return
  line books a negative `qty` and a negative `net_revenue`, so their ratio is that line's real
  unit price; all 773 damage lines in Jun–Jul 2026 carry `qty < 0` (none at zero), so every one
  is priceable. This matters because line-level pricing is **grouping-invariant**: Riyadh's reps
  sum to exactly the region's 49,623.00, whereas ASP-based pricing gave 59,590 vs 57,556 and the
  column stopped footing when you drilled.
- The **customers total** is its own un-grouped `COUNT(DISTINCT customer_code)`, not the sum of
  the region rows: a customer trading in two regions is distinct in each.
**Drill-down (`&group=rep&branch=X`)**: clicking a region name re-renders the identical matrix for
that region's reps, with a back button. Rep totals foot exactly to the region's row (verified on
Riyadh and Hael: qty/revenue/damages/collected/customers/ASP all identical). Two metrics change
meaning at rep level and the response says so in `row_metrics`:
- **`qi_cost` is null per rep** — `quality_issues` records a region and nothing else; there is no
  rep dimension in the source report. Rows render "—" and the region total stays in the footer
  (carried in `unattributed`), rather than inventing a per-rep split.
- **`collected` is derived** — `payments` has no rep column, so a payment is booked to the rep who
  served that customer most in the compared windows (same "primary owner" rule the region mode
  uses). Payments from customers with no `sales_activity` line in either period have no owner and
  land in `unattributed` (~1% of a region's collections).

- Payments are booked to each customer's primary region, same as `monthly_by_region`. Whatever
  the `cust_region` join drops (customer has no invoice carrying a `region_id` — ~0.09%, about
  10K ر.س in July 2026) is added back into the footer and reported in `unattributed.{a,b}` so
  the footer stays the true company figure and the gap to the sum of the rows is explainable.

### Adding a sales channel the region has never sold to
Under the monthly channel matrix, «إضافة قناة بيع غير موجودة بالمنطقة» (`MissingChannels` +
`newChannels` state, saved into the region plan). A channel with zero quantity **cannot** be
reached by the mix tilt — the tilt is multiplicative and zero stays zero — so it is modelled
differently on purpose:
- It joins `aspModel.cats` with `qty: 0`, therefore carries zero weight in `A0` and in every
  tilt calculation. It contributes nothing *today*, which is the truth.
- Its share is **injected at the end of `aspPlan`**: the requested target shares are reserved
  (capped at 90% in total) and taken off every other channel pro rata. Total quantity is
  unchanged — the new channel takes volume from the existing mix, it does not invent any.
- Its price defaults to the cross-region benchmark (`category_asp_benchmark` — what another
  region actually achieves on that channel) and is editable. **A channel with no benchmark and
  no typed price is silently skipped rather than priced at zero** — the panel says
  «لا يوجد — أدخل السعر يدوياً» and it stays out of the mix until a price is given.
- `aspMonthly` needs no special case: it already ramps each channel from `share` to `new_share`,
  and a new channel simply starts at 0.

### Planning tab is hidden from supervisors and region managers
`PLAN_HIDDEN_ROLES = ['supervisor', 'region_manager']` in `RegionPerformancePage.jsx` removes the
«التخطيط والتوقعات» tab, the "تضمين السيناريو بالطباعة" print toggle, and the two planning sheets
of the Excel export («خطة مزيج ASP», «الخطة والتوقعات» — 14 sheets become 12). Everything
backward-looking stays available to them. `page_permissions` has page-level granularity only, so
there is no tab-level row to drive this from the Permissions screen; changing who is restricted
means editing that constant (or adding a dedicated page_key + migration).

**This is a UI restriction, not an API one.** `GET /region-performance/plan` and `/plans` still
answer these roles at access_level 1, because other tabs consume the saved plan (the ASP-target
column of the half-year table). Anyone calling the API directly can still read the saved targets.

### Weighted scorecard (`scorecard` in the /assessment response)
Six indicators — ASP 20% · invoices per rep-day 20% · kg per rep-day 20% · invoices per customer
per month 15% · revenue momentum 15% · qty momentum 10%. Benchmark is the **peer median**:
regions against all regions, a rep against the reps of their own region. Each indicator scores
`value ÷ benchmark` capped at its weight; indicators that cannot be computed are dropped and the
remaining weights rescaled to 100%, so missing data never reads as a failure.

Momentum compares the last 3 **complete** reported months against the first 3 of the range — the
running calendar month is excluded because a part-billed month reads as a collapse. With a Jan–Aug
range in August that resolves to May–Jul vs Jan–Mar and rolls forward by itself.

**Known limitation, by design:** against a median benchmark the capped score saturates — half the
field is at or above the median on any indicator and therefore takes full marks on it. On real
2026 data the top four regions land at 99.0–100. `score_uncapped` is returned alongside and
separates them properly (Al-Qassem 160.9 vs Hael 127.7 vs Riyadh 107.1). Switch the displayed
field if ranking matters more than "met the bar".

The kg indicators depend on `QTY_KG_SQL` — see the weight-parsing note under Region Performance.

### Churn columns — one definition app-wide
`جدد` / `عائدون` / `مفقودون` in `regionPerformance.js` are deliberately identical to
`salesActivity.js` `/region-stats`, which تقرير العملاء renders:
- **جديد** — the customer's FIRST month in this `report_year` **and** no invoice in any earlier
  year (`invoices.year < $1`).
- **عائد** — same first month this year, but it *does* have earlier-year invoices.
- **مفقود** — traded last month, did not trade this month.

The obvious-looking rule "not present in the previous month" is **wrong** and was the original
bug: it counts a customer that merely skipped one month as new (August 2026 read 40 instead of
8). جديد/عائد therefore look at the whole year up to that month, never just the month before,
and never just the selected range. Only مفقود needs a previous-month baseline — `churn_baseline`
in the response names which month that was, crossing into the previous year for January.
A cross-check script comparing both endpoints region-by-region is the way to verify any change here.

The **forecast engine is client-side** (`RegionPerformancePage.jsx` `useMemo`) so the sliders respond
instantly without refetching. Its method:
- **Baseline** = mean of the last 3 actual months (steadier than the final month, which may be a seasonal dip).
- **Growth** = compound monthly `(1+g)^n` applied to the baseline only, so each lever's contribution stays
  separately attributable in the table.
- **New rep / new route** contribution = the *existing* average productivity per rep/route × a ramp-up curve
  `[40%, 70%, 100%]` for their 1st/2nd/3rd-onward month.
- **`linkRepRoute`** (default on) prevents double-counting: a new rep normally opens a new route, so only
  routes *beyond* the new-rep count are added separately.
- **Visit uplift** = `(target_vpd − actual_vpd) × avg_rep_days_per_month × revenue_per_visit`, discounted by
  an adjustable realization %.
- Scenario presets (محافظ / متوازن / طموح) are derived from `trend.revenue.slope_pct`, clamped to 0–30%.

## Customer master (`customers`) — "Customer List - CM" upload

Before migration 080 there was **no customer master anywhere in the schema**: customer attributes
lived only as denormalized copies on transactional rows (`invoices.customer_name`,
`sales_activity.category_name`), so a customer with no invoice this period was invisible, and
supervisor / creation-source had nowhere to live at all. `POST /api/upload/customer-list` loads
the periodic "Customer List - CM" export into it (card on the Upload page).

- **Upsert keyed on `customer_code`, never truncate-replace.** The export is a full list, but a
  partial or filtered download would otherwise wipe the master. A customer missing from a later
  file is left untouched. Every field uses `COALESCE(EXCLUDED.x, customers.x)` so a blank cell
  never erases data already on file.
- **Arabic and English names are separate columns.** The export carries both; `customer_name_ar`
  is kept beside `customer_name` rather than overwriting it, because NetSuite keys its reports on
  the English name while the dashboard displays the Arabic one. The lookup returns Arabic first
  (`sources.customer_name === 'customer_list_ar'`) and falls back to English when the Arabic cell
  is blank — never to null. Note `Customer Name Arabic` also PREFIX-matches `Customer Name`, so
  both must resolve on the exact-match tier; verified they bind to different columns with zero
  duplicate bindings.
- **Column matching is tiered** (`pick()`): exact, then shared-prefix tolerating ONE lost final
  character — this export's header row arrives visually truncated (`Customer Co…`, `Route Cod…`,
  `Is Created From H…`). Among prefix candidates the **longest** column name wins, otherwise
  `Customer Category Name` binds to the earlier `Customer Category` code column and the code is
  imported as the name. Verified against both header variants.
- The response reports `matched_columns`, `duplicate_bindings` (two fields resolving to one
  column) and `unmatched_branches`; the UI shows all three. A branch name with no matching region
  leaves `region_id` null — surfaced, not swallowed.
- `upload_batches` has **`row_count` only** — no total/success/error columns. Writing to
  `total_rows` throws *after* the data has committed, so the import succeeds while the API
  returns 500.
- **`GET /fridges/customer-lookup` reads it first.** The "استحضار" button on the fridge form
  merges **per field** across three sources — `customers` (CM list) → `invoices` →
  `sales_activity` — because the master may have a blank route while invoices have one, and
  falling back only when the whole master row is missing would throw that away. The response
  carries `sources` (which source fed each field) and `in_customer_list`, and the form shows a
  note saying whether the values came from the uploaded list or fell back to invoices. On live
  data the master holds 2,992 customers of which **414 exist ONLY there** — those returned
  nothing from the old invoices-only lookup, which is exactly the blank form in the report.
- **It does not touch `invoices` or `sales_activity`.** Their rep/route/name are a record of what
  was true at the time of sale; overwriting them from today's master would rewrite history.

### Same endpoint also accepts a simpler "names-only" update file

Requested after discovering (see the Discount Shops contract Arabic-name work above) that
`customer_name_ar` is genuinely Arabic-script for only 2 of 3079 customers company-wide — the full
"Customer List - CM" export's own Arabic column has effectively never carried real Arabic names. The
user's fix: a separate, simpler update file with just three columns — **Customer Code / Customer
Name English / Customer Name Arabic** — uploaded through the SAME "تحديث بيانات العملاء" card.

- No new endpoint needed — `POST /upload/customer-list` already required only `customer_code` +
  `customer_name`, treated every other column as optional, and preserved everything not present in
  the file via the existing `COALESCE` upsert (see above). A 3-column file already worked
  structurally; the one real gap was the column-name matching.
- `customer_name`'s candidate list now explicitly includes `'Customer Name English'` (previously it
  only had the full-export's literal `'Customer Name'`). Before this, a file using the header
  "Customer Name English" would only bind via the prefix-match fallback — which happened to land on
  the right column here, but only because "English" (7 letters) is one letter longer than "Arabic"
  (6 letters) than `'Customer Name'`'s shared-prefix length, a coincidence of word lengths, not a
  real guarantee. Made it an explicit exact-match candidate instead of relying on that.
- Frontend: the upload card's hint text now mentions both accepted formats, and its result summary
  gained a "بأسماء عربية: N" count (`with_arabic_name`, already returned by the endpoint but not
  previously surfaced) so an admin uploading a names-only file can immediately see how many rows
  actually carried an Arabic name.

Verified live end-to-end with a generated in-memory `.xlsx` (exact 3-column header row) and a
dedicated throwaway `customer_code` seeded with other fields already set (`branch_name_en`,
`route_code`, `salesman_name`) to prove the upsert only touches names: `matched_columns` resolved
`customer_name` → "Customer Name English" and `customer_name_ar` → "Customer Name Arabic" cleanly
(zero duplicate bindings), the throwaway existing customer's names updated correctly while its
branch/route/salesman fields stayed exactly as seeded, and a second throwaway row not previously in
`customers` was inserted correctly with both names. Both throwaway rows deleted afterward. PM2 stable
post-deploy (123→124, one restart, matching the deploy). Also caught and fixed before deploying:
`backend/src/routes/upload.js` was missing from `deploy_rep_management.py`'s whitelist entirely — the
column-matching fix would otherwise have sat locally forever, unpublished, the same class of mistake
as the fridges deployment gap documented above.

## Fridge notes column

`fridge_notes` (one current note, shown in the list column) + `fridge_notes_history`
(append-only). Same two-table shape as `sales_activity_notes` (migration 015) — reuse it for any
new "editable note with an audit trail" rather than inventing a third variant.

- **Who may write**: `NOTE_ROLES` = the fridge editors **plus supervisor and region_manager**
  (mirrored as `NOTE_ROLES` / `canWriteNote()` in `FridgesPage.jsx`). Notes are field
  intelligence, not an asset change — the people standing in front of the fridge can record what
  they see without being able to move or delete it. Widening this costs no traceability: every
  save is attributed and appended to the trail. Verified per role against the live API:
  supervisor / region_manager / fridge_admin / super_admin → 200; viewer / accounts → 403, and
  the textarea is disabled for them in the UI.
- **Saves only on the ✓ button**, never on blur or keystroke: other people read these notes, and a
  half-typed autosave is worse than no note.
- The list query LEFT JOINs `fridge_notes` and counts the trail, so the column needs no extra
  request per row: `note_text`, `note_updated_at`, `note_updated_by_name`, `note_count`.
- `saved_by_name` is denormalized into both tables so a deleted user does not erase the
  authorship of what they wrote.
- **Clearing a note is recorded too** — an empty row is appended to the trail. Who cleared it and
  when is itself history; silently dropping that would make the trail lie.
- A refetch never clobbers an unsaved edit (the cell adopts server text only when the local text
  still equals the last saved value).
- `PUT /fridges/:id/note` 404s on a missing fridge instead of creating an orphan note row.

## Fridge transfer REQUEST → approval (طلب نقل ثلاجة)

A supervisor / region manager cannot move a fridge; they raise a **request** that a fridge admin
(or system admin) must approve. `fridge_transfer_requests` is a separate table on purpose —
`fridge_transfers` keeps its meaning as "transfers that actually happened", so a pending request
can never be mistaken for one.

- **Roles**: `REQUEST_ROLES` = supervisor · region_manager · sales_manager · super_admin · it_admin.
  `APPROVE_ROLES` = fridge_admin · super_admin · it_admin. The frontend mirrors these in
  `TRANSFER_REQUEST_ROLES`; the direct "🔄 نقل لعميل جديد" button is admin-only.
- **Both sides' route + salesman are SNAPSHOT onto the request** from the `customers` master, not
  looked up at print time: the printed sheet must stay faithful to what was approved even after
  the CM file is re-uploaded and a route changes hands.
- **A partial unique index allows only ONE pending request per fridge**
  (`uq_ftr_one_pending_per_fridge`) — two open requests could each be approved into a different
  customer. Approval also takes `FOR UPDATE` on both the request and the fridge, so two approvers
  clicking together cannot transfer twice; the second gets 409.
- Approval performs the real transfer **in the same transaction** and links `transfer_id`, and
  flags the fridge as awaiting its contract (a new customer needs a contract signed by them).
- Notifications go to every active approver on raise, and back to the requester on decide, using
  the existing `notifications` table (`type = 'fridge_transfer_request'`).
- The printable sheet opens in its own window (own print CSS, none of the dashboard chrome) and
  carries: fridge + contract, both customers with route/route name/salesman/region, the requester
  and their role, the reason, the decision, and three signature lines.
- **`users.role` is the `user_role` ENUM** — comparing it to a text[] fails with
  "operator does not exist: user_role = text". Cast: `role::text = ANY($1::text[])`.

## Fridge "بانتظار توقيع العقد" flag

A fridge reassigned to a new customer needs a contract signed by **that** customer — the files
already attached belong to the previous one. The reassign form therefore carries a toggle
(**on by default**) that flags the fridge as awaiting its contract.

- Set only on `transfer_type = 'reassign'`. A repair withdrawal needs no new contract, so
  `pending_contract` is ignored there rather than stored and displayed later.
- `pending_contract_since` uses `COALESCE(pending_contract_since, NOW())` so a second transfer
  while already flagged does **not** reset the waiting clock — "معلّقة منذ 40 يوماً" stays true.
- **Uploading any contract file clears the flag**, in the same transaction as the file insert, so
  the alert can never outlive the file it was waiting for. The response carries
  `pending_contract_cleared` for the client. The flag on the `fridge_transfers` row is history and
  is deliberately *not* cleared — it records that that particular transfer went out without one.
- Surfaces in four places: a standing banner over the list (from `stats.pending_contracts`,
  oldest first with `days_waiting`), a chip on the list row, an alert + header badge in the fridge
  modal, and a chip on the transfer-history entry. `GET /fridges?pending_contract=1` backs the
  banner's "عرض المعلّقة فقط" filter.

## Fridge route + salesrep follow the CURRENT customer

`fridges.route_code` / `fridges.salesrep_name` are stored columns (needed for history snapshots,
the transfer-request printed sheet, and Excel export), but they must track whichever customer the
fridge is registered to *now* — not stay frozen at whatever they were when the fridge was created.

- **Every reassign refreshes them automatically.** `POST /fridges/:id/transfer` (reassign branch)
  and `POST /fridges/transfer-requests/:reqId/approve` both call `customerRouteInfo(newCode)` and
  write the result onto the fridge in the same statement that moves `customer_code`. Approval
  looks the values up **fresh at approval time**, not from the `to_route_code` / `to_salesman_name`
  snapshotted on the request when it was raised (the master may have moved on in between; the
  snapshot is still kept on the request row for the printed sheet, which must stay faithful to
  what was approved). A `repair` withdrawal leaves route/salesrep untouched.
- **`POST /fridges/refresh-customer-data`** (`canEdit`) — one set-based `UPDATE` that reconciles
  *every* fridge with a `customer_code` in a single pass, for the case a re-uploaded "Customer
  List - CM" moved a route to a different salesman with no fridge transfer involved. Precedence is
  the same as `/customer-lookup`: customers master → invoices → sales_activity. A fridge whose
  `customer_code` matches nothing anywhere (`cust.known` false) is left exactly as-is rather than
  having its route/rep nulled. Returns `{ updated, total_with_customer }`. Surfaced as the
  "🔄 تحديث بيانات الثلاجات" button in the `FridgesPage` toolbar (admin only, `window.confirm`
  first), which invalidates `['fridges']` + `['fridge-stats']` and alerts the counts.
- Deliberately **not** a live `LEFT JOIN customers` in the list query — the app keeps one stored
  value per fridge that the list, the modal, the print sheet and the CSV export all read, so they
  can never disagree; the button is the reconcile mechanism when the master changes underneath.

**Deployment gap found & fixed 2026-09-09**: this whole feature (both code paths above, plus the
toolbar button) was already fully written in the local repo but had **never actually been deployed**
— `deploy_rep_management.py` re-uploaded `fridges.js`/`FridgesPage.jsx` on every prior deploy this
session (both whitelisted) without changing them, so nobody noticed the running production build was
missing it entirely (`POST /refresh-customer-data` 404'd; the toolbar button didn't exist). Caught
when the user asked for exactly this feature and a code search found it already written — confirmed
the gap by diffing the locally-deployed file against a fresh `sftp.get` of the actual file on the
server before assuming anything, rather than trusting that "it's in the repo" meant "it's live".
Deployed as-is (no code changes needed) and ran the button for real once live: **71 of 449** fridges
with a known customer had a stale route/rep and were corrected in that one pass; a second read-only
check afterward confirmed 0 fridges still mismatched. PM2 stable post-deploy (120→121, one restart,
matching the deploy). Lesson: when local code for a requested feature already looks complete, verify
it's actually the code running in production (diff the live file, not just "it's whitelisted in the
deploy script") before telling the user it already exists — being whitelisted only means it get
re-uploaded, it says nothing about whether it was ever different from what's already live.

## Quality Issues Tracking (`/quality-issues`)

`backend/src/routes/qualityIssues.js` — uploads and tracks the NetSuite "Quality Issues Quantity
and Cost" report (`QualityIssuesQuantityandCost(...).xls`, a periodic recurring export). This is
**distinct from `sales_activity.bad_return_qty`** (route-level returns used throughout
RegionPerformancePage's "التوالف" metric) — this table tracks priced warehouse/QC quality-adjustment
line items with both **quantity and cost**, in its own `quality_issues` table.

**Upload is additive/idempotent, not a TRUNCATE-replace**: keyed on
`UNIQUE (document_number, item_name, issue_date)` with `ON CONFLICT ... DO UPDATE`, because each
periodic export re-covers overlapping date ranges as the user re-downloads and re-uploads the same
recurring report going forward. Upload endpoint reuses the existing multer/xlsx pattern from
`upload.js`, and is also exposed as a card in the central Upload page (`UploadPanel.jsx`) alongside
the other periodic-report uploads.

**File format gotcha**: it's a NetSuite SpreadsheetML export (same XML format as other reports,
parsed fine by the existing `xlsx`/SheetJS package already used app-wide) with 6 title/blank rows
before the real header row — the header row is located dynamically by finding the cell that reads
`"Location: Name"`, not assumed at row 0.

**Region matching**: the file's `Location: Name` column holds genuine Arabic region text with an
inconsistent free-text warehouse suffix (e.g. `"الرياض - منتج تام ميرنا"` vs
`"شقرا منتج تام - ميرنا"` — note the dash position differs), so region is resolved by
`startsWith()` prefix-matching against the known Arabic region names (longest-first), not by
splitting on the first `-`. Same underlying English/Arabic region-name translation concept as
`currentStock.js`/`collections.js` (see "Region name storage gotcha" above).

Endpoints: `POST /upload`, `GET /filters`, `GET /summary` (monthly trend per region + by-region/by-item
totals — the frontend renders this as a region × month cost matrix, the requested "ترند شهري لتوالف
الجودة للمناطق"), `GET /` (paginated line-item list). All gated by `requirePagePermission('quality_issues', …)`
and scoped by `applyRegionFilter` for `region_manager`.

## Org chart tab (`/rep-management` → "الهيكل التنظيمي")

`rep_managers` has **no parent FK** — a manager's boss is never stored. The reporting line
exists only implicitly in each `sales_reps` row, which carries the whole chain
(`sales_manager_id` → `sector_manager_id` → `region_manager_id` → `supervisor_id`).
`buildOrgModel()` in `RepManagementPage.jsx` therefore *derives* the tree entirely client-side
from the two calls the page already makes (`/sales-reps`, `/sales-reps/managers`) — no backend
route and no migration.

- Every rep row casts a **vote** linking each manager in its chain to the one above it; a
  manager's parent is the majority winner. Nulls are dropped from the chain first, so a rep with
  no sector manager links its region manager straight to the sales manager rather than falling
  out of the chart. A manager seen under more than one boss is drawn under the most common one
  and flagged with a ⚠ badge.
- A cycle guard runs after resolution — dirty data producing a reporting loop would otherwise
  hang the recursive render.
- **Reps are drawn as one wrapped team card per supervisor, not one node each.** With ~60 reps,
  individual leaf nodes blow the chart out to several screens wide.
- Managers with no team and reps with no manager at all are listed in a "خارج الهيكل" panel
  below the chart instead of being silently dropped — that panel is the data-quality signal.

CSS (`rmp-org-*`) uses the classic pseudo-element tree: each `<li>` draws the two halves of the
horizontal bar above it (`::before` = right half, `::after` = left half — the sheet is RTL, so
`:first-child` is the **rightmost** node) and the card wrapper draws the vertical drop into its
own card. Print is A3 landscape.

## Local Development (Docker)

The local machine runs the full stack via Docker Compose. No local PostgreSQL/nginx installation needed.

```bash
# Full rebuild after any code change (required — code is baked into images)
docker compose build && docker compose up -d

# Check container status
docker ps

# View backend logs
docker logs cb_backend --tail 30

# Access DB directly
docker exec -it cb_postgres psql -U cbuser -d customer_balance_db
```

**nginx.conf** for Docker: proxies `/api/` → `backend:3000`, `/uploads/` → `backend:3000`, everything else → `frontend:80`. HTTP only (no SSL locally).

**DB credentials (Docker)**: `cbuser` / `cbpassword` / `customer_balance_db`

## Production Deployment

**Server**: Windows Server 2016, IP 176.9.85.242, **native stack (no Docker)**, domain `www.sales.taryahpoultry.com.sa`

**Stack**:
- PostgreSQL 16 → Windows Service (`postgresql-x64-16`, auto-start)
- Node.js backend → PM2 (`taryah-backend`, port 3001), auto-starts via `pm2-windows-startup`
- IIS with ARR (Application Request Routing) + URL Rewrite → HTTPS proxy to port 3001
- React frontend → built to `C:\inetpub\wwwroot\sales`, served by IIS

**App location on server**: `C:\apps\Taryah-WB\` (git clone of this repo)

**DB connection** (`pool.js`): accepts both `DATABASE_URL` string **or** individual `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` vars. Server `.env` uses individual vars.

**SSL**: Let's Encrypt cert (win-acme), thumbprint E0500C5BFD366114870C73556CCC71377B00FBC6, bound to IIS site "sales" on port 443.

**Port layout**: IIS on 80/443 (public). PM2 backend on **127.0.0.1:3005** (internal, `BIND_HOST`
+ `PORT` in `backend/.env`, matched by the two rewrite rules in `frontend/public/web.config`).
Other occupants of this box — do not touch: **3000** `commission-app` (PM2), **3002**
`WaNotifyServer` (Windows service, `C:\wa-notify-server`, the self-hosted WhatsApp endpoint for
NetSuite). **3001 is now free** — see the incident below for why we left it.

### Port collision on 3001 — how an outage hid behind a healthy PM2 (11 Aug 2026)
`WaNotifyServer` was installed as an Automatic Windows service and bound **`127.0.0.1:3001`**.
Our backend bound `0.0.0.0:3001`, which *succeeds* alongside it — and on Windows the
specific-address bind wins every IPv4 loopback connection. IIS rewrites `/api/*` to
`http://127.0.0.1:3001`, so **every API call on the live site was answered by the WhatsApp app
(404 HTML)** while `pm2 jlist` showed `taryah-backend` online with a flat restart counter and no
error anywhere. The netstat check in the orphan-fork section catches this only if you read
*every* line: two different pids were listening on 3001, one wildcard, one loopback.

Resolution: the backend moved to **3005** and now binds the *specific* address
(`BIND_HOST=127.0.0.1`, `app.listen(PORT, BIND_HOST, …)`). Claiming the exact address means a
future squatter fails loudly with `EADDRINUSE` instead of silently shadowing us.

**Diagnostic that actually proves the site is up** — a 200 from `localhost:PORT` does not, because
`localhost` resolves to `::1` first and our old wildcard bind answered there while IIS was being
served something else entirely. Test the public URL and the literal IPv4 loopback:
```powershell
curl.exe -s -o NUL -w "%{http_code}" https://www.sales.taryahpoultry.com.sa/api/health
netstat -ano | findstr LISTENING | findstr ":300"   # expect exactly one pid per port
```

### PM2 remembers the environment a process was FIRST started with
`pm2 restart` does **not** re-read `backend/.env`, and `dotenv` never overwrites an already-set
variable — so a value in PM2's saved env silently wins over the file, forever. Editing `.env` and
restarting therefore appears to do nothing. Only `pm2 delete` + `pm2 start` (then `pm2 save`)
rebuilds it:
```powershell
pm2 delete taryah-backend
pm2 start C:\apps\Taryah-WB\backend\src\index.js --name taryah-backend --cwd C:\apps\Taryah-WB\backend
pm2 save
```
**This cuts both ways.** `backend/.env` on the server had drifted to `DB_PORT=3001` at some
unknown earlier date; nobody noticed because PM2's cached `DB_PORT=5432` was masking it. The
moment the process was recreated, the drifted file took effect and every query failed with
`ETIMEDOUT ::1:3001`. Before recreating the process, **diff `.env` against what PM2 actually
holds** (`pm2 jlist` → `pm2_env`) and fix the file first. Postgres is on **5432**.

**Deploy workflow** (run on server):
```powershell
cd C:\apps\Taryah-WB
git pull
cd frontend; npm run build; cd ..
cd backend; npm install; cd ..
pm2 restart taryah-backend
```
**Note:** IIS `sales` site serves directly from `C:\apps\Taryah-WB\frontend\dist` — no robocopy needed.

**Backend `.env`** on server (at `C:\apps\Taryah-WB\backend\.env`):
```
PORT=3001
DB_HOST=localhost
DB_PORT=5432
DB_USER=cbuser
DB_PASSWORD=TaryahDB@Prod2024!
DB_NAME=customer_balance_db
JWT_SECRET=<long random string>
JWT_EXPIRY=24h
UPLOAD_DIR=./uploads
MAX_FILE_SIZE_MB=50
NODE_ENV=production
```

**IIS web.config**: `frontend/public/web.config` — API proxy to 127.0.0.1:3001, HTTPS redirect, SPA fallback, 60MB limit, 10min proxy timeout.

**Backup**: `C:\apps\Taryah-WB\scripts\backup.ps1` — nightly pg_dump, 7-day retention (Task Scheduler, 2AM).

### Orphaned PM2 fork holding port 3001 (silent deploy failure)
On Windows a `pm2 restart` can leave the old fork alive. It keeps holding 3001 while PM2 spawns
a replacement that dies instantly with `EADDRINUSE`, retrying forever (the restart counter runs
into the thousands). **The site keeps working**, because the orphan still serves — but it serves
the *old* code, so every subsequent backend deploy silently has no effect while `npm run build`
and the deploy script both report success.

Detection — a passing deploy is not proof. After deploying, check both:
```powershell
pm2 jlist            # restart_time must be FLAT across two samples ~15s apart
netstat -ano | findstr :3001   # the listening PID must equal pm2's pid for taryah-backend
```
and assert a field you just added actually appears in the live API response.

Recovery: `pm2 stop taryah-backend` → confirm the PID on 3001 is `node.exe` running
`ProcessContainerFork.js` → `taskkill /F /PID <pid>` → `pm2 start taryah-backend` → `pm2 save`
→ `pm2 reset taryah-backend` to zero the counter. Never kill a PID on 3001 without identifying
it first; `tasklist /FI "PID eq N"` quoting breaks over SSH — use
`Get-CimInstance Win32_Process -Filter 'ProcessId=N'` instead. Port 3000 is `commission-app` —
leave it alone.

## Discount Shops (`/discount-shops`) — DB-backed customer_code list, not category_name

`backend/src/routes/discountShops.js`, cloned from `hypermarkets.js`. The customers making up
"محلات التخفيضات" do **not** reliably carry `category_name = 'Discount Shops'` in `sales_activity` —
verified live: of the original 40 codes, 35 customer-code matches show as `Poultry Shops`, 34 as
`Discount Shops`, 3 `Restaurant`, 1 `Groceries` (a customer can carry more than one category over
time, so these overlap). Filtering on `category_name` would silently drop most of the intended set,
so `CATEGORY_FILTER`/`CAT_PLAIN` in this file are instead built as
`customer_code IN (SELECT customer_code FROM discount_shop_customers)` — the same two-constant
pattern `hypermarkets.js` uses, just swapping the boolean fragment's source.

**The segment now lives in the DB, not a hardcoded JS array** (migration 087,
`discount_shop_customers` table: `customer_code` PK, `customer_name`, `uploaded_by`, `uploaded_at`,
seeded with the original 40-customer set so behavior was unchanged the moment the migration ran).
It can be refreshed periodically from inside the page itself:
- `GET /customer-list` — current segment + `count` + `last_uploaded_at`.
- `POST /customer-list/upload` (`requireRoles('super_admin','it_admin')`, same admin-only matrix as
  the page) — Excel upload (`Customer Code`, `Customer Name`, optional `Customer Name Local` Arabic
  preferred-with-English-fallback, same convention as `customers.customer_name_ar`). **Full
  TRUNCATE + INSERT replace in one transaction**, not an upsert — this list defines *current*
  segment membership, so a customer missing from a fresh upload must actually drop out (unlike the
  `customers` master's upsert-never-delete rule, which is right for that table and wrong here). Old
  vs. new codes are diffed *before* truncating so the response carries `previous_count`,
  `new_count`, `added[]`, `removed[]`; any parse/insert error rolls the whole transaction back so
  the old list is never left partially destroyed. The frontend panel (admin-only, gated the same
  way as the rest of the page's admin UI) confirms before sending and shows the diff right after —
  a destructive full-replace is never applied silently.

**Calendar date-range filter**: `/summary`, `/item-matrix`, `/customer-matrix`, `/item-overview`,
`/filters` and `/chilled-chicken-baseline` all accept an optional `?date_from=&date_to=` pair that,
when both are present, overrides the year/month selection entirely and can span multiple
months/years — same `make_date(report_year, month_num, day)` reconstruction proven in
`salesReport.js`'s `/branch-summary` (`day` is NOT NULL on every row). `periodFragment()` in
`discountShops.js` builds this fragment once per call site so every query stayed byte-identical to
its pre-range form when the range is unused. The frontend toggle (`DiscountShopsPage.jsx`, same
`useDateRange`/`dateFrom`/`dateTo` pattern as `SalesReportPage.jsx`'s "ملخص المبيعات" tab) disables
the year/month multi-selects when active and is wired through every tab's API call, including the
chilled-chicken baseline, so the whole page reflects one consistent period. **Correction (28 Aug
2026): `/overview` is NOT whole-period-only** despite an earlier version of this note claiming
otherwise — its actual code (and `DiscountShopsPage.jsx`'s matching `overviewParams`) accepts the
same `?years=/?months=`/`?date_from=&date_to=` filter as every other tab; only `/item-overview` and
`/customer-matrix` stay genuinely whole-period (no period param at all, by design — "كامل الفترة"
best/worst cards and the annual matrix).

Unlike `hypermarkets.js`, this route has **no branch-expenses feature** — `branch_monthly_expenses`
(fixed rebate / sell-out / vendor marketing / credit notes) is a Hypermarkets-only trade-terms
concept with no category dimension in its schema, so `/overview` here reports `net_revenue` as the
raw `SUM(sa.net_revenue)` with no deduction, and there is no branch-expenses upload UI on
`DiscountShopsPage.jsx`.

Verified live against production (26 Aug 2026): all 40 codes are present in `sales_activity`; July
2026 (one full month) foots to 34 active customers / 81,152 qty / 1,127,613.00 SAR / 580 invoices,
matching an independent SQL query built from the same code list. `page_permissions` mirrors
`hypermarkets` exactly (admin-only: `super_admin`/`it_admin` = 2, everyone else 0).

## Chilled-chicken 10+1 free-goods promo scenario (Discount Shops → "سيناريو مجانيات 10+1")

`GET /api/discount-shops/chilled-chicken-baseline` returns per-item and per-customer historical
baselines for the three `item_category_en` values that make up "دجاج مبرد" (chilled chicken) for
the 40 discount-shop customers: `'دجاج مبرد طرية'`, `'دجاج مبرد متبل'`, `'دجاج مبرد  قريد بي-سجى'`
(note the **double space** in the third — verified against production, `'دجاج مجمد'` frozen and
`'مقطعات طرية'` fresh-cuts are different categories and correctly excluded). Verified live (26 Aug
2026), whole history: 817,376 qty / 11,082,622.00 SAR across 40 customers / 17 items — three-way
footing (direct SQL total = Σitems = Σcustomers) matches exactly.

- `active_months` per customer = distinct `(report_year, month_num)` with `qty > 0` in the category
  filter; `avg_monthly_qty = total_qty / active_months` — averaged only over months the customer
  actually bought, not diluted by the full history length.
- Reuses the page's existing years/months multi-select query convention (`years=`, `months=` CSV or
  repeated key, same as `/summary`); omitted → all available history, reported in `meta.date_range_applied`.

**The 10+1 promo math is entirely client-side** (`DiscountShopsPage.jsx`, `calcChickenScenario`
useMemo/useCallback) so the growth%/coverage%/free-cost controls respond instantly, mirroring the
forecast-engine pattern on `RegionPerformancePage.jsx`. Three user-adjustable knobs stand in for
ambiguous points in the original request rather than guessing:
- `growthPct` (default 10%) — manually entered required growth.
- `freeCostPerUnit` (default 11.75 SAR) — cost per free unit given out.
- `coveragePct` (0% / 50% / 100%, default 100%) — how much of the free-goods cost is recovered via
  a price increase on paid units vs. absorbed as a margin hit.

Per customer: `target_qty = avg_monthly_qty × (1+growth%)`, `free_qty = floor(target_qty / 10)`
(10+1 ratio applied to the full target, not just the incremental growth — one free unit per ten
paid). **`total_free_qty`/`total_free_cost` are the sum of these FLOORED per-customer values**,
never derived from unrounded totals, so every displayed number foots exactly. Per item, the
already-floored `total_free_qty` is distributed by historical volume share
(`item_share = item.total_qty / overall.total_qty`) — a proportional analytical split for pricing
guidance, not a literal per-SKU allocation, so it does not need to be integer but does sum back to
`total_free_qty` exactly (verified: Σitem_free_qty = total_free_qty, Σitem_target_qty =
total_target_qty, to floating-point precision only, at growth=10%: 6,356 free units / 74,683.00 SAR
at 100% coverage).

A 4×3 growth-preset (5/10/15/20%) × coverage-preset (0/50/100%) comparison matrix covers the
"multiple scenarios to cover the cost" ask regardless of which axis was intended; clicking a cell
sets the two controls and scrolls to the detail tables. A fixed disclaimer is always rendered on
the tab: the net revenue impact is not a final profit margin because full COGS isn't in this report.

## Customer contract print (Discount Shops → "طباعة عقد عميل")

A print-only formal "اتفاقية تعاون تجاري وحوافز مبيعات" document, one per selected discount-shop
customer, matching the company's paper contract template exactly (same section numbering/wording).
Deliberately reuses `incentiveScenario.perCustomer` from the existing "سيناريو حافز % من المبيعات"
tab as-is rather than recomputing anything — same growth% and same 3-tier rate table the admin
already has configured there, so the two tabs can never disagree on a customer's numbers. Changing
the growth% or a tier's rate/threshold on the incentive tab immediately changes what the next
contract print for that customer will show.

- **Target quantity printed** ("الهدف الشهري") = `avg_monthly_qty` (the customer's real historical
  average, unadjusted) — this is the "متوسط كامل الكميات المحققة للعميل" the paper template asks
  for, not the growth-adjusted `target_qty` used to size the tiers below it.
- **Tier ranges** are derived from `target_qty` (`avg_monthly_qty × (1+growth%)`, the 100% baseline
  the incentive tab already computes) times each tier's `minPct/100` — so tier 2's threshold lines
  up exactly with "110% من الهدف" and tier 3's with "125%", per the request. A row's upper bound is
  one unit below the next tier's threshold; the last tier is open-ended ("فأكثر"), matching the
  template. The "البونص المستحق" column is each tier's `rate` (e.g. 2% / 3% / 4%) since this
  scenario's whole premise is a % of sales value, not a free-goods quantity.
- **What's deliberately left blank on the printed sheet** (manual completion after printing, exactly
  like the source paper form): the day of signing, the agreement start/end dates, the customer's own
  CR number, and the credit limit (SAR) — none of these has a live data source in the app today.
  The company's own identity (CR number `1113003711`, registered address) is hardcoded in
  `DiscountShopsPage.jsx` since it's the same legal entity on every contract, unlike the
  customer-side fields.
- **Print isolation**: this tab needed its own print path rather than reusing the page's existing
  whole-page report-print mode (`.ds-print-header`/`.ds-no-print`, used by every other tab to print
  the on-screen dashboard as-is) — a legal contract needs an exact one-page layout, not the app's
  UI chrome. `handlePrintContract` adds a `ds-printing-contract` class to `<body>` before calling
  `window.print()` (removed via `window.onafterprint`), and every print rule for the contract sheet
  is scoped under `body.ds-printing-contract` in `DiscountShopsPage.css` — keeping the two print
  paths from ever fighting over `display`/`visibility` on the same elements.

### Contract print bugs: landscape page + invisible header text with "Print backgrounds" off

Two bugs from a screenshot of Chrome's print dialog: the contract came out **landscape** (should be
portrait, it's a one-column legal document), and unchecking "Print backgrounds" did nothing visible.

- **Landscape bug root cause**: `visibility`/`display` scoping under `body.ds-printing-contract` (the
  fix above) works fine for regular elements, but **`@page` at-rules cannot be scoped by any selector
  at all** — a plain `@page { size: A4 portrait }` for the contract sat in the same stylesheet as the
  whole-page report mode's own plain `@page { size: A4 landscape }` (`.ds-print-header`/`.ds-no-print`
  mode above), and with two unscoped `@page` rules setting the same `size` property, which one a
  browser actually applies for a given print job isn't governed by the body class at all — observed:
  Chrome kept using the landscape one for the contract print regardless of source order.
  - **First attempt — named page, did NOT actually work**: `@page contract { size: A4 portrait; … }`
    plus `page: contract` (CSS Paged Media Level 3) is the spec-correct way to opt one print box into
    its own page box unambiguously, and Chrome does support the syntax — but the user reported the
    contract STILL printed landscape after this shipped. Never assume a spec-correct, syntactically
    valid CSS feature actually behaves as documented in the one browser that matters here without the
    user confirming the real print dialog — this one didn't, for reasons not fully understood (a
    Chrome quirk with named pages interacting with a second *unnamed* `@page` rule in the same
    stylesheet, most likely).
  - **Actual fix — stop using a static `@page` rule at all**: `printWithPageSize(sizeCss, marginCss,
    extraCleanup)` creates a temporary `<style>` tag containing exactly ONE `@media print { @page {
    size: …; margin: …; } }` rule, appends it to `<head>` immediately before calling `window.print()`,
    and removes it in `window.onafterprint` (alongside whatever body-class/`document.title` cleanup
    that print mode also needs). Both `handlePrint` (report mode → `A4 landscape`) and the contract
    print effect (→ `A4 portrait`) now go through this one helper. Since only one `@page` rule for
    `size` exists in the entire document at the moment either print() call fires, there is no second
    rule left for the browser to prefer instead — removed the two static `@page` rules from the CSS
    entirely so nothing can reintroduce this ambiguity later.
- **Invisible-header bug — first attempt, reverted per user feedback**: `.ds-contract-doc__table th`
  (the tier table's dark-blue header row) used `background: #1e3a8a; color: #fff` with nothing forcing
  it to print — when a browser's "Print backgrounds" option is off, the background disappears but the
  white text stays, invisible white-on-white. First fix: `print-color-adjust: exact` to force the
  header to always print its background regardless of that toggle. The user then reported this as ITS
  OWN bug — unchecking "Print backgrounds" visibly did nothing, because that's exactly what forcing it
  does, and that's not what they wanted: they expect the checkbox to actually control it, not be
  overridden. **Reworked instead of re-forcing**: dropped `print-color-adjust` entirely and switched
  the header from dark-navy-fill-with-white-text to a light blue tint with DARK bold text
  (`background: #dbeafe; color: #1e3a8a; font-weight: 700`) — with backgrounds on it shows the soft
  tint, with backgrounds off the tint simply disappears (the checkbox works normally, as asked) and
  the dark bold text sits directly on white paper, still fully legible either way. This solves the
  original invisible-text concern by making the header not depend on a background for legibility at
  all, instead of by forcing one — satisfies both the "must stay legible" requirement and the "the
  checkbox must actually do something" complaint, which the first attempt could not do at once.

Verified (first attempt, before the named-page approach was found not to work): the built CSS bundle
was fetched from the server and confirmed to contain `page:contract`/`@page contract{...}` — this was
NOT sufficient, since the user reported landscape persisting even so. Verified (actual fix): fetched
the freshly-built JS bundle from the server and confirmed it contains `printWithPageSize`'s injected
`@media print{@page{size:...}}` string with both `A4 portrait` and `A4 landscape`; fetched the
freshly-built CSS bundle and confirmed **zero** `@page` rules remain in it (both static ones fully
removed, so there's nothing left to conflict with the injected one). PM2 stable post-deploy (131→132,
one restart, matching the deploy). The print dialog itself still can't be driven headlessly in this
environment — the mechanism is verified correct and deployed, actually opening it to see portrait
orientation is left for the user to confirm — but this fix no longer depends on newer/less-proven CSS
behavior the way the named-page attempt did, which is exactly what silently failed last time.
**Portrait orientation confirmed working by the user's own follow-up screenshot** (still 1 of 5
pages, "Scale 110%" — that's the user's own print-dialog setting from a prior session, not something
this app controls). The header-background rework was verified by fetching the freshly-built CSS from
the server and confirming `.ds-contract-doc__table th{background:#dbeafe;color:#1e3a8a;font-weight:
700}` carries no `color-adjust` property. PM2 stable post-deploy (132→133, one restart, matching the
deploy).

### Save log + unique contract number (`discount_shop_contracts`)

Every contract print permanently logs one row via `POST /api/discount-shops/contracts`
(`101_discount_shop_contracts.sql`) — `contract_no` is a `SERIAL`, guaranteeing a unique,
human-friendly number ("عقد #47") the way `report_no` does on the Carrefour/Quality-Returns tables.
Unlike those two features, there's no separate daily-entry grid here — one click IS one contract —
so this is a single append-only table doubling as both the "report" and its own save log, rather
than a header table + a separate `*_save_log` table.

- **Frozen snapshot, not a live re-join**: `avg_monthly_value`, `growth_pct`, `target_value` and the
  full `tiers` array (JSONB) are stored exactly as they appeared on the printed sheet. A contract
  saved today must keep showing its own numbers even if an admin later changes the growth% or a
  tier's rate on the "سيناريو حافز % من المبيعات" tab — re-deriving from the live incentive settings
  on every read would silently rewrite history.
- **Basis toggle — qty or revenue** (`102_discount_shop_contracts_basis.sql`): a `basis` column
  (`'qty' | 'revenue'`, default `'qty'`) records whether `avg_monthly_value`/`target_value` are
  expressed in physical quantity (حبة) or sales value (ر.س) — some deals are negotiated on revenue
  instead of unit count. The two originally qty-specific columns were renamed from
  `avg_monthly_qty`/`target_qty` to the generic `avg_monthly_value`/`target_value` to reflect this
  (safe rename — shipped minutes earlier with zero real rows, only an already-cleaned-up test
  probe). The frontend picks the source field per row from `incentiveScenario.perCustomer`
  (`avg_monthly_qty`/`target_qty` vs `avg_monthly_revenue`/`target_revenue`) based on the
  `contractBasis` state, and every unit label/decimal count on screen (preview, print sheet, save
  log, expanded tier detail) derives from that same toggle or, for historical rows, from that row's
  own stored `basis` — never a hardcoded "حبة".
- **Save-then-print ordering race**: `handlePrintContract` awaits the `POST` before printing, but
  storing the returned `contract_no` via `setState` and then calling `window.print()` in the same
  tick risks printing the sheet before React commits the number into the print-only DOM (or, worse,
  printing while last render still shows a PREVIOUS customer's number). Fixed by deferring the
  actual `window.print()` call into a `useEffect` keyed on `pendingPrint`/`displayedSavedContract` —
  the effect only runs after the commit that includes the correct number, so the print-only sheet is
  never captured mid-render.
- `displayedSavedContract` only renders when `lastSavedContract.customer_code` still matches the
  currently-selected customer, so switching the dropdown after a save can't leave a stale contract
  number showing against a different customer's sheet or preview table.
- The "سجل العقود المحفوظة" table below the print controls (expand-to-view tiers, same
  click-a-row-to-expand convention as Carrefour/Quality-Returns) reads `GET
  /api/discount-shops/contracts`, optionally filtered by `?customer_code=`.

### Browse-before-print + edit an already-saved contract (`103_discount_shop_contracts_edit.sql`)

Two follow-up requests on the save log: (1) let a user open/preview a previously-saved contract
BEFORE deciding to print it — not an immediate reprint on click — and (2) let them correct a saved
contract's numbers afterward.

- **`printSheetData`** (`useMemo`) is now the single source both the preview card and the
  print-only sheet read from — it resolves to either `printTarget` (a saved log row the user is
  browsing, via "👁️ عرض") or the live customer selection at the top of the tab, whichever is set.
  This let the print-only DOM stop caring which of the two modes it's rendering, instead of forking
  into parallel copies of the same markup.
- **View is a separate action from print**: clicking "👁️ عرض" only calls `setPrintTarget(c)` — no
  `window.print()`, no new save-log row. `handlePrintViewedContract` (a distinct button, shown only
  while browsing) is what actually triggers the print effect via `pendingPrint`. Printing the LIVE
  selection goes through `handleConfirmSaveAndPrint` (save-then-print) and explicitly clears
  `printTarget` first so a stale reprint target can't shadow a freshly-created contract.
- **Editing breaks the log's append-only purity on purpose**: `PUT /api/discount-shops/contracts/:id`
  updates `avg_monthly_value`/`growth_pct`/`target_value`/`tiers`/`basis` in place and stamps
  `updated_by`/`updated_at` — but `contract_no`, `created_at` and `created_by` are never touched, so
  the contract keeps its identity/number the way a paper contract keeps its number after a
  correction is initialed. This is the "invoice can be amended" model, not a second parallel
  append-only audit table — acceptable here because the one guarantee that matters (every PRINTED
  contract has a permanent unique number) still holds regardless of later edits to its content.
- After a hand-edit, **`target_value` is re-derived from the edited tier 1's `from`** rather than
  kept as its own independently-editable field — once tiers are hand-adjusted they may no longer be
  a clean 100/110/125% ladder off one baseline, so keeping a separate `target_value` input would
  invite the two to silently disagree.

### Explicit review-before-save step + delete

The single-click "save + print" button was replaced with a two-step confirm: clicking
"📝 مراجعة العقد قبل الحفظ" only sets `pendingSaveConfirm = true`, which reveals a confirmation
banner directly over the (already-live) preview card — the same `printSheetData` the preview always
rendered, no new computation — asking the user to actually read the numbers before anything is
written. Only "✅ تأكيد الحفظ والطباعة" (`handleConfirmSaveAndPrint`) fires the `POST`. Selecting a
different customer or flipping the basis while a confirm banner is open closes it (`useEffect` keyed
on `contractCustCode`/`contractBasis`) so a confirm click can never save numbers the user reviewed
for a DIFFERENT selection.

`DELETE /api/discount-shops/contracts/:id` permanently removes one saved contract — gated behind a
`window.confirm()` on the frontend (same pattern as `customer-list` delete). Unlike edit, deletion
leaves no corrected-trail; `handleDeleteContract` also clears `printTarget`/`expandedContractId`/
edit state if the deleted row happened to be open in any of those, so the UI can't keep referencing
a row that no longer exists.

### Customer dropdown must offer the FULL segment list, not just customers with recent sales

The "اختيار العميل" dropdown used to be built straight from `incentiveScenario.perCustomer` —
meaning it silently only offered customers who had actual sales activity within whatever date
range/branch/rep filters happened to be selected at the top of the page. A customer sitting in the
admin-uploaded `discount_shop_customers` segment ("القائمة المدخلة" — see `/customer-list` above)
but with no sales yet in that window (a newly-added customer, or one just outside the default recent
months) simply never appeared — the user's screenshot showed a dropdown a fraction the size of the
real segment.

- New `contractCustAllOptions`: unions `incentiveScenario.perCustomer` (real computed
  averages/targets for customers with sales in the current filters) with every OTHER customer from
  `GET /discount-shops/customer-list` (fetched via a second `useQuery(['ds-customer-list'], …)` in
  the main component — same query key as `DiscountShopCustomerListPanel`'s own copy, so React Query
  dedupes it into the existing cached request rather than firing a second network call), zero-filled
  and flagged `no_sales_data: true`. `contractCustOptions` (search-filtered) and `contractCustomer`
  (the selected row) both now read from this union instead of `incentiveScenario.perCustomer`
  directly.
- A zero-filled customer can still be **selected, previewed, saved and printed** — there's no
  override field for the target on this tab, so their contract genuinely prints a 0 monthly target/
  all-zero tiers, which is honest given there's really no sales data to base one on. The option label
  appends "— بدون مبيعات في الفترة الحالية" and the preview card shows an explicit ⚠️ banner
  suggesting the admin widen the date range/filters if this customer actually does have sales that
  just aren't showing — rather than silently printing a misleading "0" with no explanation.
- Verified live: `discount_shop_customers` held **41** customers while the default recent-months
  `incentive-baseline` call only returned **34** — **7** real segment customers were being hidden
  from the contract picker before this fix (0 the other way — no incentive-computed customer existed
  outside the master list, so the union never needed to worry about the reverse edge case). PM2
  stable post-deploy (121→122, one restart, matching the deploy) — pure frontend change, no new
  backend endpoint, so nothing else to functionally probe.

### Contract prints both the Arabic AND English customer name

Requested from a screenshot of a printed contract showing only the English/transliterated customer
name. The real Arabic name already exists in the app — `customers.customer_name_ar`
(`081_customers_name_ar.sql`) — it just wasn't being resolved or shown anywhere on this tab.

- `114_discount_shop_contract_name_ar.sql` adds `discount_shop_contracts.customer_name_ar` — frozen
  at save time, same "snapshot, not a live re-join" rule the rest of this table follows for
  `avg_monthly_value`/`growth_pct`/`target_value`/`tiers` (a contract keeps showing the name it was
  printed with even if the customers master is corrected later).
- `GET /discount-shops/incentive-baseline` and `GET /discount-shops/customer-list` both now
  `LEFT JOIN customers` to resolve `customer_name_ar` alongside the existing English name, so it
  flows through `contractCustAllOptions` on the frontend for both real (sales-backed) and zero-filled
  (segment-only) customers.
- Shown in three places: the on-screen preview table ("اسم العميل (عربي)" / "اسم العميل (إنجليزي)"
  as two separate rows, `—` when no Arabic name exists), the actual print-only legal document's
  "الطرف الثاني" paragraph (`الاسم_العربي / English Name`, falling back to English-only when Arabic
  is missing), and the "سجل العقود المحفوظة" log table (`عربي / English`).

**Data-quality finding, disclosed rather than silently worked around**: live-verified that
`customers.customer_name_ar` is only genuinely Arabic-script for **2 of 3079** customers company-wide
(all 41 of the discount-shop segment included) — the other 3077 rows have it populated with the exact
same transliterated/English text as `customer_name`, meaning the "Customer Name Arabic" column of
whatever "Customer List - CM" export was last uploaded was effectively empty for almost the entire
customer base. This code fix is correct and complete — a contract WILL show a real Arabic name the
moment the underlying source data has one — but until a future "Customer List - CM" upload actually
populates real Arabic names, most contracts will keep showing the English name in both rows. Flagged
to the user rather than reported as "fixed" outright, since the visible behavior for almost every real
customer won't change until that source data is corrected upstream.

**Follow-up bug found after the user's real upload fixed the data above**: once a genuine
`Customer Code`/`Customer Name English`/`Customer Name Arabic` file was uploaded (see "Same endpoint
also accepts a simpler 'names-only' update file" above — this is the SAME real event, `customers`
master's Arabic coverage jumped from 2 to 3056 of 3079 that upload), the contract still printed the
**same Arabic text in both the "عربي" and "إنجليزي" rows** for a zero-sales-data customer. Root cause:
`discount_shop_customers.customer_name` (the segment table's own single name field, used only by its
own admin panel and `/customer-list/upload` + `/customer-list/add-one`) is **Arabic-preferred by that
table's own long-standing design** (`nameAr || nameEn`, see those two endpoints) — NOT reliably
English. My earlier fix's zero-filled fallback branch in `contractCustAllOptions` had wrongly assumed
`mc.customer_name` from `GET /customer-list` WAS the English name; for the one segment customer whose
`discount_shop_customers.customer_name` happened to hold Arabic text (added via `/add-one` at some
point when Arabic was already resolvable for that code), both "English" and "Arabic" print rows ended
up reading the exact same Arabic string.

Fixed by resolving a genuinely separate, unambiguous field: `GET /discount-shops/customer-list` now
also returns `customer_name_en` — the `customers` MASTER's own always-English `customer_name` column,
joined fresh, never the segment table's ambiguous one — and `contractCustAllOptions` prefers
`customer_name_en` over `mc.customer_name` (falling back to the latter only for a segment customer
absent from the master entirely). The segment admin panel's own display of `d.customer_name` is
**untouched** — it's a different, narrower concern (that panel's own single-name convention) than what
the contract print needs, so changing it wasn't in scope and would have been an unrelated behavior
change. Verified live against the exact real customer from the user's second screenshot (`11050068`,
"Mohamed Rshed Elrasheed Co"): `customer_name_en` now correctly resolves to the English name,
distinct from `customer_name_ar`. PM2 stable post-deploy (124→125, one restart, matching the deploy).

**Second follow-up — same bug, different code path**: a THIRD screenshot showed a customer WITH
recent sales (`11100012`) still showing Arabic in the "إنجليزي" row and `—` in the "عربي" row. This
customer comes through `incentiveScenario.perCustomer`, not the zero-filled segment-list fallback
just fixed above — a completely different source with the exact same class of bug. Root cause,
live-verified: `sales_activity.customer_name` (what the `incentive-baseline` query's `cust_months`
CTE used, unqualified, AS the "customer_name" field) is genuinely **Arabic-script for 2667 of 2668**
distinct customer codes company-wide — not English as the query's own comment previously assumed
("sales_activity only ever carries the English name" — false, corrected). Fixed the same way as the
segment-list fix: `customer_name` now prefers `customers.customer_name` (the master's own, correctly
English after the real upload) via `COALESCE(MAX(c.customer_name), MAX(cm.customer_name))`, falling
back to the raw `sales_activity` value only for a customer_code genuinely absent from the master.
Verified live: the exact customer from the screenshot now returns `customer_name: "Mohamed Rashed El
Rashed Company For Trading"` distinct from its (Arabic) `customer_name_ar`; **zero** of the 35
customers in a live incentive-baseline response still had Arabic-script text in the `customer_name`
field afterward. PM2 stable post-deploy (126→127, one restart, matching the deploy).

**Scope note, not yet acted on**: the user also asked to "حدث الأسماء جميعا على مستوى الداشبورد"
(update all names across the dashboard). The `sales_activity.customer_name`-is-Arabic discovery above
is a genuinely dashboard-wide fact, not specific to Discount Shops — any OTHER report/page that reads
`sales_activity.customer_name` (or `invoices.customer_name`, not yet checked) and assumes it's English
could have the same mislabeling wherever it's shown next to something explicitly labeled "English" or
"إنجليزي". This turn only fixed the two code paths feeding the Discount Shops contract tab specifically
(where the mislabeling was actually visible and reported) — a full audit of every other page for the
same anti-pattern is a materially larger, separate task that hasn't been scoped or done yet.

**A THIRD bug in the same area, caught while fixing the above**: even after the backend correctly
returned `customer_name_ar` for a sales-backed customer, the "اسم العميل (عربي)" row still showed `—`
in the app. Root cause: `calcIncentiveScenario`'s `perCustomer` builder (the derived array the contract
tab actually reads, NOT the raw `incentiveBaseline.customers` API response) only copied a fixed,
explicit list of fields from each raw customer row — `customer_name_ar` was never one of them, so it
was silently dropped between the API response and the contract tab regardless of how correct the
backend was. Fixed by adding `customer_name_ar` (and the new `region_name`, see below) to that
mapping. **Lesson, worth repeating**: verifying a fix by curling the raw API response is not the same
as verifying the field survives every derived/mapped object between that response and the screen —
this is the second time in this same feature a field was correctly resolved server-side and then lost
in a frontend re-shaping step (see `contractCustAllOptions`'s fallback branch fix above for the first).

### "المنطقة" column on the saved-contracts log

Requested from a screenshot of "سجل العقود المحفوظة". `115_discount_shop_contract_region.sql` adds
`discount_shop_contracts.region_name` — frozen at save time, same snapshot rule as every other field
on this table. Resolved via `customers.region_id → regions.name_ar`, the same path used everywhere
else in the app: both `GET /discount-shops/incentive-baseline` (`LEFT JOIN regions r ON r.id =
c.region_id`) and `GET /discount-shops/customer-list` now return it, flowing through
`contractCustAllOptions` (both the sales-backed and zero-filled branches — and through the
`calcIncentiveScenario` field-drop fix above) to `handleConfirmSaveAndPrint`'s save payload. New
"المنطقة" column added to the log table right after "العميل" (`—` when a customer has no resolved
region), and the two expanded-detail-row `colSpan`s bumped 9→10 to match the new column count.

Verified live: migration applied; the real customer from the screenshots (`11100012`) now returns
`region_name: "Riyadh"` from `incentive-baseline` alongside its correct English/Arabic names; a
dedicated throwaway contract round-tripped `region_name: "Riyadh"` through save → fetch correctly
(deleted immediately after). PM2 stable post-deploy (127→128, one restart, matching the deploy).

**Follow-up — backfill existing contracts + a region filter**: a screenshot of the actual log showed
every existing row's new "المنطقة" column reading `—`, since the column only gets populated going
forward (contracts saved before this feature shipped never captured a region snapshot at all — this
isn't a bug, just the expected behavior of an additive column). The user asked to link them up via
customer_code and make the column interact with the filter.

- `116_discount_shop_contract_region_backfill.sql` — one-time `UPDATE` that resolves and fills
  `region_name` for every EXISTING contract via its `customer_code → customers.region_id →
  regions.name_ar`, touching only rows where `region_name IS NULL` (so it can never clobber a real
  snapshot a newer contract already saved at print time). Live-checked first that every one of the 8
  existing contracts actually resolves to a real region (0 truly unresolvable) before writing the
  migration — confirmed after deploy: 0 rows with `region_name IS NULL` remain.
- New region `<select>` next to the existing customer filter on "سجل العقود المحفوظة" — options are
  the distinct `region_name` values actually present in the (possibly customer-filtered) log, so it
  never offers a region with zero matching rows. Filtered entirely client-side
  (`contractLogRowsFiltered`) since the log is small; no new backend query param. A region with no
  matches under the current filters shows "لا توجد عقود مطابقة لهذه المنطقة" (kept distinct from "لا
  توجد عقود محفوظة بعد", the genuinely-empty-log message, so the two read differently).

### Customer picker: Arabic name is now the PRIMARY displayed identity

Screenshot showed the "اختيار العميل" dropdown listing every customer by its English/transliterated
name ("Abd El Salam Abd El Mohsen Co El Baseria Branch (12040055)") — correct data, wrong emphasis
for an Arabic-first dashboard, especially once real Arabic names became available for virtually the
whole segment (see the earlier upload/root-cause fixes above).

- New `custDisplayName(c)` helper: `c.customer_name_ar || c.customer_name` — Arabic first, English
  only as a fallback for the rare customer still missing one (never falls back to the bare code
  alone). Used in both places a customer is picked from this list: the "العميل" dropdown and the
  "سجل العقود المحفوظة" customer filter — a single helper so the two can never drift apart on which
  name wins.
- `contractCustOptions`' search box now also matches against `customer_name_ar` (previously English
  name + code only — a user typing an Arabic name found nothing), and its sort order switched to the
  Arabic name first so the list reads in natural Arabic alphabetical order, matching what's now shown.
- The saved-contracts log table's own "العميل" cell already put Arabic first (`${customer_name_ar} /
  ${customer_name}`, from an earlier turn) — left unchanged, already consistent with this.

Verified live: of the 42 customers in the discount-shop segment, **all 42** now resolve a real
Arabic-script name via `GET /customer-list`, so the dropdown shows Arabic-primary for the entire
list, not just a subset. PM2 stable post-deploy (130→131, one restart, matching the deploy). Pure
frontend change — no backend endpoint touched, nothing else to functionally probe.

**Lesson**: a field literally named `customer_name` on a DIFFERENT table (`discount_shop_customers`)
is not the same thing as `customers.customer_name` just because they share a name — worth grepping
for every other place a table populates its own same-named column before assuming one meaning for it
everywhere it appears.

Verified live: migration applied; `GET /customer-list` and `GET /incentive-baseline` both resolve
`customer_name_ar` for the customers that have one; a dedicated throwaway contract (fake
`customer_code`, deleted immediately after) round-tripped `customer_name_ar` correctly through
save → fetch. PM2 stable post-deploy (122→123, one restart, matching the deploy).

### Saved-contracts log: live "صافي مبيعات الشهر الحالي" + bonus-qualification columns

Requested from a screenshot of "سجل العقود المحفوظة": add a column showing the customer's net sales
during the month compared to the tiers' target, and a column showing whether they currently qualify
for a bonus — which tier, and how much.

- **Deliberately NOT frozen, unlike every other field on this table** — this is a live compliance
  check against an ongoing agreement, not a historical record of what was true at print time, so it's
  computed fresh on every `GET /contracts` load against the CURRENT calendar month (`now.getFullYear()`/
  `now.getMonth()+1` at request time) — independent of whichever date-range filters happen to be
  selected elsewhere on the page, and independent of whatever month the contract was originally signed
  in. One aggregate query (`sales_activity` grouped by `customer_code` for the current month, `basis`
  picks `qty` or `revenue`) covers every contract's customer_code in a single round trip, then each
  row's own frozen `tiers` array (its real signed terms, never the live incentive-tab settings) decides
  the achieved tier via the same "highest tier whose `from` the value has reached" rule
  `calcIncentiveScenario`/`rateForAchievement` already use on the frontend — this is the backend's own
  copy of that same rule, since it needs to run once per contract row server-side here.
- New fields per contract: `current_month_label` (e.g. "سبتمبر 2026"), `current_month_value`,
  `qualifies` (bool — reached at least tier 1), `achieved_tier` (the matching tier object, or `null`),
  `bonus_amount` (`current_month_value × achieved_tier.rate/100`, `0` if not qualifying).
- Two new columns in the log table: "صافي مبيعات الشهر الحالي" (value + unit + the month label +
  a `<Dev>` deviation badge against `target_value`, the same small-badge component/pattern already
  used throughout this page's other tables) and "الحافز المستحق" (a green "✅ مستحق" pill with the
  achieved tier's label and bonus amount, or a red "❌ غير مستحق" pill — new `.ds-qualify-badge--yes`/
  `--no` CSS, matching the existing `.ds-ret-badge` pill styling already used elsewhere on this page).
  Both expanded-detail-row `colSpan`s bumped 10→12 to match the two new columns.

Verified live: fetched the real saved-contracts log and cross-checked one contract's
`current_month_value` directly against a raw `sales_activity` aggregate for that exact customer_code/
month — matched exactly (13510 = 13510). Every contract currently shows `qualifies: false` — live
sanity-checked as correct, not a bug: it's the 15th of the month, so partial-month net sales
genuinely haven't reached any contract's full-month tier-1 threshold yet for any of the 10 saved
contracts, which is exactly what an honest mid-month check should show. PM2 stable post-deploy
(133→134, one restart, matching the deploy).

### Contract-edit screen: تعديل "الهدف الشهري"/"نسبة النمو" auto-recomputes tier من/إلى

Editing a saved contract's target ("الهدف الشهري (متوسط فعلي)") or growth% by hand used to leave
every tier's من/إلى exactly as saved — the admin had to manually retype all three boundaries to keep
them consistent with the new target. `updateEditTarget` now recomputes `editDraft.tiers` on every
change to either field via `recalcEditTiers`, anchored EXACTLY the way `contractTierRows` builds a
brand-new contract's tiers: tier 1's `from` = the grown target itself
(`avg_monthly_value × (1 + growth_pct/100)`), tiers 2/3 sit at that same target × their own
`minPct/100` from the global `incentiveTiers` ladder, and each row's `to` is one step below the next
tier's threshold. Only `rate`/بونص% is left untouched (independently hand-tunable per contract).

**A first version got this wrong** — it tried to PRESERVE whatever من/إلى ratios a hand-edited
contract already had and just rescale them proportionally to how the target moved. That only keeps
tier 1 anchored to the target if it already was; a contract whose tiers had drifted (or predated
this feature) could come out of an "edit" with tier 1 starting BELOW the new target, which is
backwards and is exactly what the user caught in a live screenshot (هدف 35,265 ر.س، لكن الشريحة
الأولى تبدأ من 33,854.4 — أقل من الهدف). Recomputing unconditionally from the percentage ladder
fixes this by construction: tier 1 = the grown target every time, never dependent on whatever was
stored before.

## Hypermarkets (`/hypermarkets`) — calendar date-range filter (ported from `discountShops.js`)

`backend/src/routes/hypermarkets.js` gained the same `?date_from=&date_to=` calendar override
already proven on `discountShops.js` (itself originally cloned from this file), via the same
`periodFragment()` / `parseDateRange()` helper pair, on `/summary`, `/customer-matrix`,
`/item-overview`, `/item-matrix` and `/filters`. When both `date_from`/`date_to` are present they
override the year/month (or single-year) selection entirely and can span multiple months/years;
absent, every query is byte-identical SQL to its pre-range form (`useRange: false` short-circuits
straight to the old `= ANY($n::int[])` fragment). Validation matches `discountShops.js`:
`useRange && dateTo < dateFrom` → 400 `نطاق التاريخ غير صحيح`. `/summary`'s "new customers"
cutoff and working-days calculation both branch on range vs. years/months the same way
`discountShops.js`'s do (`workingDaysInRange()` added alongside the existing `workingDays()`).

**`/branch-expenses` and `/overview` were deliberately left untouched.** `/branch-expenses` is an
unrelated upload/CRUD endpoint for Carrefour trade-terms data. `/overview` carries this file's
unique branch-monthly-expenses deduction logic (`branchExpenses()`, `expenseBranchRevenue()`,
year-agnostic branch×month lookups) that has no analogue in `discountShops.js`'s simpler
`/overview` — porting the range override there would touch code the reference implementation
never had to reconcile a filter against, for a tab whose whole point is a "كامل الفترة" read.
This is a scope judgement call, not a hard requirement: the screenshot that prompted this feature
showed a السنة/الشهر/المنطقة/المندوب/تاريخ filter bar shaped like `/summary`'s, not `/overview`'s.

Frontend (`HypermarketsPage.jsx`/`.css`) mirrors `DiscountShopsPage.jsx` exactly: `useDateRange`/
`dateFrom`/`dateTo` state + `rangeInvalid` guard, a "فترة محددة بالتاريخ" checkbox (`hm-range-toggle`
class, translated from `ds-range-toggle`) that swaps the year/month `MultiSelectDropdown`s for two
`<input type="date">` pickers, and the same `useDateRange ? {date_from,date_to} : {years,months}`
query-building/query-key pattern on every affected `useQuery` (`hm-summary`, `hm-item-matrix`,
`hm-item-overview`, `hm-customer-matrix`). `hm-overview` was left as a plain whole-period query,
matching the backend scope decision above.

Verified live against production (28 Aug 2026): July 2026 on `/summary` — years/months
(`years=2026&months=7`) and the equivalent range (`date_from=2026-07-01&date_to=2026-07-31`)
return byte-identical `cur` blocks (19,716 qty / 311 returns / 12 active customers / 1 inactive,
by_region and by_item rows matching row-for-row), confirmed independently against direct SQL
(19,716 / 311 / 12 active / 187 invoices both ways). `/item-matrix` `year=2026` vs.
`date_from=2026-01-01&date_to=2026-12-31` foot to the same 102,145 summed `annual_qty` across the
top-20 items (SQL unlimited-item total: 102,142 both ways). `/item-overview` and
`/customer-matrix` under the July range both return 19,716 qty, matching `/summary`'s total for
the same window.

## Carrefour branch damage entry (`/carrefour-damage`, `/carrefour-damage-report`)

Manual daily توالف (damage) logging by branch, entirely separate from every other توالف figure in
the app — `quality_issues` and `sales_activity.bad_return_qty` are both uploaded from NetSuite
exports; this one has no file feed at all. Branches, the damage-item catalog, and branch↔promoter
assignment are all maintained by hand from the report page's admin settings panel.

**Third tab: الطلبيات المستلمة (received orders)** (migration 091) — same shape again,
`carrefour_order_reports` / `carrefour_order_report_items`, mounted via the same
`makeEntryGetHandler`/`makeEntrySaveHandler`/`makeReportHandler` factories at
`/order-entry`+`/order-report`. Same item catalog, same page keys — a third tab on the existing
pages. Adding a fourth count type in future is now just: one migration (copy 090/091's shape),
three `router.get/post` lines pointing the factories at the new table names, and one `TABS`/
`REPORT_TABS` entry per frontend page.

**Signature log** (migration 092, `carrefour_report_save_log`) — every entry save (any of the
three tabs) appends a row recording who saved it, when, and the line total, tagged by
`report_type` ('damage'/'stock'/'orders') so one table serves all three. This is deliberately
separate from `carrefour_*_reports.submitted_by`/`updated_at`, which only ever holds the LATEST
save (an upsert overwrites it) — a branch/date edited three times in a day would otherwise lose
the earlier two signatures. `GET /save-log?report_type=&branch_id=&date=` (same ownership scoping
as `/entry`) powers the "سجل التوقيع" list shown under the entry form for the selected
branch/date/tab.

**Photo attachments + album** (migration 093, `carrefour_report_photos`) — a promoter can attach
photos on the entry page before or after saving, since photos are keyed on
`(report_type, branch_id, report_date)` directly rather than on the report row's id. Files land on
disk under `<UPLOAD_DIR>/carrefour-photos/<report_type>/<branch_id>/<report_date>/` (numeric
branch_id keeps the path filesystem-safe; the *branch name* + date grouping the report page's
"ألبوم الصور" shows comes from the DB columns, not this folder layout) and are served through the
existing `/uploads` static route. `POST /photos` is multipart (`multer.diskStorage`, same
`fixName()`-for-non-Latin-filenames convention as `fridges.js`'s contract uploads); the
branch-ownership check can only run AFTER multer parses the body (multipart isn't in `req.body`
beforehand), so a forbidden upload's files are deleted from disk in the rejection path rather than
left orphaned. `GET /album?report_type=&date_from=&date_to=&branch_id=` backs the report page's
grouped gallery.

**KPI summary + branch chart on the report page** — `kpis` (avg per day, avg per branch,
branch-compliance %, top/bottom branch) and the horizontal bar chart under "مقارنة ... بين كل
الفروع" are both derived client-side from the same `byBranch`/`totals` the tables already render,
never a second independent computation — so the summary can never disagree with the detail tables
below it. No chart library is used (none exists in this repo — see `MonthlyBalanceChart.jsx` for
the same hand-rolled div/CSS-bar convention followed here).

**Report log is per-REPORT, not per-item** (migration 094 adds `report_no SERIAL UNIQUE` to all
three report tables) — "سجل التقارير" on the report page shows one row per saved report
(`report_no`, date, branch, `submitted_by_name`, item count, total qty), click to expand into a
nested table of just that report's items. Critically, expanded items are filtered to
**quantity > 0 only** — the entry form always POSTs the full item catalog (so an item a promoter
clears back to 0 is recorded as an explicit zero, not silently dropped from history), which used
to make the old flat one-row-per-item log mostly zero-rows (25 catalog items per report, typically
2-3 actually filled in). The zero rows are still in the DB and still count correctly in
`totals`/`byBranch`/`byItem` sums (adding 0 changes nothing) — only this log's *display* filters
them out. Grouping key is `report_id` (from the `/report` query's `r.id AS report_id`), not
`branch_id`+`report_date` — cleaner now that the report row's own id is selected.

**Branch/item delete-safety check must cover every table with an FK to it** — found live: deleting
a test branch that had a `carrefour_report_save_log` row (but its `carrefour_damage_reports` row
had already been cleaned up) 500'd with a raw FK-violation instead of the intended graceful 409,
because the original check only queried `carrefour_damage_reports`. Fixed by looping
`BRANCH_REFERENCING_TABLES` (all five tables with a `branch_id` FK and no `ON DELETE CASCADE`:
the three `*_reports` tables + `carrefour_report_save_log` + `carrefour_report_photos` —
`carrefour_branch_reps` is deliberately excluded, it DOES cascade per migration 088) and
`ITEM_REFERENCING_TABLES` (the three `*_report_items` tables) for the item delete. **Whenever a
new table gets a `branch_id`/`item_id` FK to these two, add it to the matching list** or its first
row will reintroduce this exact 500.

**Excel export** — "📥 تصدير Excel" on the report page (all three tabs), client-side via the
existing `xlsx` dependency (same `aoa_to_sheet`/`book_append_sheet`/`writeFile` convention as
`DiscountShopsPage.jsx`), so it can never disagree with what's on screen: it exports exactly
`reportsList` (sheet "سجل التقارير") and its filtered-to-quantity>0 items (sheet "تفاصيل
الأصناف") — the same data the page already fetched under the current date range + branch + item
filters, no second API call. Filename encodes the tab and branch filter (`كارفور_<مرتجعات|أرصدة|
طلبيات>[_<branch name>]_<from>_<to>.xlsx`).

**A saved date silently displays as the day before** (found live: an entry saved for Aug 30 showed
Aug 29 everywhere — the report log, the album, the missing-branches banner) — root cause is `pg`
parsing a `DATE` column into a JS `Date` object at **local midnight**, which `Date→JSON`
serialization then converts to UTC: local midnight in a UTC+3 environment becomes
`...T21:00:00.000Z` **the previous day**, and slicing the first 10 characters for display reads
that shifted date. The stored value in Postgres was never wrong — this was purely a read-side
serialization bug. Fixed by casting every `DATE` column to `::text` in the SELECT (report_date,
expiry_date, the `MAX(report_date)` in `/report`) so Postgres sends a plain `'YYYY-MM-DD'` string
that `pg` never touches — no timezone conversion possible. **Deliberately not fixed with a global
`pg.types.setTypeParser(1082, …)`** — that would touch every `DATE` column read across the whole
app in one change with no per-route regression coverage; the `::text` cast is scoped to exactly
the columns this feature displays. Any *new* `DATE` column added to a Carrefour table needs the
same `::text` cast at its SELECT site, or this bug reappears for it specifically.

**User-facing label is "مرتجعات كارفور" (Carrefour returns), not "توالف"** — the damage tab was
renamed at the user's request after launch. Internal names (route paths, table names, JS variable
names — `carrefour_damage_*` everywhere) deliberately kept the original "damage" wording to avoid
a churn-heavy rename across the DB schema/API; only the strings a user actually reads (`TABS.damage`
label/pageTitle/pageSubtitle/quantityLabel in both page files, `navConfig.jsx`, `permissions.js`
PAGES entries, `PermissionsPage.jsx`'s `carrefour_rep` description) were changed. Keep this in mind
before assuming a "توالف" grep hit needs fixing — most remaining ones are internal/code-level and
correct as-is.

- **New role `carrefour_rep`** (`ALTER TYPE user_role ADD VALUE`, migration 088) — a dedicated
  promoter account, created from the normal Users page like any other role. It has access to
  *only* `carrefour_damage_entry` (level 2); every other page reads 0 for it, including the
  dashboard — `RoleRoute`'s fallback redirect in `App.jsx` sends an unauthorized `carrefour_rep`
  to `/carrefour-damage` instead of `/` (the same special-case pattern already used for
  `fridge_admin` → `/fridges`).
- **Two page keys, one route file** (`backend/src/routes/carrefourDamage.js`): `carrefour_damage_entry`
  (the promoter's daily form; also usable by admins for on-behalf entry/testing) and
  `carrefour_damage_report` (management's dynamic roll-up + the admin settings panel, following the
  "report page carries its own admin card" pattern from `DiscountShopsPage.jsx`).
- **Tables** (migration 088): `carrefour_branches`, `carrefour_damage_items` (the item picklist —
  a dropdown, not free text, so the report can aggregate by item without typos fragmenting it),
  `carrefour_branch_reps` (branch↔promoter assignment, `UNIQUE(branch_id, user_id)`),
  `carrefour_damage_reports` (one header row per branch per day, `UNIQUE(branch_id, report_date)`,
  upserted on re-submit so the same day can be corrected), `carrefour_damage_report_items` (one
  line per item; **item_name is snapshotted onto the line** so a later item rename/delete never
  corrupts historical reports, same convention as `carrefour_damage_reports.submitted_by_name`
  surviving a deleted user account).
- **Ownership scoping**: a `carrefour_rep` may only fetch/save `/entry` for branches actually
  assigned to them (`allowedBranchIds()` in the route file, checked against `carrefour_branch_reps`);
  admins pass `null` from that helper, meaning no restriction. `/my-branches` and `/entry` use
  `requirePagePermission('carrefour_damage_entry', …)`, not `requireRoles`, so a role's access can
  still be tuned from the Permissions screen without a code change — but the ownership check is a
  second, independent gate on top, since page-level access alone can't express "only your own
  branches."
- Branch/item **delete is blocked (409) once referenced by any report** — deactivate
  (`is_active = false`) instead; same reasoning as fridges' pending-contract flag, never destroy a
  row that history depends on. The entry/report pages both filter to `is_active` branches/items
  only, so a deactivated one quietly stops being offered without deleting its past data.
- `GET /report` also returns `missing_latest_date` — active branches with an assigned rep that have
  *not* logged for the most recent date in the requested range — a simple compliance signal
  surfaced as a banner on the report page, not a strict daily-completeness audit.
- **Per-line expiry date + notes** (migration 089: `carrefour_damage_report_items.expiry_date` /
  `.notes`) — each item row on the entry form carries its own expiry date and note, separate from
  the report-level `notes` field (a general note for the whole day). Both flow through
  `GET/POST /entry` and are shown on the report page's detailed log table.
- **Item catalog seeded** from `تقرير مرتجعات كارفور.xlsx` (25 items) as
  `"<Arabic name> (<item code>)"` — the code suffix keeps names unique and gives the promoter the
  code to match against physical stock, since the catalog table has no separate code column.
- **Second tab: جرد أرصدة (stock-on-hand)** (migration 090) — the same entry/report pages gained a
  second tab alongside جرد التوالف, recording current stock balance per branch/item/day instead of
  damage, against its own `carrefour_stock_reports` / `carrefour_stock_report_items` tables (same
  shape as the damage pair, including the per-line expiry date/notes). It reuses the *same* item
  catalog (`carrefour_damage_items`) and the *same* two page keys/permissions — this is a tab on an
  existing page, not a new page, so no new `page_permissions` rows were needed. Backend:
  `makeEntryGetHandler` / `makeEntrySaveHandler` / `makeReportHandler` in `carrefourDamage.js` are
  factories parameterized by table name, mounted once for `/entry`+`/report` (damage) and once for
  `/stock-entry`+`/stock-report` (stock) — this keeps the two tabs from ever drifting apart in
  behavior, since a bug fix to one factory fixes both tabs at once.

## Fourth tab: "الأسعار Survey" — item × brand competitor price matrix

Requested from a screenshot of the entry page's existing three tabs + a photo of the promoters'
paper price-comparison spreadsheet: a promoter walks the shelf at a branch and records the observed
price of each poultry item at every competitor brand, comparing our own ("طريه") price against the
market. Fundamentally a different shape from the other three tabs — a **matrix**, not a flat item
list — and each **cell** saves immediately on entry rather than one batch "حفظ" for the whole form.

- **Two new catalogs** (`117_carrefour_price_survey.sql`), both admin-managed from the report page's
  settings panel exactly like `carrefour_branches`/`carrefour_damage_items` above:
  `carrefour_price_brands` (the matrix's COLUMNS — the competitor brands, one flagged
  `is_own_brand = TRUE` for "طريه") and `carrefour_price_survey_items` (the matrix's ROWS — a
  generic weight-class/cut catalog like "طرية 1200"/"فيليه"/"قوانص", entirely separate from
  `carrefour_damage_items`'s SKU-coded توالف catalog, since this compares the SAME physical product
  category across every brand's own product line, not our own store SKUs). Each row also carries a
  `category` (الدجاج الكامل / المقطعات / الحويصلات / المتبلات …) rendered as a full-width red
  divider row in the matrix, matching the source spreadsheet's section bars.
- **Seeded from what was visible** in the (cut-off) screenshot — 9 brands, 16 items across 4
  categories. Deliberately not assumed complete: an admin can add more of either from the same
  settings-panel cards used for the other Carrefour catalogs, rather than blocking on getting a
  complete list upfront.
- **`carrefour_price_survey_entries`** — one row per (branch, date, item, brand) cell,
  `UNIQUE(branch_id, report_date, item_id, brand_id)` so `POST /price-survey/cell` can always upsert.
  Same branch/date scoping and `allowedBranchIds()` ownership check as the other three tabs (a
  promoter only surveys their own assigned branch(es); an admin can survey on behalf of any branch) —
  but **unlike them, there is no batch save**: `POST /price-survey/cell` takes one `{item_id,
  brand_id, price}` and commits it right away, matching "يتم تسجيل الادخال وحفظه مباشرة" from the
  request. Sending `price: null`/`''` DELETEs the row (a promoter correcting a mistaken entry)
  rather than storing a `0` that would then wrongly win every "lowest price" comparison.
- **"اختصار اسم المستخدم" per cell**: `entered_by_initials`, computed once at save time
  (`initialsFrom()` — first letter of up to the first 2 words of the saver's display name,
  uppercased) and frozen on the row, shown as a small caption under the price input. Frozen rather
  than re-derived on read so it can't silently change if the user's display name is edited later.
- **Average + lowest-price highlight are computed CLIENT-SIDE** in `<PriceSurveyMatrix>`, not
  server-side — the matrix already has every cell's value in memory (from `GET /price-survey/entry`,
  which returns `items`+`brands`+`entries` together in one call), so there's no reason to round-trip
  for a per-row average: `avg` = mean of every non-"طريه" brand's entered price for that row (`null`
  brands/blank cells excluded, not treated as 0); the lowest entered price in the row — **any**
  brand, "طريه" included — gets a light-green highlight (`.cfe-price-cell--min`); "طريه"'s own cell
  additionally shows a small ▼/▲ deviation badge comparing it against that row's `avg`.
- **Frontend**: `TABS.priceSurvey` in `CarrefourDamageEntryPage.jsx` is flagged `isMatrix: true` so
  the page's three other data-fetching queries (`cfe-entry`/`cfe-save-log`/`cfe-photos`, all shaped
  for the flat-list tabs and keyed off `mode.entryPath`, which is `undefined` for this tab) stay
  `enabled: false` for it — `<PriceSurveyMatrix>` is fully self-contained with its own query/mutation
  instead. `.cfe-page` is capped at 760px for the flat-list tabs; a new `.cfe-page--wide` (1200px)
  opts this tab's wrapper out of that cap, since a 9-brand-plus-item-name matrix needs real width.

Verified live end-to-end with a dedicated throwaway branch (created via the real `POST /branches`,
deleted after) and a throwaway date far outside any real usage range: fetched the seeded matrix (16
items × 9 brands, 0 entries); saved two competitor prices (20, 24) and our own (18) for one item;
confirmed the average computes to 22 and our price correctly reads as below it; re-saved our own
cell with a different price and confirmed it updated in place (still exactly 1 row for that cell,
not a duplicate); cleared a cell with `price: null` and confirmed the row was actually deleted (0
rows), not just zeroed. Deleted all test entries and the throwaway branch afterward; confirmed 0
leftover `TEST-PRICE-SURVEY-BRANCH-%` branches and 0 leftover survey-entry rows anywhere. PM2 stable
post-deploy (134→135, one restart, matching the deploy).

### Unified cross-branch report for "الأسعار Survey"

Follow-up request: the entry tab above is per-branch (a promoter only ever sees their own branch's
matrix), so there was no single place to see the survey combined across every branch. Also asked:
when more than one branch reports the same item/brand, settle on one value if they agree, and
**visibly flag it** — not silently pick one — when they disagree.

- **`GET /price-survey/report`** (new, `carrefour_damage_report` permission — the management tier,
  not the promoter's entry tier): for every `(item, brand, branch)`, takes that branch's MOST RECENT
  entry within the requested date range (`DISTINCT ON (item_id, brand_id, branch_id) ... ORDER BY
  report_date DESC`) — a branch may have surveyed the same cell on several days in range, only the
  latest matters for "what's the price now". Returns the same `items`/`brands` shape as the entry
  endpoint, plus a flat `entries` array carrying every branch's settled-or-not value per cell
  (`branch_id`, `branch_name`, `price`, `report_date`).
- **Settle-vs-conflict resolution happens CLIENT-SIDE** in the new `<PriceSurveyReportMatrix>`
  (`CarrefourDamageReportPage.jsx`), same "backend returns raw data, frontend resolves display"
  split as the entry tab's average/min-highlight logic: group each cell's entries by their price
  (Postgres `NUMERIC(10,2)` stringifies consistently, e.g. `"15.00"`, so exact string equality is a
  safe distinctness test) — one distinct value (whether from one branch or several agreeing) settles
  normally; more than one distinct value renders `⚠️ 22.00 / 25.00` with every value's contributing
  branch(es) in a hover tooltip, and that cell is excluded from the row's average/lowest-price
  calculation entirely (an unresolved conflict shouldn't silently feed into either).
- **Fourth `REPORT_TABS` entry**, same `isMatrix: true` pattern as the entry page: the item-level
  filter and Excel export are hidden for this tab (its own catalog, no export built yet), date
  range + optional single-branch filter stay available and pass straight through to
  `GET /price-survey/report`.

Verified live with TWO dedicated throwaway branches and a throwaway date: had both branches report
the identical price (15) for one item/brand — the report correctly carries both entries at the same
value, which the frontend settles to a single "15.00"; had the two branches report DIFFERENT prices
(22 vs 25) for a different item/brand — the report correctly carries both distinct values, which the
frontend renders as a flagged conflict rather than picking one. Deleted all test entries and both
throwaway branches afterward; confirmed 0 leftover `TEST-PS-REPORT-%` branches and 0 leftover
survey-entry rows anywhere. PM2 stable post-deploy (135→136, one restart, matching the deploy).

### Settings moved from an always-visible card to its own tab

The admin settings panel (branches, item catalog, رep assignment, plus the two price-survey catalog
cards added above) used to render unconditionally below whatever report tab was open — a screenshot
showed it always taking up space under every tab, not just when actually needed. Moved into a fifth
`REPORT_TABS` entry (`settings`, `isSettings: true, adminOnly: true`):

- The tab bar filters out `adminOnly` entries for non-admins (`.filter(t => !t.adminOnly ||
  isAdmin)`) — a `carrefour_rep`/anyone else never sees the tab button at all, not just a gated body.
- The date/branch/item filter bar, the range-invalid error, and both report bodies (flat-list and
  matrix) are all now also guarded with `!mode.isSettings`, so switching to this tab shows ONLY
  `<CarrefourDamageSettingsPanel>` — no filters, no stale report tiles underneath it.
- The `data` report query gained `&& !mode.isSettings` alongside its existing `!mode.isMatrix` guard
  (this tab has no `reportPath` either, same reasoning as the matrix tab's guard above).

Pure frontend layout change — no new/changed endpoint, so nothing to functionally probe beyond
confirming the built bundle actually shipped the new branching (fetched the deployed
`CarrefourDamageReportPage-*.js` from the server and confirmed `isSettings` is present in it). PM2
stable post-deploy (136→137, one restart, matching the deploy).

### Frozen "الصنف" column + frozen header on both price-survey matrices

Requested from a screenshot of the item list — with 9 brand columns, the item name scrolls out of
view horizontally, and with 16+ rows the header scrolls out of view vertically.

- **Frozen item column**: `.cfe-price-item-col`/`.cfr-price-item-col` get `position: sticky; right:
  0` — `right`, not `left`, because in this RTL layout the first DOM column (item name) renders at
  the table's visual right edge, which is the edge it needs to stay pinned to while the rest of the
  matrix scrolls under it. Needs an opaque `background` (the same `--color-surface` token every
  `.cf*-card` already uses) or cells scrolling underneath would show through the "frozen" one — plus
  a small `box-shadow` so the frozen edge reads as a visible seam, not a coincidence.
- **Frozen header row**: `thead th { position: sticky; top: 0 }` — works for BOTH page-level scroll
  and a bounded scroll box, since `.cf*-table-wrap` only ever sets `overflow-x` (never
  `overflow-y`), so the sticky element's nearest scrolling ancestor is whichever actually scrolls
  vertically (typically the page itself here).
- **The header's item-name cell is sticky on BOTH axes at once** (it's simultaneously the frozen
  column's header AND the frozen row's leftmost — rightmost, in RTL — cell) and needs the highest
  `z-index` of the three sticky layers so it stays on top at the frozen corner.
- **Category divider rows needed a different fix, not just the column's own stickiness**: a
  divider is ONE `colSpan` cell spanning every column — pinning the `<td>` itself would freeze the
  entire red bar in place (hiding the columns behind it) rather than letting it scroll normally.
  Fixed by pinning the LABEL text inside it instead (`<span className="…-cat-label">`, itself
  `position: sticky; right: 10px`) so the bar still scrolls with the table but its category name
  stays readable at the frozen edge the whole time.

Applied identically to both `CarrefourDamageEntryPage.jsx` (the promoter's per-branch matrix) and
`CarrefourDamageReportPage.jsx` (the cross-branch report matrix) — same shape, same fix, same
`.cf*-price-*` naming convention (`cfe-`/`cfr-` prefixes only). Pure CSS/JSX change, no backend
touched — verified by fetching both freshly-built CSS bundles from the server and confirming
`position:sticky;right:0` and `position:sticky;top:0` are both present in each. PM2 stable
post-deploy (137→138, one restart, matching the deploy).

## Quality-defect returns (`/quality-returns`, `/quality-returns-report`)

مرتجعات عيوب الجودة — daily entry by item × route within ONE region at a time, entered by a new
dedicated "مراقب مرتجعات جودة" (`quality_returns_monitor`) role. **Distinct from every other
توالف/quality figure already in the app**: `quality_issues.js` is a NetSuite-uploaded
warehouse/QC report with no route/rep dimension at all; `carrefour_damage_*` is a different
business (Carrefour branches, not regions/routes) with its own manually-maintained item catalog.
This module deliberately reuses the app's *existing* routes/reps infrastructure rather than
inventing a parallel one the way Carrefour did:

- **Item list is NOT a maintained catalog** — `GET /items` pulls `DISTINCT item_name_en FROM
  sales_activity` live (only 65 distinct items total, small enough to render as full grid rows
  with zero pagination concern). Adding a product to NetSuite/sales makes it appear here
  automatically; nothing to maintain.
- **Routes and reps are the existing `routes` / `sales_reps` tables** (`sales_reps.route_id`,
  added by migration 065) — no new "branch" concept. `routes.region_id` is what "خط سير المنطقة"
  means here. A route's rep(s) come from `sales_reps WHERE route_id = routes.route_id AND
  is_active`.
- **رقم السيارة (vehicle number)** is one new column, `sales_reps.vehicle_number` (migration 095),
  editable from the *existing* `/rep-management` page's add/edit rep form — no new UI needed for
  this single field, per explicit user preference over building a parallel edit screen.
- **Entry grid shape**: rows = items, columns = every route in the ONE selected region (shown
  together, saved together in a single submission) — not one route at a time. Expiry date is
  entered **once per item row**, applied to every route's non-zero line for that item on save
  (a per-cell expiry would make an already-wide grid, up to 11 routes × 65 items, unusable).
- **Only quantity > 0 lines are ever saved** (`quality_returns_report_lines`) — unlike Carrefour's
  entry (which always POSTs the full item catalog, discovered to create noisy all-zero rows later
  filtered at display time), this grid's combinatorial size (up to 715 item×route cells per single
  region/day) makes saving every zero cell wasteful at the DB level, not just noisy on screen. The
  frontend filters to `quantity > 0` client-side before POST.
- **Region↔monitor assignment** (`quality_returns_region_monitors`, same shape as
  `carrefour_branch_reps`) is the report page's admin settings panel — a monitor only sees/enters
  their assigned region(s); admins pass unrestricted (same `allowedRegionIds()` pattern as
  Carrefour's `allowedBranchIds()`).
- **Report page**: search across ALL regions with a date range (`date_from`/`date_to`, region,
  route, item filters), KPI summary + region-comparison bar chart, per-report expandable log
  (`report_no` SERIAL like Carrefour's), and Excel export — all following the exact patterns
  proven on `CarrefourDamageReportPage.jsx`. No photo/album feature here — not requested for this
  module.
- **Arabic name + item code overlay** (migration 096, `quality_returns_item_info`) — sales_activity
  has NO Arabic item name and NO item code anywhere in the schema (verified), so these are a pure
  admin-maintained DISPLAY overlay keyed on the same `item_name_en` identity already used
  everywhere — never the join key for anything, so a blank/missing row just falls back to showing
  the English name. Edited from a card on the report page's settings panel
  (`QualityReturnsItemInfoPanel`), takes effect immediately on the entry grid too
  (`qc.invalidateQueries(['qre-entry'])` on save). `fetchItemList()` in `qualityReturns.js` is the
  single shared query behind `/items`, `/entry`, and `/filters` — it also resolves each item's
  `item_category` from its own most recent `sales_activity` row, and the entry grid groups rows
  under a category header using that field.
- **Item master bulk import**: `quality_returns_item_info` was seeded from `item master -
  Copy.xlsx` (Item Code / Item Name English / Item Name Local columns) — 64 of 65
  `sales_activity.item_name_en` values matched the master's English name **exactly**
  (case/whitespace-sensitive); the one miss (`Bulk 600gm Fresh Saja`) turned out to be a
  non-breaking-space (`\xa0`) in the source file instead of a normal space — normalizing
  whitespace before matching (never before writing — the stored `item_name_en` key must stay
  byte-identical to `sales_activity`'s) fixed all 65.
- **Route visibility toggle** (migration 097, `quality_returns_route_settings`) — a region can
  have far more routes (11 for Riyadh) than fit usefully as grid columns, so only a subset is
  "active" at a time. Deliberately its own table, **not** a column added to the shared `routes`
  table — that table is read by rep-management/invoices/etc., and "shown in this grid" is a
  quality-returns-only concept. Seeded so only the first 5 routes per region (by `route_id`) start
  active; `GET/PUT /quality-returns/routes` (admin-only for the PUT) manage the rest from a
  collapsible panel on the entry page. `GET /entry`'s routes query INNER JOINs this table
  (`is_active = TRUE`) so only toggled-on routes ever render as columns — **deactivating a route
  does not touch its already-saved lines**, which stay fully visible on the report/search page
  (that page's queries never filter by this table at all, deliberately, since "hide this column
  today" must never mean "this route's history disappeared").
- **Per-user category visibility** (migration 098, `quality_returns_user_category_prefs`) —
  deliberately separate from the route toggle above: routes are a shared per-region admin
  setting, but which item categories show is a **personal** preference (`PRIMARY KEY (user_id,
  item_category)`), so any entry-page user — monitor or admin — manages their own, not
  admin-gated. Default (no saved row) is active, so an unvisited category still shows exactly as
  before. Filtering happens ONLY on the entry page's displayed `items`/`groupedItems` lists —
  `handleSave` always iterates the full unfiltered `allItems`, so hiding a category can never drop
  an already-saved value for it from the next save's payload.
- **Photo attachments, signature log, and PDF print** (migration 099) — brought to full parity
  with the Carrefour module: `quality_returns_report_photos` / `quality_returns_save_log` mirror
  `carrefour_report_photos` / `carrefour_report_save_log` exactly (same multer setup, same
  append-only signature log inserted inside the `/entry` save transaction). Two photo endpoints
  exist for the same reason Carrefour needed both: `GET/POST/DELETE /photos` is gated by the
  ENTRY permission with ownership scoping (a monitor can only touch their own region's photos),
  while `GET /report-photos` is gated by the REPORT permission with no ownership check (a report
  viewer already sees every region). **Print is per-saved-report, not a page screenshot** —
  unlike the rest of the app's window.print() usage (which prints the current live view),
  clicking 🖨️ on a `QualityReturnsReportPage` row populates a `printTarget` state from that row's
  already-fetched `reportsList` entry (no extra API call) and a `useEffect` fires
  `window.print()` once the hidden `.qrr-print-only`/`.qre-print-only` block has rendered with it;
  the entry page's print button uses the live grid's current unsaved state instead
  (`printRows` derived the same way `handleSave`'s payload is, filtered to quantity > 0) — both
  print exactly `Logo.png` + a quantity summary + a condensed quantity>0-only table + the report
  date, per the explicit request to keep the printed table small.
- **Admin-mandatory categories** (migration 100, `quality_returns_mandatory_categories`) — a
  second layer on top of the per-user category prefs: a row present here means that category is
  forced active for EVERY user and cannot be turned off by them (`PUT /category-prefs` rejects the
  attempt with 409). This **changed the default for a non-mandatory, never-touched category from
  active to inactive** — before this migration a fresh user saw every category; now they see only
  what the admin marked mandatory until they opt into more themselves via "فئات أخرى متاحة".
  `GET /category-prefs` computes the combined state per category (`is_mandatory ? true :
  userPref ?? false`) so the entry page never needs to know about the two tables itself — it just
  reads `is_active` + `is_mandatory` (for the lock icon) from one response. Admin management lives
  in `QualityReturnsMandatoryCategoriesPanel` on the report page's settings section, completely
  separate from `QualityReturnsCategoryTogglePanel` (per-user, entry page).
- **"Total" denominators are monitored regions/routes, not every region the company has** —
  `regions_total`/`routes_total` in `/report`'s totals now count only regions with a row in
  `quality_returns_region_monitors` (and routes inside them), not `COUNT(*) FROM regions`/`routes`.
  A region nobody covers can never submit a report, so counting it in the denominator would
  permanently understate compliance for no actionable reason — same reasoning `missing_latest_date`
  already used (it `JOIN`s the same table), just not yet applied to these two totals until now.
- **Export-to-Excel button color** (`.qrr-btn.qrr-btn--export`) uses the Excel brand green
  (`#107c41`) with a visible border + shadow instead of a plain flat `#16a34a` — the flat green
  was reported as "unclear" against the page's cream background, and its `:disabled` state used
  a near-background gray (`#cbd5e1` on `#cbd5e1` border) that made the button nearly invisible
  whenever `reportsList` was still loading. The disabled state now keeps a visible gray border
  (`#94a3b8`) so users can tell a real (temporarily-disabled) button apart from empty space.
  **Specificity gotcha**: the first pass wrote the rule as `.qrr-btn--export` (single class) —
  same specificity as the generic `.qrr-btn` base rule that appears later in the file, so the
  base rule's `background`/`border` silently won the cascade (source order tiebreak) while the
  export rule's `color:#fff` still applied, leaving white text on a white button in the resting
  state — visible only on `:hover`, which has its own higher-specificity rule. Selector is now
  `.qrr-btn.qrr-btn--export` (two classes) so it always outranks the plain `.qrr-btn` rule
  regardless of file order. When overriding `.qrr-btn` on any page, always compound the class
  like this rather than relying on declaration order.
- **Per-rep and top-5-item charts** on the report page — `byRep` (grouped by `route_id`, using the
  `rep_names`/`vehicle_numbers` fields the report query already joins) and `byItemTop5`
  (`byItem.slice(0, 5)`) are both derived client-side from the same `rows`/`byItem` the tables
  already render, so they can never disagree with the numbers below them — same "derive, don't
  recompute" pattern as `kpis` and the region chart.
- **New role added to `user_role` enum**: remember to add `quality_returns_monitor` to BOTH
  `PermissionsPage.jsx`'s `DATA_SCOPE` and `ROLE_DESCS` objects when adding it — see the "Cannot
  destructure property 'icon' of undefined" incident above. It was added correctly in the same
  commit this time.

## Sales Activity — تقرير الحضور الشهري: first 5 columns pinned while scrolling

`ReportTab`'s table (`#`، اسم العميل، الكود، المنطقة، المندوب، التصنيف، then one column per month) is
wide enough that identifying a customer while scrolled deep into the month columns meant scrolling
back. The `.sap-table` shared class already pinned column 1 via `position: sticky; right: 0` (RTL,
so "pinned to the right") — extended to the first 5 columns via a new `.sap-table--report` modifier
class on THIS table only (not `NewCustomersTab`/`StoppedCustomersTab`, which share `.sap-table` but
have fewer columns and don't need it). Each of the 5 columns gets an explicit fixed width so the
cumulative `right` offsets (0/40/220/310/400px) line up — without a fixed width, sticky offsets are
computed once and differing row content lengths would make columns jitter/misalign. Column 5 carries
a small inward box-shadow so the boundary between the pinned area and the scrolling columns reads
clearly. Verified visually (a standalone HTML mockup reproducing the exact CSS, scrolled in the
Browser pane) rather than guessing sticky-positioning behavior — confirmed the first 5 columns stay
fixed while the month/totals columns scroll underneath.

## Sidebar groups (admin-organized folders in the nav)

The sidebar grew to ~28 flat items as more report pages shipped (Carrefour, Quality Returns,
Discount Shops, …), so admins can now bundle related pages under a collapsible named group —
building on the existing `sidebar_order` reorder feature (`SidebarOrderContext.jsx`, `PUT/GET
/api/settings/sidebar_order`, a plain JSONB `app_settings` row) rather than adding a parallel
mechanism.

- **Same setting, richer shape**: `sidebar_order`'s value was a flat array of pageKey strings; it's
  now an array that can mix plain strings (ungrouped items) with group nodes
  `{ type: 'group', id, label, keys: [pageKey, ...] }`. No backend change was needed — `PUT
  /api/settings/:key` already accepts arbitrary JSON — and it's still the same global, shared-by-
  everyone setting it always was (`GET` has no role check), so a group an admin creates is visible
  to every role, including whichever role is "المدير العام", without any extra plumbing.
- **`navConfig.jsx` gained a second consumer of the same order value**: `applyNavOrder` (unchanged
  contract — returns a flat, re-sorted item array) still flattens group `keys` in place for
  `BottomNav.jsx`, which has no concept of groups on mobile. `buildSidebarLayout` is the new
  function `Sidebar.jsx` uses instead — it returns `{type:'item', nav}` / `{type:'group', id,
  label, items:[nav,...]}` nodes for the desktop sidebar to actually render as collapsible
  sections. Both functions share the same "append anything missing from `order`" fallback so a
  newly-added nav item can never silently disappear from either surface.
- **Moving an item in/out of a group is a `<select>`, not nested drag-and-drop**: the existing
  flat-array HTML5 DnD (`onDragStart`/`onDragOver` splicing `draftOrder` by index) still reorders
  top-level entries — a group is just another entry in that same array, so it needed no changes.
  Nesting real drag-and-drop inside a draggable group box is a known rabbit hole (nested dragover
  targets, drop-zone ambiguity); a "نقل إلى…" select per item is far simpler to get right and
  covers the actual need (assign an item to a group / move it back out) without needing to support
  reordering *within* a group in v1.
- **Viewing-side collapse is per-browser, not part of the shared setting**: which groups a given
  person has collapsed is stored in `localStorage['sidebar_collapsed_groups']`, separate from the
  admin-authored grouping itself — otherwise one person collapsing "كارفور" on their screen would
  collapse it for every other user on next load, which is not what "organize my view" should mean.
- Deleting a group (🗑 in the reorder modal) ungroups its items back to top-level AT THE GROUP'S
  FORMER POSITION in `draftOrder`, rather than appending them at the end — so deleting an empty or
  unwanted group doesn't reshuffle the rest of the menu.

## Fleet management (`/fleet-management`, `104_fleet_management.sql`)

Full vehicle-fleet system: a master registry, weekly odometer readings, an odometer-driven
maintenance schedule with due/overdue alerts, a maintenance history log, and expense tracking.
Categories are fixed to the six the user specified: `ton_3` / `ton_5` / `ton_10` / `trailer` /
`hino` / `staff_car`.

- **No new `user_role`**: product decision was ONE central fleet coordinator maintains every
  vehicle's data (not self-service per rep), so access is gated purely through the existing
  `page_permissions` mechanism under pageKey `fleet_management` — same `requirePagePermission`/
  `RoleRoute`/`PermissionsPage` machinery every other page uses, nothing fleet-specific to it.
- **Seeded from `sales_reps.vehicle_number`**: the migration inserts one `fleet_vehicles` row per
  distinct non-blank plate number already on file for reps (`assignment_type='rep'`,
  `assigned_rep_id` set), with `category` left `NULL` ("غير مصنّفة" in the UI) — a plate number
  alone doesn't reveal truck class, so guessing would risk wrong maintenance intervals; the fleet
  admin classifies these from the vehicle list once. Trucks used for region/farm/slaughterhouse
  transport are added manually (`assignment_type` = `region_transport` / `farm_slaughterhouse`,
  free-text `assignment_label`) since nothing in the app already tracks those.
- **Maintenance "due" is computed at read time, never stored**: `fleet_maintenance_schedule` only
  keeps `interval_km` and `last_service_km`/`last_service_date` — due/overdue is always
  `current_odometer_km - last_service_km` vs `interval_km`, computed fresh in the query. This means
  changing a vehicle's interval or correcting its last-service figure instantly and correctly
  changes its alert status, with no "next_due_km" column that could go stale.
- **Recording maintenance rolls the schedule forward in the same transaction**: `POST
  /vehicles/:id/maintenance` inserts into the append-only `fleet_maintenance_log` AND updates
  `fleet_maintenance_schedule.last_service_km/last_service_date` for that type, in one DB
  transaction — so the dashboard's overdue count can never be read in a state where a service was
  just logged but the schedule hasn't caught up yet.
- **Recording an odometer reading never regresses `current_odometer_km`**: the `UPDATE
  fleet_vehicles` after inserting into `fleet_odometer_readings` only applies when the new
  reading's date is `>=` what's already on file (`odometer_updated_at`), so a backdated correction
  entry (e.g. filling in a missed week after the fact) can't accidentally roll the vehicle's
  "current" figure backwards and break the maintenance-due math.
- **Weekly odometer-update reminder is a persistent dashboard alert, not a push notification**: the
  overview tab's "لم يُحدَّث عدادها منذ أكثر من أسبوع" card lists every vehicle whose
  `odometer_updated_at` is `NULL` or `<= CURRENT_DATE - 7 days`. A cron-driven notification was
  considered (the app already has `node-cron` wired in `index.js`) but a standing dashboard alert
  was simpler to ship correctly and matches this app's existing "compliance alert card" convention
  (Carrefour/Quality-Returns reports) rather than inventing a new notification-delivery path.
- **Default maintenance intervals are generic placeholders, not the user's real policy** — the user
  had no company-specific standard yet, so `104_fleet_management.sql` seeds five common types
  (engine oil, tires, brakes, full service, air/fuel filters) at illustrative km intervals via
  `fleet_maintenance_types.default_interval_km`, editable per type from the settings tab and
  per-vehicle from `fleet_maintenance_schedule.interval_km`. Treat these numbers as a starting
  point to be tuned, never as validated policy.
- Adding a new maintenance type does **not** retroactively backfill a schedule row onto every
  existing vehicle (kept simple for v1) — only vehicles created after that point auto-seed it; an
  existing vehicle can still get it added manually if that turns out to be needed often enough to
  justify a bulk-backfill endpoint later.

### `fleet_supervisor` role (`105_fleet_supervisor_role.sql`)

The fleet-management feature above was initially wired to only super_admin/it_admin via
`page_permissions`, with no dedicated role — but a real account (`movement@taryahpoultry.com.sa`)
needed to be assignable as the "مسؤول أسطول مركزي واحد" fleet coordinator, and the `Users.jsx` role
dropdown has no generic "give arbitrary page access to a plain user" option — every assignable role
is a fixed list. So a new role, `fleet_supervisor` ("مشرف حركة"), was added scoped to just
`fleet_management` (edit access), the same one-role-one-feature pattern as `carrefour_rep` /
`quality_returns_monitor`.

**Every file that touches those two existing scoped roles needed the same edit for the new one** —
this is the same class of bug as the earlier "Cannot destructure property 'icon' of undefined"
incident (`quality_returns_monitor` missing from `PermissionsPage.jsx`'s `DATA_SCOPE`/`ROLE_DESCS`
crashed the whole page). The full checklist, all done together this time:
- `ALTER TYPE user_role ADD VALUE` + a `page_permissions` grant row (migration)
- `backend/src/routes/auth.js` AND `backend/src/routes/users.js` — both carry their own separate
  hardcoded `allowed` role array for login/account-creation validation; missing it from either one
  blocks that specific action even though the enum value exists
- `frontend/src/data/permissions.js` — `ROLES` (dropdown list) and `DEFAULT_PERMS.fleet_management`
- `frontend/src/pages/PermissionsPage.jsx` — `DATA_SCOPE` and `ROLE_DESCS` (**the crash-prone
  pair** — both are keyed dictionaries the render code indexes directly with no fallback)
- `frontend/src/pages/Users.jsx` — its own separate `ROLES` badge-label object (NOT the same object
  as `permissions.js`'s `ROLES` — two independent role-label dictionaries exist in this codebase)
- `frontend/src/pages/PermissionsPage.css` and `Users.css` — a `.role-<color>` CSS class for
  whatever `color:` string was picked in the two ROLES objects above (`role-fleet` here)
- `frontend/src/App.jsx`'s `RoleRoute` fallback-redirect ternary — where a denied user bounces to
  instead of `/`

### Inline category classification on the fleet vehicles list

The 35 rep vehicles seeded from `sales_reps.vehicle_number` all land with `category = NULL`
("غير مصنّفة") since a plate number alone doesn't reveal truck class (see the fleet-management
section above). Classifying them one-by-one through each vehicle's full expandable profile was
needless friction, so the "التصنيف" column in the vehicles list (`FleetManagementPage.jsx`) is a
`<select>` bound directly to `PUT /api/fleet/vehicles/:id` — pick a category, it saves immediately,
no need to open the row. `category: category || null` on the frontend maps the empty
"غير مصنّفة" option back to `NULL` explicitly, matching the backend's `category = $2` (not
`COALESCE`) — so re-selecting "غير مصنّفة" correctly un-classifies a vehicle rather than being a
no-op.

### Fleet vehicle assignment: partial-update bug + rep picker/driver name/make+model

**Real bug found and fixed**: `PUT /api/fleet/vehicles/:id` originally set every assignment-related
column (`assigned_rep_id`, `assignment_label`, `make`, `model`, `model_year`) on every call,
defaulting to `NULL` whenever the field was absent from `req.body`. The inline category-classify
dropdown on the vehicles list sends only `{ category }` — so every time someone classified a
vehicle's truck type, its rep link (and make/model) silently got wiped back to `NULL`. Fixed by
rewriting the handler as a true partial update: it only touches a column when that key is actually
present in `req.body` (`'field' in body`, never `body.field` truthiness, which can't distinguish
"absent" from "explicitly null"). **Any future field added to this endpoint must follow the same
pattern** or it reintroduces this exact class of bug.

- **`assigned_rep_id` and `driver_name` are mutually exclusive**, matching `assignment_type`: a
  rep-owned vehicle (`assignment_type = 'rep'`) is linked by a real FK picked from
  `GET /api/fleet/reps` (a rep name typed as free text could drift from the actual `sales_reps` row
  and silently break the link) — `driver_name` is a free-text optional field only for the other
  assignment types, which have no corresponding entity to link to. Both the frontend add-form and
  the backend enforce this: whichever one doesn't apply is force-nulled server-side too, so a
  crafted request can't set both.
- Changing `assignment_type` in a `PUT` is treated as one logical edit together with
  `assigned_rep_id`/`driver_name`/`assignment_label` — only present when `assignment_type` is
  itself part of the request body. Editing an unrelated field (e.g. `notes`) never touches who the
  vehicle is assigned to.
- Added `make`/`model` inputs to the add-vehicle form (`106_fleet_driver_name.sql` also added the
  `driver_name` column) — the columns already existed in `104_fleet_management.sql` but had no form
  fields exposing them.

### Full vehicle-profile edit form (VehicleProfile → "✏️ تعديل بيانات السيارة")

The 35 vehicles seeded from `sales_reps.vehicle_number` only ever had a plate number, a rep link,
and (via the list's inline dropdown) a category — there was no screen to fill in their remaining
details (make/model/year, status, notes) or to correct their assignment. Rather than a separate
edit page/modal, the edit form lives inside the same expandable `VehicleProfile` row the list
already opens (click a vehicle's `▸`) — a "✏️ تعديل بيانات السيارة" toggle reveals the exact same
field set as the add-vehicle form (rep picker when `assignment_type='rep'`, else assignment
label + optional driver name; make/model/year; status; notes), pre-filled from the vehicle's
current row. Saving sends the whole form in one `PUT`, which is safe under the partial-update
backend from the fix above — it only intentionally means to touch every field it sends.

### Vehicle region — always live from the rep's CURRENT region, never a stored copy

`107_fleet_region.sql` adds `fleet_vehicles.region_id`, but that column is only ever read/written
for **non-rep** vehicles (`region_transport`/`farm_slaughterhouse`/`unassigned`). A rep-linked
vehicle's region is computed at query time as `COALESCE(sr.region_id, v.region_id)` — literally the
rep's own `sales_reps.region_id` — because the request was explicit: "المنطقة المربوط عليها
المندوب **حاليًا**" (the region the rep is *currently* linked to). Storing a copy on the vehicle
would silently go stale the moment that rep gets reassigned to a different region; a live join
can't.

- Both `POST`/`PUT /vehicles` force `region_id` to `NULL` whenever `assignment_type === 'rep'`,
  even if the caller sent one — so a vehicle can never carry a manually-set region that a rep link
  would just override anyway, avoiding dead/misleading data sitting in the column.
- `GET /api/fleet/regions` is a **separate, unrestricted** endpoint from `GET /api/users/regions` —
  the latter runs `applyRegionFilter`, which would scope `fleet_supervisor` (not in the "all
  regions" role list, and with no region of its own) down to **zero** regions. The fleet page always
  needs the full region list regardless of who's viewing it, so it gets its own endpoint rather than
  depending on a filter designed for a different access model.
- The vehicles-list `region_id` filter and the profile's displayed region both key off this same
  effective/COALESCE value — never off the raw `fleet_vehicles.region_id` column directly, which
  would silently miss every rep-linked vehicle.

### Route-visibility toggle: opened from admin-only to the region's own monitor

The "التحكم بخطوط السير الظاهرة" panel on the Quality Returns entry page was originally gated
`isAdmin &&` on the frontend and `requireRoles(...ADMIN_ROLES)` on `PUT
/quality-returns/routes/:routeId/active` — but a non-admin monitor account reported the control
"not showing", which was working as originally designed, not a bug: only super_admin/it_admin could
see or use it. On reflection this was the wrong call — the region's own monitor is the one who
actually has to work with a too-wide grid day to day, not an admin who never opens that page.

- Backend: `requireRoles(...ADMIN_ROLES)` → `requirePagePermission('quality_returns_entry', 2)`,
  the same edit-level check `POST /entry` already requires — plus an explicit `allowedRegionIds`
  scoping check (the same one `GET /routes` already uses) so a monitor can only toggle routes
  belonging to a region they're actually assigned to, never an arbitrary route elsewhere.
- Frontend: the panel's render condition dropped `isAdmin &&`, now matching the category-visibility
  panel right above it (`regionId && ...`, never admin-gated).
- `quality_returns_route_settings` has no `user_id` column — it's one shared row per route, not a
  per-user preference. In practice this is fine: `quality_returns_region_monitors` normally assigns
  one monitor per region, so "shared with other users" rarely means "shared with someone else
  actively using it at the same time."

### Incentive-scenario growth%/tiers now persisted (`discount_shops_incentive_settings`)

`incentiveGrowthPct`/`incentiveTiers` on "سيناريو حافز % من المبيعات" were pure client `useState` —
every reload (or a different admin opening the page) silently reset them back to the hardcoded
defaults (10%, 100/110/125% at 2/3/4%), discarding whatever had been tuned. Fixed by persisting to
the existing generic `app_settings` key/value store (same infra as `smtp`/`sidebar_order` —
`GET/PUT /api/settings/:key`) under key `discount_shops_incentive_settings`, value
`{ growthPct, tiers }`. No new backend endpoint or table needed — this store already does exactly
this (GET open to any authed user, PUT admin-only server-side, and `discount_shops` itself is
already admin-only per `DEFAULT_PERMS`, so there's no permission mismatch to worry about). Two
"💾 حفظ" buttons (one by the growth% field, one under the tiers table) both call the same
`handleSaveIncentiveSettings`, saving both fields together as one settings object.

**This was a deliberate save-on-click design, not autosave**: the contract-print tab downstream
reads these same `incentiveGrowthPct`/`incentiveTiers` values live (see the fleet/contract sections
above), so persisting them also fixes contracts from silently using different numbers after a
reload — but only once an admin actually clicks save, matching the explicit "زر حفظ… عند تغييرها"
request rather than writing to the server on every keystroke.

## Rep Debt (`/rep-debt/:repName`) — exclusion filters for print/export

Added two toggle buttons ("استبعاد كارفور" / "استبعاد القيم صفر") next to the tabs on
`RepDebtPage.jsx`, purely client-side (no backend change — the page already fetches the full
invoice + `customers_net` payload and renders/prints/exports from it):

- `excludeCarrefour`: filters out any row whose `customer_name` matches `/كارفور|carrefour/i`
  (helper `isCarrefour`).
- `excludeZero`: filters out rows whose relevant balance field (`balance` for invoices,
  `total_balance` for the per-customer net-debt view) is exactly `0`.

Both filters are applied once, upstream of `sortedInvoices`/`sortedCustomers` (via a `useMemo` on
the raw arrays), so the on-screen table, the print view, and the Excel export all stay consistent
automatically — matching this app's established "one filtered source of truth" convention rather
than filtering separately in each of the three output paths.

**Footer/KPI totals**: `summary.*` from the backend is an *unconditional* aggregate (all rows,
no filter) — used as-is when no filter is active so it always matches the backend's rule exactly.
The moment either filter is on, the danger KPI, both tables' `tfoot`, the print-footer note, and
the Excel export's totals row all switch to `custSummary`/`invSummary`, recomputed client-side by
reducing over the *filtered* `sortedCustomers`/`sortedInvoices` — otherwise a printed page would
show a subset of rows next to a total that still includes the excluded ones, which would look like
a bug to whoever signs the printout.

## Current Stock (`/current-stock`) — region toggle chips now actually subtract from totals

`StockMatrix` inside [`CurrentStockPage.jsx`](customer-balance-app/frontend/src/pages/CurrentStockPage.jsx)
has region filter chips (`checkedRegions`) that only ever controlled which region *columns* were
rendered (`visibleRegions`) — the "الإجمالي" column, each type/item row's total, and the grand-total
row were all computed from `td.locTotals`/`itemLocs`/`grandByRegion`, which are built from every
region in the filtered dataset regardless of `checkedRegions`. So unchecking a region hid its
column but left its quantity baked into every total — looked like the toggle didn't do anything
to the numbers.

Fixed by adding one helper, `sumVisible(map) = visibleRegions.reduce(...)`, and routing every total
through it instead of `[...map.values()].reduce(...)`: type-row `typeTotal`, item-row `itemTotal`,
the `__total__` column's sort comparator, item-row sort order, and the grand-total row
(`visibleGrandTotal`, replacing the old unconditional `grandTotal`). Per-region cells are untouched
(a region's own column always shows that region's own number) — only the aggregate "الإجمالي"
values now shrink/grow as region chips are toggled on/off.

## Coverage — multi-region filter on "متابعة الزيارات اليومية" only

`CoveragePage.jsx`'s region filter (`branch` state) is shared by all three tabs, but only
`ranking`/`profile` actually need a single value (the rep dropdown filters by exactly one branch).
The "متابعة الزيارات اليومية" tab got its own independent piece of state, `visitsBranches`
(`null` = كل المناطق, a `Set` = a chosen subset, an *empty* `Set` = a deliberate "لا شيء" — same
three-state convention as the fleet/current-stock matrix region chips), rendered through a new
`BranchMultiDropdown` component (checkboxes in the same dropdown-panel chrome as the existing
single-select `BranchDropdown`, not chips — this page's filters are all dropdowns, and chips would
look like a different UI language bolted onto one filter). Switching to the `visits` tab swaps in
`BranchMultiDropdown` in place of `BranchDropdown` for that one filter slot; `ranking`/`profile`
never see it.

Backend (`GET /coverage/visits-range`) now takes zero or more `?branch=` params — Express folds
repeats into an array, one stays a string, none means "all" (unchanged default). A non-admin's
`allowedBranches` region scoping still applies: the requested branches are intersected with it
first, and only fall back to the *full* allowed set if that intersection is empty (mirrors
`/region-performance/period-compare`'s own multi-branch handling). The explicit "لا شيء" case is
never sent to the API at all — `VisitsTrackingView` short-circuits locally (`enabled: false` on the
query) and renders the same "اختر منطقة واحدة على الأقل" empty state the fleet/stock pages use for
their own empty-selection case, rather than teaching the backend a distinct meaning for zero
`branch` params (which already means "all").

Verified live: single-region query for region A ∪ single-region query for region B == multi-region
query for [A, B] (exact rep-count match), and the multi-region result is a strict subset of the
unfiltered "all regions" result.

## Fleet management — vehicle categories & expense line items now admin-editable (`108_fleet_category_settings.sql`)

`CATEGORIES`/`CATEGORY_LABELS_AR` (تصنيفات السيارات) and `EXPENSE_CATEGORIES` (بنود المصروفات) in
`fleet.js` used to be hardcoded JS arrays, and `fleet_vehicles.category`/`fleet_expenses.category`
each had a hard `CHECK (category IN (...))` restricting them to those exact fixed lists — so there
was no way to add a new vehicle category or expense line item without a code change. Turned both
into admin-editable lookup tables (`fleet_vehicle_categories`, `fleet_expense_categories` — `key`
IS the primary key, since `key` is exactly the string already stored in every existing row, not a
separate surrogate id), seeded with the exact same keys/labels the hardcoded lists used so no
existing data needed touching. The CHECK constraints were dropped and replaced with real FOREIGN
KEYs to the lookup tables' `key` column (`ON UPDATE CASCADE`) — including one added to
`fleet_maintenance_types.category` ("التصنيف المستهدف"), which had never had a CHECK at all, only
the same app-level `.includes()` check. A category/item is only ever deactivated (`is_active =
FALSE`), never physically deleted — same soft-delete-only convention as `fleet_maintenance_types` —
so nothing already using it ever dangles.

**Validation moved from app-level `.includes()` to the DB's own FK** — every route that writes
`category` (POST/PUT vehicles, POST expenses, POST/PUT maintenance-types) now just lets an invalid
key surface as a `23503` foreign-key violation, caught in that route's own catch block and turned
into the same Arabic error message the old `.includes()` check used to return, keyed off
`err.constraint` (`fleet_vehicles_category_fkey` / `fleet_expenses_category_fkey` /
`fleet_maintenance_types_category_fkey`) so it can't accidentally swallow an unrelated 500.

**Found and fixed the same partial-update bug class in `PUT /maintenance-types/:id` while touching
it**: it used to unconditionally `SET category = $2` with `category || null` on every single-field
edit (e.g. just toggling `is_active` from the settings-tab checkbox) — meaning setting a type's
target category, then later just flipping its active checkbox, would have silently wiped the
category back to NULL. Never surfaced because every `fleet_maintenance_types.category` was NULL in
practice (verified on production before touching it) — rewritten as the same dynamic
`'field' in body` partial-update pattern `PUT /vehicles/:id` already uses, so it can't regress now
that admin-set target categories are an actual code path.

**New endpoints**: `GET/POST/PUT /api/fleet/vehicle-categories` and the identically-shaped
`GET/POST/PUT /api/fleet/expense-categories`. `key` is generated server-side (`cat_<8 hex>` /
`exp_<8 hex>` via `crypto.randomBytes`) rather than typed by the admin — it's a machine value with
no reason to ask an Arabic-speaking fleet admin to also invent an ASCII slug; only `name_ar` is a
form field.

**Frontend** ([FleetManagementPage.jsx](customer-balance-app/frontend/src/pages/FleetManagementPage.jsx)):
the two settings-tab cards ("تصنيفات السيارات" / "بنود المصروفات") mirror the existing "أنواع
الصيانة" card's exact layout (inline-editable name + active checkbox per row, add-row form below).
`CATEGORY_OPTIONS`/`EXPENSE_CATEGORY_OPTIONS` are no longer module-level constants — each of the two
components that needs them (`FleetManagementPage` and `VehicleProfile`, which fetch independently,
same as they already do for `fleet-reps`/`fleet-regions`) builds them from its own
`useQuery(['fleet-vehicle-categories'/'fleet-expense-categories'], ...)`, sharing React Query's
cache. Two helpers replace the flat `.map()` the old constants allowed: `toOptions()` (the full
list, active+inactive — used for filter dropdowns and every `labelOf()` lookup, since a
deactivated category must stay findable/label-able for whatever already used it) and
`pickableOptions(categories, currentKey)` (active-only, but a record's OWN current value stays
selectable even if deactivated afterward, e.g. editing an old vehicle never blanks its category
select) — used everywhere a NEW value is being chosen: add-vehicle, the inline per-row
classification dropdown, add-maintenance-type's target category, edit-vehicle, and add-expense.

Verified live end-to-end via signed-JWT probes (test rows created then deleted): added a new
vehicle category, applied it to a real vehicle and confirmed it persisted, deactivated it,
confirmed an invalid key on both vehicles and expenses now returns the friendly 400 (not a 500),
added a new expense category and logged a real expense against it — all cleaned up afterward, DB
back to the original 6+6 seeded rows.

## Fleet reports tab (التقارير) — date range + region(s) + category(ies), KPIs, maintenance, expenses

New "التقارير" tab on `FleetManagementPage.jsx`, independent of the overview/vehicles tabs which only
ever show *current* state — this one is filterable by an arbitrary `date_from`/`date_to` plus
multi-select region(s) and vehicle category(ies), same three-state filter convention as the
current-stock/coverage pages (`null` = الكل, a `Set` = a chosen subset, an *explicitly empty* `Set`
= "لا شيء" — short-circuited entirely client-side with a "اختر واحدًا على الأقل" hint rather than
being sent to the API, where an absent param would just mean "all"). Three new endpoints under
`GET /api/fleet/reports/*`, all requiring `date_from`/`date_to` and accepting repeatable
`region_id`/`category` query params (Express folds repeats into an array — same convention as
`/region-performance/period-compare`'s `branch` and `/coverage/visits-range`'s `branch`):

- **`/reports/summary`** — مؤشرات الأداء: vehicle count in scope, maintenance cost/count (from the
  log, date-ranged), expense total/count (date-ranged), combined total cost, **km driven** (real
  odometer-reading deltas — `MAX(reading_km) - MIN(reading_km)` per vehicle among vehicles with 2+
  readings *inside* the window; a vehicle with only one reading in the period contributes nothing,
  never a phantom 0, since there's no measurable delta), **cost per km** and **avg cost per
  vehicle** derived from those, plus overdue/due-soon counts (current odometer state — see below).
- **`/reports/maintenance`** — two lists: "الصيانات المنفذة" (`fleet_maintenance_log`, genuinely
  date-ranged) and "الصيانات القادمة/المستحقة" (reuses the dashboard's own due/overdue rule —
  `current_odometer_km - last_service_km >= interval_km * 0.9` — with the region/category scope
  applied). The "قادمة" list is deliberately **not** date-ranged: due-ness in this system is
  odometer-based, not calendar-based, and there is no service-interval-by-time concept to project a
  due *date* from — so it always reflects the live current state, exactly like the overview
  dashboard's own alert list, just scoped down by the report's filters.
- **`/reports/expenses`** — row-level log (date-ranged) plus three aggregates: by expense category,
  by vehicle (top 20 spenders), by month (trend).

Every query joins through `LEFT JOIN sales_reps sr ON sr.id = v.assigned_rep_id` and filters on the
EFFECTIVE region `COALESCE(sr.region_id, v.region_id)` — same live-derived-region rule as every
other fleet query — via a small shared helper, `buildScopeSql(paramsArr, regionIds, categories)`,
which appends its `AND ...` fragment and bind values onto whatever params array the caller already
has (so it works whether the scope filter needs to be `$1`/`$2` or comes after date bounds already
in that array).

**Frontend**: `FleetReportsTab` (own component, receives `regions`/`vehicleCategories` as props from
the already-fetched lists) + a small reusable `MultiSelectDropdown` (checkbox panel, not chips — this
page's other filters are all dropdowns). Excel export (`xlsx`, first use of that library on this
page) for both the maintenance report (two sheets: منفذة / قادمة) and the expenses report.

Verified live: correct 400 on missing/invalid date range; a wide all-time query against the
(previously empty) `fleet_maintenance_log`/`fleet_expenses` tables returned all-zero KPIs as
expected; then a real maintenance entry + expense were logged against a real vehicle (forced to a
known category for the test), confirmed to appear in all three endpoints with exact matching
values, confirmed **excluded** when filtering by a different category, and confirmed the
by-category/by-vehicle/by-month aggregates summed correctly — all test data (and the temporarily
forced category, and the maintenance schedule's `last_service_km` the test service entry rolled
forward) fully reverted afterward, confirmed back to the exact pre-test state (0 rows in both
tables company-wide).

## Fleet bulk Excel import/export (نموذج السيارات + قراءات العداد)

"⬇️ تنزيل نموذج Excel" / "⬆️ رفع ملف Excel" on the vehicles tab toolbar in `FleetManagementPage.jsx`
— a two-sheet workbook ("السيارات" / "قراءات العداد") covering every field `POST /vehicles` and
`POST /vehicles/:id/odometer` accept, so an admin can bulk-add new vehicles, bulk-edit existing
ones, and bulk-log odometer readings in one file instead of one-at-a-time forms.

- **Export**: `GET /api/fleet/import/template-data` returns every vehicle's current data — a FRESH
  full snapshot, deliberately not the on-screen (possibly filtered) `vehicles` list — which the
  frontend turns into the two pre-filled sheets client-side with `xlsx` (Arabic column headers and
  Arabic labels for category/assignment/status, not raw keys, so it reads and re-uploads naturally).
- **Import**: `POST /api/fleet/import` (multer memory storage, `xlsx` parse, same pattern as
  `sales-reps/targets/upload`). Vehicles are matched to existing rows by normalized `plate_number`;
  a match **fully overwrites** every column from the sheet (not a partial update like
  `PUT /vehicles/:id`) — a spreadsheet cell has no way to represent "untouched", and since the
  template was pre-filled with the current value, an untouched cell already reproduces the current
  value, so full overwrite achieves "only what you changed actually changes" through pre-fill
  instead of presence-checking. No match → creates the vehicle (seeding its maintenance schedule,
  same as `POST /vehicles`). Everything commits in one transaction; a mid-file error rolls back the
  whole import rather than leaving it half-applied. `status` is the one column kept as
  `COALESCE($new, existing)` rather than overwritten — it's `NOT NULL` with a fixed `CHECK` list, so
  a blank/unrecognized cell must not accidentally reset it. Unrecognized category/assignment/region/
  rep-name values don't fail the row — they fall back sensibly (no category, "غير مخصصة", no
  region/rep) and are surfaced in a per-row `errors` array the frontend renders under the result
  banner, so a typo doesn't silently drop or half-apply a row.
- **Odometer-reading rows regress-guard interacts with brand-new vehicles**: a genuinely new
  vehicle whose row ALSO carries an odometer-sheet reading in the *same file* must NOT be inserted
  with `odometer_updated_at = TODAY` from its own "العداد الحالي" cell — that would out-date the
  (often real, past-dated) odometer-sheet reading, and the odometer endpoint's own regression guard
  (`WHERE ... reading_date >= odometer_updated_at`, same rule `POST /vehicles/:id/odometer` already
  enforces) would then refuse to roll `current_odometer_km` forward to it, silently leaving the
  vehicle stuck at the vehicle-sheet's baseline number instead of its real reading. Fixed by parsing
  the odometer sheet BEFORE the vehicle-sheet loop and checking, per new vehicle, whether its plate
  also appears there — if so it's inserted at the column default (`0` / `NULL` updated-at) and the
  odometer-sheet's own INSERT (processed after) establishes the real baseline, since a `NULL`
  `odometer_updated_at` always lets the first reading through regardless of date. Caught and fixed
  via a live probe before this was ever exposed — see verification note below.

Verified live end-to-end (all test data created, asserted, then fully deleted afterward — confirmed
back to 0 leftover rows): a brand-new vehicle + same-file historical odometer reading (initially
failed with the bug above — current_odometer_km stuck at the vehicle-sheet's 100 instead of the
odometer-sheet's real 500 — fixed, redeployed, reverified: correctly landed at 500); a full-column
UPDATE on an existing plate (category/make/model/status all changed, exactly one row, no duplicate
created); a newer odometer reading on the same vehicle correctly rolling `current_odometer_km`
forward again; a backdated/lower reading correctly refused for the *current* figure while still
being inserted as a history row (same guard as the single-entry endpoint); and unrecognized
category/plate values correctly reported in the row-level `errors` arrays instead of silently
failing.

## Discount Shops — صافي المبيعات الشهري tab (month-by-month qty + value, same customer set as the incentive scenario)

New tab on `DiscountShopsPage.jsx` alongside "سيناريو حافز % من المبيعات" — same customer list/filters
(reads `incentiveBaseline` directly, not `incentiveScenario`, since this tab has nothing to do with
growth%/tiers), broken down month by month instead of one total for the whole period.

Backend: `GET /discount-shops/incentive-baseline` gained a third parallel query alongside the
existing per-customer aggregate and overall totals — same `whereSql` (identical filters/scope), just
not collapsed past `(customer_code, report_year, month_num)`. Response now carries a top-level
`months` array (every distinct year/month present across ALL customers in the filtered period, so
every customer's row has the same column set even if they had zero sales in some of them) and each
customer object gains `by_month: { "<year>-<month>": { qty, revenue } }` (a month absent = zero, not
present at all — `"—"` on the frontend). Sharing one query shape with the existing aggregate query
guarantees a customer's month cells always foot exactly to that same customer's `total_qty`/
`total_revenue` already shown on the incentive tab — verified live: summed a sample customer's 9
months of `by_month` and confirmed it matches `total_qty`/`total_revenue` exactly (0 diff).

Frontend: `.ds-table--monthly` pins the customer-identity column (name + code) to the right (RTL)
while month columns scroll — same `position: sticky` pattern as the pinned columns on
`SalesActivityPage.css`'s "تقرير الحضور الشهري" table, scoped so it doesn't touch any other
`.ds-table` on this page. Each month cell shows qty (bold) over revenue (muted, smaller) — a `—` when
that customer had no sales that month. Excel export mirrors the on-screen matrix (one column pair —
كمية/قيمة — per month, plus totals).

## Bug: التحصيل اليوم لايف counted "Customer Refund" rows as collected money

The user compared the live dashboard total (163,975) against NetSuite's own report directly and got
a real ~10,226 SAR gap. Investigated by fetching the exact same NetSuite Web Query URL
(`COLLECTIONS_LIVE_URL`, `cr=516`) directly and inspecting the raw rows: the report's `Type` column
carries both `"Payment"` (money IN) and `"Customer Refund"` (money OUT, back to the customer) —
**and NetSuite renders both with a positive `"Amount Charged"` value, there is no sign to key off.**
`fetchLiveCollections` in [collections.js](customer-balance-app/backend/src/routes/collections.js)
summed every row's absolute amount regardless of `Type`, so a refund was silently ADDED to "today's
collections" instead of subtracted — confirmed live: that day had exactly 8 refund rows summing to
10,225.95, matching the user's reported gap almost to the SAR (163,975 − 153,749 ≈ 10,226).

Fixed: `Type` is now read into each row, `is_refund = /refund/i.test(type)`, and a refund's amount
is stored NEGATIVE (`-magnitude`) instead of positive — so summing every row nets payments against
refunds automatically, with no separate exclusion logic needed anywhere downstream (`groupLiveRows`
on the frontend already just does `+= r.amount` per region/rep, so negative refund rows correctly
pull the region/rep subtotals down too, not just the grand total). The frontend also flags a refund
row visually (red "↩ مرتجع" badge + red amount) rather than showing an unexplained negative number,
plus a one-line note under the live toolbar stating the total is net of refunds.

Verified live end-to-end: re-fetched `/api/collections/live-today` after deploy — `total` (146,598.31)
now equals `payments_sum + refunds_sum` exactly (156,824.26 + (−10,225.95)), and all 8 refund rows
came back with the expected negative amounts matching the pre-fix investigation exactly.

## Fleet spare-parts catalog (قطع غيار) — optional tag on maintenance/expense entries (`109_fleet_spare_parts.sql`)

The user uploaded an Excel with a "بنود المصروفات" list — **but it turned out to be ~250 individual
spare-part names** (سير مكينة، فلتر هواء، مساعد أمامي يمين…), not general expense-category buckets
like the existing 6-row "بنود المصروفات" settings screen (وقود/إصلاح/إطارات/تأمين/رخصة/أخرى). Dumping
250 rows into that screen would have broken it — it's a plain `<select>` meant for a short list.
**Clarified with the user before building anything**: these are a genuinely different catalog
(قطع غيار), used as an OPTIONAL multi-select tag when logging a maintenance service or an expense —
not a replacement for, or addition to, the expense-category list.

- **`fleet_spare_parts`** (id, name_ar UNIQUE, is_active, sort_order) — seeded with 249 rows (250 in
  the source file minus 4 exact-duplicate names), in the SAME order as the user's file, since it's
  already grouped by mechanical system (engine → clutch → differential → driveshaft → brakes →
  suspension → steering → electrical → AC → tires/wheels → body → general checks → the refrigeration-
  unit section for reefer trucks) — preserving that order via `sort_order` keeps related parts
  adjacent instead of scrambling them alphabetically.
- **`fleet_expenses.part_ids`/`fleet_maintenance_log.part_ids`** — nullable `INTEGER[]`, no array-wide
  FK (Postgres can't constrain individual array elements), so `validPartIds()` in `fleet.js` filters
  every incoming id against `fleet_spare_parts` before a write — an unknown/stale id is silently
  dropped rather than trusted or erroring the whole request (verified live: posting `[real, real,
  999999]` saved only the two real ids).
- **Settings CRUD**: `GET/POST/PUT /api/fleet/spare-parts`, same add/rename/deactivate shape as the
  vehicle-category and expense-category catalogs, but with its own search box in the settings list
  (250 rows needs one even just to find a row to edit) and a scroll-capped table
  (`.flt-table-wrap--scroll`) so the settings tab doesn't become one giant page.
- **`SparePartsPicker`** (`FleetManagementPage.jsx`) — the actual tagging UI on both the "تسجيل صيانة
  منفَّذة" and "تسجيل مصروف" quick-entry forms. Deliberately NOT a `MultiSelectDropdown` like the
  reports-tab filters (those default to "الكل"/all): a part tag is optional metadata with no
  meaningful "all" state, so it starts empty and only shows a dropdown of matches once the admin
  types — nothing rendered for 249 options up front.
- Selected part ids are resolved back to display names server-side (`resolvePartNames`, using the
  same `loadSpareParts()` catalog) inside `GET /vehicles/:id`'s `maintenance_log`/`expenses` arrays
  (`part_names: string[]`), so the frontend never re-implements that id→name lookup itself — same
  "resolve on the server, not the client" convention as `category_labels` elsewhere in this file.

Verified live end-to-end (real vehicle, cleaned up after): logged a maintenance entry with
`part_ids: [real, real, 999999]` and an expense with `part_ids: [real]`, confirmed
`GET /vehicles/:id` returned the correct `part_names` for both, confirmed the invalid id was dropped
silently, then deleted both test rows and reset the touched `fleet_maintenance_schedule` row back to
its pre-test state.

## Fleet spare-parts INVENTORY (مخزون قطع الغيار) — supply orders + stock deduction (`110_fleet_parts_inventory.sql`)

Turns the flat spare-parts catalog from the turn before this one into a real stock-tracked store, per
the user's explicit ask: register receiving orders ("أمر توريد أرصدة مخزون" — part, quantity, unit
cost) that add to stock, and consuming a part during a logged maintenance service deducts from that
same stock, linked to the vehicle by the log row's own `vehicle_id` (no separate link needed — a
maintenance-log row was already tied to one plate).

- **`fleet_spare_parts.qty_on_hand`** — a cached running balance, same "denormalized current figure +
  a history table backing it" pattern as `fleet_vehicles.current_odometer_km`/
  `fleet_odometer_readings`. **Can go negative** — a part consumed before its receiving order was
  ever logged, or bookkeeping catching up after the fact — and the API never blocks a write over it,
  only warns; refusing to record a real repair because inventory bookkeeping is imperfect would be
  worse than an honest negative number (verified live: consuming 999 units against a balance of 7
  succeeded and returned a `warnings: [...]` array rather than a 4xx).
- **`fleet_part_supplies`** — the receiving-order ledger. `POST /api/fleet/spare-parts/:id/supply`
  (quantity, unit_cost, supply_date, notes) inserts a row AND increments `qty_on_hand` in one
  transaction; `total_cost` is a generated column (`quantity * unit_cost`), never computed twice.
  `GET .../supplies` lists the history per part.
- **`fleet_maintenance_log.parts_used`** REPLACES the `part_ids` (bare id array, no quantity) shipped
  one turn earlier — quantity is required for stock deduction, and a bare id list can't carry it. No
  real usage existed yet (only synthetic test rows, already cleaned up each time), so this was a
  clean swap, not a migrated column: `DROP COLUMN part_ids` + `ADD COLUMN parts_used JSONB
  [{part_id, qty}]`. `validPartsUsed()` sanitizes the client payload (drops unknown ids and
  non-positive quantities, collapses a part listed twice into one summed row) before either the
  insert or the stock deduction touches it. **`fleet_expenses.part_ids` is UNCHANGED** — general
  expenses were never in scope for stock tracking, only the maintenance flow was, so that one stays a
  plain non-quantity tag exactly as before.
- **Frontend**: `MaintenancePartsPicker` (stock-aware sibling of the plain `SparePartsPicker`, which
  keeps serving the expense form as-is) shows each search match's current balance
  (`المتاح: N`, in red once ≤0) and gives every selected chip its own qty input — `SparePartsPicker`
  has no such field since a plain tag never needed one. The "قطع الغيار" settings table gained a
  "الرصيد الحالي" column and a per-row "📦 توريد" button opening an inline supply-order form.

Verified live end-to-end (real vehicle + real part, fully cleaned up after): recorded a supply order
(10 units × 25 SAR) and confirmed `qty_on_hand` and the ledger's `total_cost` (250) were both exactly
right; logged a maintenance service consuming `[{part_id: real, qty: 3}, {part_id: 999999, qty: 5}]`
and confirmed stock dropped by exactly 3 (the invalid id silently dropped, not treated as a 5-unit
deduction) and that `GET /vehicles/:id` resolved `parts_used` back to the correct name+qty; then
over-consumed against the remaining balance and confirmed a `warnings` array came back instead of a
rejected write. All test rows deleted afterward and the part's `qty_on_hand` reset to its original 0.

## Fleet spare-parts stock extended to the EXPENSE flow too (`111_fleet_expense_parts_stock.sql`)

Extends the maintenance-only inventory deduction from the turn before this one to "تسجيل مصروف" as
well, per the user's follow-up ask — but with a choice per part the maintenance flow doesn't have:
each selected part on an expense is either pulled from tracked inventory (quantity + auto-priced
cost, stock deducted) or bought ad hoc for this one expense (quantity + hand-typed cost, stock
untouched). `fleet_expenses.parts_used` (jsonb `[{part_id, qty, unit_cost, deduct_stock}]`) replaces
`part_ids` (the bare-tag column from two turns earlier — again no real usage to migrate, a clean
`DROP`+`ADD`, same as `fleet_maintenance_log.parts_used` before it).

**The security-relevant piece**: `validExpensePartsUsed()` in `fleet.js` NEVER trusts the client's
`unit_cost` for a `deduct_stock: true` row — it's always overwritten server-side with that part's
current last-supply price (`fleet_part_supplies`, most recent row), so an already-open form showing
a stale price (or a tampered request) can't record a wrong cost against inventory. A
`deduct_stock: false` row keeps the client's own hand-typed cost (clamped `>= 0`) since there's
nothing to look up — it was never inventory's concern. Verified live: submitted a stock-deducted
part with a deliberately wrong client-side cost (9999) alongside a real inventory price of 15 —
confirmed the saved/returned row shows 15, not 9999, while a same-request manual (`deduct_stock:
false`) part's genuine hand-entered cost (30) passed through unchanged.

**Frontend**: `ExpensePartsPicker` (replaces the earlier plain-tag `SparePartsPicker`, now fully
retired — both logging forms have their own purpose-built picker) renders each selected part as a
small row (qty input, "من المستودع" checkbox, and either a read-only auto-priced cost label or an
editable cost input depending on the toggle) rather than a simple chip, since it carries materially
more state than `MaintenancePartsPicker`'s chips do. The toggle is disabled (forced to manual) when
a part has no supply history at all — there is nothing to auto-price it FROM.

Verified live end-to-end (real vehicle + two real parts, fully cleaned up after): recorded a supply
order (20 units × 15 SAR), then logged one expense selecting BOTH a stock-deducted part (qty 4) and a
manual part (qty 2, hand cost 30) plus an invalid part id in the same request — confirmed stock
dropped by exactly 4 (not 6, and the manual part's stock stayed untouched at 0), confirmed the saved
row's costs matched the two different rules above exactly, and confirmed the invalid id never made it
into the saved `parts_used` array. All test rows deleted and both parts' `qty_on_hand` reset to 0
afterward.

### Bug: ExpensePartsPicker's search results never appeared

The user reported the "قطع الغيار المستخدمة" search on "تسجيل مصروف" showed nothing while typing —
API-level testing the turn before had already confirmed the 249-part catalog and search filtering
logic both worked, so the bug had to be presentation-only. Root cause: `.flt-eparts-picker` (the new
wrapper class this picker needed, since it holds much more per-row state than the plain-chip pickers)
was never given `position: relative`, while `.flt-parts-panel` — the results dropdown — is
`position: absolute`. Without a positioned ancestor at that level, the panel anchored to whichever
ancestor further up happened to be positioned (or the page itself), so it rendered somewhere off in
the wrong place instead of under the search box — invisible in practice, not merely empty.
`MaintenancePartsPicker`'s equivalent container (`.flt-parts-picker`, reused from the original
tag-only picker) already had `position: relative` from before, which is why THAT picker's dropdown
never had this problem — only the newer `ExpensePartsPicker` wrapper was missing it.

Caught by reproducing the exact CSS in a standalone before/after mockup and comparing screenshots
side by side (not by guessing) — the "buggy" version rendered no visible panel at all under the
input, the "fixed" version (`.flt-eparts-picker { position: relative; ... }`) showed it correctly
right below the search box. One-line CSS fix, deployed and confirmed via PM2 restart stability.

## Fleet supply-order delete — undoes its stock effect, distinct from "تصفير"

`DELETE /api/fleet/part-supplies/:id` removes ONE supply-order row from `fleet_part_supplies`
entirely (e.g. a mistaken/test entry with the wrong quantity or price) — requested after the user
spotted a test/wrong 100-unit entry sitting in the new "آخر عمليات التوريد" feed with no way to
remove it. Distinct from تصفير (which blindly zeroes `qty_on_hand` and leaves the supply ledger
untouched): deleting a supply row must **reverse its own contribution** to `qty_on_hand` (subtract
exactly the quantity it once added) or the cached balance would permanently over-count relative to
the ledger backing it — same "undo the row's stock effect before removing it" rule already used for
expense edit/delete. `FOR UPDATE` locks the row for the transaction so a concurrent delete/edit on
the same supply can't double-reverse it. Gated at the page's normal edit level, NOT admin-only —
this corrects one specific mistaken entry, unlike تصفير's blunt whole-balance wipe. Frontend: a 🗑️
button per row in "آخر عمليات التوريد", confirming the exact part/quantity/price/date before deleting,
then invalidating both the supplies feed and the spare-parts list (so the KPI cards and balance
column update immediately).

Verified live with a dedicated throwaway part (created, supplied 30 units, deleted the supply row,
confirmed balance correctly reversed to exactly 0, confirmed the row vanished from the combined feed,
confirmed a second delete attempt correctly 404s) — then the throwaway part itself deleted afterward.
No real catalog data touched this time.

## Fleet "أرصدة قطع الغيار" — its own tab, with a proper جرد (inventory) view

Two asks: (1) lay out "تصنيفات السيارات"/"بنود المصروفات" side by side in narrower cards instead of
full-width stacked ones, and (2) move "قطع الغيار" out of the settings tab entirely into its own
top-level tab with a real inventory system, not just the bare catalog table.

- **Layout**: `.flt-settings-grid` (2-column `grid`, single column under 800px) wraps just those two
  cards — the "أنواع الصيانة" card above them and the (now-moved) قطع الغيار card are unaffected.
- **New tab** (`parts_inventory`, "أرصدة قطع الغيار"), inserted between "التقارير" and "إعدادات
  الصيانة": the exact same قطع الغيار table/search/توريد/تصفير UI that used to live in settings,
  unchanged in behavior, PLUS:
  - A KPI row (عدد الأصناف، أصناف نشطة، أصناف بدون رصيد، أصناف برصيد سالب، إجمالي الكميات، القيمة
    التقديرية للمخزون) computed client-side from the already-fetched `spareParts` list — no new
    endpoint needed, since `qty_on_hand`/`last_unit_cost` were already on every row.
  - Two new columns on the table itself: "آخر سعر توريد" and "قيمة الرصيد" (= `max(0, qty_on_hand) ×
    last_unit_cost` — a negative balance contributes nothing to the value figure rather than a
    misleading negative "value").
  - `GET /api/fleet/part-supplies` — a NEW combined supply-history feed across every part (the
    existing `/spare-parts/:id/supplies` is per-part only), rendered as "📜 آخر عمليات التوريد" —
    the actual "نظام جرد" audit trail the user asked for, so reviewing the whole store's recent
    movements doesn't mean opening 249 separate per-part histories one at a time.

Verified live: the combined feed correctly resolved `part_name` for the real "سير مكينة" supply row
already in the system, and `GET /spare-parts` still returns all 249 parts with the fields the new UI
needs. **No test data was created for this turn** — the KPI/value columns are pure client-side
derivations of data already verified correct in earlier turns, and the one new endpoint was
read-only, so there was nothing to write and clean up.

## Fleet category delete — "تصنيفات السيارات" / "بنود المصروفات", with FK-blocked fallback

Requested after the user's screenshot of the two side-by-side settings cards, each row previously
only offering a name field + active checkbox: "اضف اوبشن حذف" — add a delete option to both category
tables. Relaxes the settings tabs' long-standing "deactivate, don't delete" convention (`is_active`
toggle) by adding hard DELETE *alongside* deactivation, not replacing it — deactivation stays the
right move when a category is still in use; delete is for a category that was never really needed
(a typo'd entry, a duplicate, one added by mistake and never assigned to anything).

- `DELETE /api/fleet/vehicle-categories/:key` and `DELETE /api/fleet/expense-categories/:key` — both
  gated at the page's normal edit level (`requirePagePermission('fleet_management', 2)`), **not**
  admin-only: like expense edit/delete and supply-order delete, removing an unused catalog entry is
  routine settings cleanup, not the kind of blunt whole-balance wipe `ADMIN_ROLES` is reserved for.
- Both tables carry real FK constraints from `108_fleet_category_settings.sql`
  (`fleet_vehicles_category_fkey`, `fleet_maintenance_types_category_fkey` →
  `fleet_vehicle_categories(key)`; `fleet_expenses_category_fkey` → `fleet_expense_categories(key)`),
  so a plain `DELETE` on a category still referenced by a real vehicle/maintenance-type/expense would
  otherwise surface as a raw Postgres `23503` error. Both routes catch that code specifically and
  return a clear Arabic 409 instead ("...لا يمكن حذفه. يمكنك إلغاء تفعيله بدلاً من ذلك."), steering the
  user toward deactivation rather than leaving a confusing failure.
- Frontend: each row in both "تصنيفات السيارات" and "بنود المصروفات" gained a "🗑️ حذف" button (new
  third `<th>`/`<td>`, empty-state `colSpan` bumped 2→3), behind a `window.confirm` naming the
  category, calling `handleDeleteVehicleCategory`/`handleDeleteExpenseCategory`, which on success
  refetches the category list and `refreshAll()`s, and on failure surfaces the server's Arabic message
  (generic or the FK-blocked one) via `window.alert`.

Verified live on production via a signed-JWT Node probe run over SSH (a super_admin token, since
`requirePagePermission` bypasses the DB check for `super_admin`/`it_admin`) covering all four paths
end to end, using only dedicated throwaway categories/vehicle/expense created through the real POST
endpoints — the real catalog entries from the user's screenshot (سيارة 3 طن/5 طن/10 طن, تريلا, هينو,
سيارة صغيرة / وقود, إصلاح, إطارات, تأمين, رخصة, أخرى, مخالفات مرورية) were never touched:
1. Create an unused throwaway vehicle category → delete it → **200 ok**.
2. Create another throwaway vehicle category, attach a throwaway test vehicle to it, attempt delete →
   **409**, correct Arabic "in use, deactivate instead" message.
3. Create an unused throwaway expense category → delete it → **200 ok**.
4. Create another throwaway expense category, log a throwaway expense against it, attempt delete →
   **409**, correct Arabic message.

Cleanup ran in the same script (delete the throwaway expense → throwaway vehicle → all four throwaway
category rows) and was confirmed complete afterward with a separate read-only query: zero leftover
`TEST-DELETE%`/`TEST-DEL-%` rows anywhere, and both category tables back to exactly their pre-test
real contents (6 vehicle categories, 7 expense categories, all `is_active: true`). PM2 (`taryah-backend`)
sampled twice ~15s apart post-deploy with identical `pid`/`restart_time` — stable, no crash loop.

## Fleet-only regions (`regions.fleet_only`) — "مستودع شقراء" without polluting the sales region list

Asked from a screenshot of the vehicle list's "المنطقة" filter dropdown: "اضف للقائمة مستودع شقراء"
(add "Shaqraa Warehouse" to the list). That dropdown is populated by `GET /api/fleet/regions`, which
reads the app-wide shared `regions` table — the SAME table used for sales-rep region assignment,
quality-returns/issues filters, collections, sales-tasks, the summary report, and region-performance
reports (`grep`'d ~25 call sites across the backend). Naively inserting a new row would have made
"مستودع شقراء" selectable as a real sales region everywhere — appearing as an assignable region on the
Users/rep-management screen, and as a phantom always-zero row in every region-scoped report. Asked the
user to confirm the intent before touching a table that shared; they confirmed: **fleet-only** — this
warehouse should exist for classifying fleet vehicles and nowhere else.

`112_fleet_only_regions.sql`:
- `ALTER TABLE regions ADD COLUMN fleet_only BOOLEAN NOT NULL DEFAULT false` — keeps the existing
  `fleet_vehicles.region_id → regions(id)` FK and the effective-region `COALESCE(sr.region_id,
  v.region_id)` join in `fleet.js` completely unchanged (both still point at the one shared table, so
  a rep-linked and a non-rep vehicle's region still resolve through the exact same id-space) —
  cheaper and lower-risk than a second, parallel "fleet regions" table that would need to be kept in
  sync by hand.
- Inserts one row: `('مستودع شقراء', 'مستودع شقراء', fleet_only = true)`.
- `GET /api/fleet/regions` and the fleet vehicle-Excel bulk-importer (both in `fleet.js`) are left
  untouched — they intentionally keep seeing the FULL list, fleet_only rows included, since those two
  are fleet's own pickers.
- Every OTHER **human-facing region picker** across the app got `AND fleet_only = false` (or
  `WHERE fleet_only = false` where there was no existing WHERE) added to its query: `GET
  /api/users/regions` (the general region picker — critically, this is also what backs assigning a
  region to a user/rep, so a fleet warehouse must never be offered there), `GET
  /api/quality-returns/my-regions`, `GET /api/quality-returns/filters`, the collections report's
  region lookup, `GET /api/sales-tasks/regions`, the summary report's region filter list, and all
  three region-list sites in `regionPerformance.js` (including the branch-name union that seeds the
  region-performance page's filter). Left deliberately unchanged: the several `WHERE id = ANY($1)`
  sites that only resolve display names for region ids a record *already* carries (harmless — nothing
  will ever assign a fleet_only id to those records since it's no longer offered as an option), and
  the free-text NAME-matching caches used by Excel/NetSuite import (`qualityIssues.js`, `upload.js`,
  `fridges.js`) — real uploaded data will never contain the literal string "مستودع شقراء", so leaving
  those unfiltered is inert.

Verified live end-to-end on production with a signed super_admin JWT probe (no test data to write or
clean up — this only reads):
- DB: the new row exists, `fleet_only = true`.
- `GET /api/fleet/regions` → **11** regions (10 real + the warehouse), includes "مستودع شقراء". ✅
- `GET /api/users/regions` → back to **10**, does **not** include it. ✅
- `GET /api/quality-returns/my-regions`, `GET /api/quality-returns/filters`, `GET
  /api/sales-tasks/regions` → none include it. ✅

The frontend needed **zero changes** — `FleetManagementPage.jsx`'s region filter/select already reads
from `GET /fleet/regions` (`queryKey` already wired up from an earlier turn), so the new warehouse
appears there automatically once the migration ran. PM2 (`taryah-backend`) sampled twice ~15s apart
post-deploy with identical `pid`/`restart_time` (114→115, matching exactly the one restart from this
deploy) — stable, no crash loop.

## Fleet vehicle status "light" — colored glowing dot per status

Requested from a screenshot of the vehicle list: make "نشط" (active) glow green, "متوقف" (inactive)
glow red, and give every other status its own distinct color, instead of the plain text label the
"الحالة" column showed before. Pure frontend/CSS — no backend or migration involved.

- New `StatusLight` component (`FleetManagementPage.jsx`, next to `labelOf`): renders a small
  `<span class="flt-status flt-status--{status}"><span class="flt-status__dot"/>{label}</span>` for
  each of the 4 known `STATUS_OPTIONS` values, falling back to the plain label for anything
  unrecognized (defensive — should never actually happen).
- CSS (`FleetManagementPage.css`, next to the existing `.flt-badge--*` rules): each status gets its
  own dot color + a soft `box-shadow` glow (spread ring + blur) so it reads as "lit up", not just a
  flat colored circle — `active`=green `#22c55e`, `inactive`=red `#ef4444`, `in_maintenance`=amber
  `#f59e0b` (distinct from the danger/warn amber already used for maintenance-overdue badges, but same
  hue family on purpose — both mean "needs attention"), `sold`=slate `#64748b` (a vehicle that's gone,
  deliberately the most muted of the four).
- Applied at both places the vehicle's own status is *displayed* (not the edit `<select>`, which stays
  a plain dropdown): the vehicles list table's "الحالة" column, and the vehicle detail panel's summary
  line. Left untouched: the maintenance-report table's unrelated "الحالة" column (that one shows
  متأخرة/قريبة الاستحقاق alert levels, a different concept, already using its own `flt-badge--danger`/
  `--warn` styling).

Verified: build succeeded clean, PM2 stable post-deploy (115→116, one restart, matching the deploy).
Also rendered a standalone HTML mockup with the exact same CSS classes and sent it to the user directly
to eyeball the four colors before considering this closed, since a production login wasn't available
to screenshot the live page in this turn.

## Spare-parts inventory Excel export (`handleExportSpareParts`)

Requested from a screenshot of the "أرصدة قطع الغيار" tab's قطع الغيار table: "اضف تصدير تقرير اكسيل
للأرصدة الموجودة". Pure client-side export, same `XLSX.utils.aoa_to_sheet` + `XLSX.writeFile` pattern
already used by `handleExportMaintenance`/`handleExportExpenses` — no new backend endpoint, since
`spareParts` is already fully loaded client-side for this tab.

- Exports **exactly what's on screen** — built from `filteredSettingsParts` (the same array the table
  itself renders), so if the user has typed into "بحث عن قطعة…" first, the export respects that
  filter rather than always dumping all 249 parts.
- Columns match the table 1:1: الاسم، نشط (`نعم`/`لا` instead of a checkbox, so the sheet reads
  correctly opened standalone outside the app), الرصيد الحالي، آخر سعر توريد، قيمة الرصيد (both `—`
  when a part has never been supplied, same as the on-screen table).
- Button ("⬇️ تصدير Excel", `flt-btn--sm`, disabled when the filtered list is empty) placed in the
  card's title row next to the search box — grouped together in their own flex wrapper (not simple
  `space-between` on 3 direct children) so the row wraps cleanly on narrow screens instead of spacing
  title/search/button apart oddly.
- Filename stamped with today's date: `أرصدة_قطع_الغيار_YYYY-MM-DD.xlsx`.

Verified: build succeeded clean, PM2 stable post-deploy (116→117, one restart, matching the deploy).
No backend change, so no migration/API to probe — the export runs entirely from data already fetched
and already displayed on the page.

## Fleet maintenance baseline reset — "5 تنبيهات" on nearly every vehicle was a false alarm

From a screenshot of the vehicle list where almost every row showed "5" under "تنبيهات صيانة" (overdue
count) despite the fleet never actually having any maintenance logged: "اذل حاليا كل تنبيهات الصيانة
واجعل القراءة الحالية المدخلة هي البداية لحساب الصيانة وأعمل تحديث بمجرد حفظ التاريخ والقراءة للصيانة
مستقبلا" — clear the current false alerts, treat each vehicle's current odometer as the starting point
for the maintenance calc, and keep auto-updating going forward whenever a real service is logged.

**Root cause**: `fleet_maintenance_schedule.last_service_km` was hardcoded to `0` at every vehicle's
schedule-row creation — both `POST /vehicles` (single add) and the Excel bulk-importer — regardless of
what odometer reading the vehicle was actually created with. So "km_since_service" (`current_odometer_km
- last_service_km`) was really "every km this vehicle has ever driven since it existed in this system",
which blows past every maintenance type's interval almost immediately for any vehicle imported with
real accumulated mileage (the fleet's actual bulk-import case — hence "5" on nearly every row, one per
active maintenance type).

- **One-time catch-up** (`113_fleet_maintenance_baseline_reset.sql`): `UPDATE fleet_maintenance_schedule
  ms SET last_service_km = v.current_odometer_km FROM fleet_vehicles v WHERE ms.vehicle_id = v.id` —
  runs once (migrations never re-run), touches every existing vehicle regardless of whether it already
  had a partial real service history, per the user's explicit "احالياً" (as of right now, clear
  everything) framing. Deliberately leaves `last_service_date` untouched (stays `NULL` where it already
  was) rather than fabricating a fake "serviced today" date — the reset only concerns the km-based due
  calculation the user asked to fix, not a claim about when service actually happened.
- **Fixed going forward** so the same false-alarm can't recur for the NEXT vehicle added: both
  `POST /vehicles` and the Excel bulk-importer now seed each new schedule row's `last_service_km` at
  that vehicle's own starting `current_odometer_km` (falling back to 0 only when no odometer was given,
  or — bulk-import only — when the vehicle's baseline is deliberately deferred to a same-file odometer
  sheet, unchanged existing behavior there). A vehicle added today with 100,000 km already on the clock
  now starts at 0 overdue, not 5.
- **Already correct, no change needed**: `POST /vehicles/:id/maintenance` already rolled
  `last_service_km`/`last_service_date` forward transactionally on every real completed service — the
  "keep updating automatically going forward" half of the request was already true; this turn only
  fixed the two *creation* paths that seeded the wrong baseline in the first place.

Verified live on production:
- DB-wide: **0** schedule rows now mismatch their vehicle's current odometer, **0** overdue rows
  fleet-wide immediately after the reset. Sampled the exact plates from the user's screenshot (7516,
  7583, 7584, 7730, 7731, 7733, 7801, 7802) — every one now shows `overdue_maintenance_count: 0`
  (previously 5).
- Dedicated throwaway vehicle created via the real API at 100,000 km: all 5 maintenance-type schedule
  rows seeded at exactly 100,000 (not 0), `overdue_maintenance_count: 0` immediately after creation.
  Logged a real completed maintenance at 105,000 km through the normal endpoint → schedule correctly
  rolled forward to `last_service_km: 105000`, `last_service_date` = today. Throwaway vehicle + its
  maintenance log deleted afterward (`fleet_maintenance_schedule` cascades on vehicle delete); confirmed
  zero leftover `TEST-MAINT-%` rows anywhere.
- The Excel bulk-importer's matching fix was reviewed (identical one-line change to the same INSERT
  pattern, using the already-computed `initialOdometer` instead of a literal `0`) but not exercised
  with a live file upload this turn — lower effort-to-confidence ratio than the two paths that were
  actually probed end-to-end.
- PM2 stable post-deploy (117→118, one restart, matching the deploy).

## Fleet vehicle list — frozen filter bar, scrollable table with sticky column headers

From a screenshot of the vehicle list's filter bar + column headers: "اجعل الجزء ده فريز دائما ظاهر
وباقي الجدول بالأسفل متحرك بالاسكرول للاعلى والاسفل" — keep the filter bar (search/filters/buttons)
always visible, and let the table body underneath scroll independently.

- The filter bar already lives in its own `.flt-card`, a sibling **above** the table's card — so it
  was already outside any scrolling region and needed no CSS change to stay "frozen"; the actual gap
  was that the table itself used ordinary page-flow rendering, so a long vehicle list just pushed the
  page taller instead of scrolling in place.
- New `.flt-table-wrap--scroll-tall` (`max-height: 65vh; overflow-y: auto`) applied to the vehicles
  table's wrap — a taller sibling of the existing `.flt-table-wrap--scroll` (`360px`, already used for
  the spare-parts/supply-history tables) added rather than changing that shared class, so those other
  tables' sizing is untouched.
- `thead th { position: sticky; top: 0 }` added for **both** scroll-wrap variants (not just the new
  tall one) — the column headers themselves were also visible in the user's screenshot as part of "الجزء
  ده", and pinning them is the same mechanism either way; this is a free improvement for the
  spare-parts/supply-history tables too, not scoped narrowly to just the vehicles list.
- A vehicle row's expanded detail panel (odometer history, maintenance, expenses — opened by clicking a
  row) still renders inline in the same `<tbody>`, so it scrolls with the body rows as before; only the
  header row and the filter card above it stay pinned.

Verified: build succeeded clean. Rendered a standalone HTML mockup with the exact CSS (sticky-header
table box under a fixed filter card, 40 dummy rows) and sent it to the user to confirm the scroll
behavior looks right before deploying. PM2 stable post-deploy (118→119, one restart, matching the
deploy). Pure CSS/layout — no backend change, no migration, nothing to functionally probe.

## Fleet ↔ Rep Management vehicle sync + "ملاحظات" column on the vehicle list

Two asks from a screenshot of the vehicle list: (1) "عند ربط أي سيارة هنا بمندوب قم مباشرة بربطها
بقاعدة بيانات المناديب بادارة المناديب" — keep Rep Management's own record of a rep's vehicle in sync
whenever the link is made/changed here in Fleet; (2) add a "ملاحظات" column to the table.

**The sync gap**: `sales_reps.vehicle_number` (a free-text plate field) is what Rep Management's own
form edits, and what Quality Returns/its reports read as "this rep's vehicle" (`qualityReturns.js`).
`104_fleet_management.sql` seeded `fleet_vehicles` FROM this field once, at Fleet's creation — but
nothing afterward ever wrote back to it. So assigning/reassigning/unassigning a vehicle to a rep, or
deleting a rep-linked vehicle, entirely in Fleet (the actively-maintained side now) left Rep
Management's own field stale, and the two screens could silently disagree about which plate a rep
drives.

- New shared helper `syncRepVehicleNumber(client, { oldRepId, oldPlate, newRepId, newPlate })`: sets
  `sales_reps.vehicle_number = newPlate` for `newRepId` when present, and clears the OLD rep's
  `vehicle_number` to `NULL` when the rep actually changed — but **only if it still holds exactly what
  this vehicle last set it to**, so it never clobbers a value Rep Management (or anything else) set
  independently for an unrelated reason.
- Wired into all **four** places `fleet_vehicles.assigned_rep_id`/`plate_number` can change: `POST
  /vehicles` (create), `PUT /vehicles/:id` (edit — upgraded from a plain `pool.query` to a real
  transaction with `SELECT … FOR UPDATE` so the old values are read safely and the two tables' writes
  can't commit out of step), `DELETE /vehicles/:id` (admin-only — clears the rep's field since the
  vehicle it pointed at no longer exists), and the Excel bulk-importer's both branches (existing-vehicle
  update and new-vehicle insert — already ran inside its own transaction, just needed the same call
  added plus tracking each existing vehicle's pre-import `assigned_rep_id` to diff against).
- "ملاحظات" column: `GET /vehicles` didn't select `v.notes` at all before (only the vehicle-detail
  panel showed it) — added to the SELECT and rendered as a new truncated/ellipsised `<td>` (full text
  via the native `title` tooltip) between "تنبيهات صيانة" and "إجراءات"; the detail row's `colSpan`
  bumped 10→11 to match the new column count.

Verified live on production with two dedicated throwaway `sales_reps` rows and throwaway vehicles (real
reps/vehicles from the user's own screenshots never touched):
1. Create a vehicle assigned to throwaway rep 1 → rep 1's `vehicle_number` set to that plate. ✅
2. Reassign that same vehicle to throwaway rep 2 → rep 1's `vehicle_number` cleared to `NULL`, rep 2's
   set to the plate. ✅
3. Rename the vehicle's plate while still assigned to rep 2 → rep 2's `vehicle_number` follows the new
   plate. ✅
4. Delete the vehicle → rep 2's `vehicle_number` cleared to `NULL`. ✅
5. A vehicle's `notes` set directly in the DB → correctly returned by `GET /vehicles` and matched what
   the list would render. ✅
(The bulk-Excel-import branches were reviewed — identical calls to the same helper — but not exercised
with a live file upload this turn, same lower-priority tradeoff as the maintenance-baseline fix earlier
in this file.)

All throwaway reps/vehicles deleted afterward; confirmed zero leftover `TEST-SYNC-%` vehicles or
`TEST-REP-SYNC%` reps anywhere. PM2 stable post-deploy (119→120, one restart, matching the deploy).

## Fleet expense edit/delete + quantity spinner step fix

Two independent asks in one turn:

**Quantity spin-step bug**: every "الكمية" number input tied to spare parts (المaintenancePartsPicker's
chip qty, ExpensePartsPicker's row qty, the "أمر توريد" quantity field) had `step="0.01"`, so clicking
the browser's up/down spinner moved by a hundredth of a unit instead of a whole one — screenshot
showed a part's quantity land on "1.04" from spinner clicks. Fixed to `step="1" min="1"` on all three
(unit-cost/price fields deliberately kept at `step="0.01"` — money legitimately needs cents).

**Expense edit/delete** — `PUT`/`DELETE /api/fleet/expenses/:id`, open to the page's normal edit
level (NOT admin-only — unlike vehicle delete/stock reset, correcting a logged expense is routine
fleet coordination, not destructive in that same sense). The part that actually matters here: both
routes must undo whatever stock effect the row's OLD `parts_used` had before applying the new one
(edit) or dropping the row (delete) — `FOR UPDATE` locks the expense row for the transaction so a
concurrent edit/delete can't double-reverse or double-apply. Edit is "reverse old, then apply new" as
two separate loops rather than a diff — simpler and correct even when a part was added, removed, or
had its quantity changed, at the cost of a redundant −N/+N pair on a part left untouched between
edits (negligible). Frontend: an inline edit row (reusing `ExpensePartsPicker`, pre-filled) expands
under the clicked row in "سجل المصاريف", matching the same in-place-edit convention already used for
saved discount-shop contracts.

**Verified live using a DEDICATED throwaway spare part created and fully deleted within the same
probe** (explicitly to avoid repeating the earlier incident where a real catalog part's balance was
temporarily zeroed during testing): supplied it (50 units), created an expense consuming 5 (confirmed
stock → 45), edited that expense to consume 8 instead while also changing category/amount/notes
(confirmed stock correctly reversed-then-reapplied to 42, and all fields updated), then deleted the
expense (confirmed stock returned to exactly 50 — the post-supply baseline — and the row was gone).
Afterward deleted the test part's supply record and the part itself via direct SQL (no `DELETE
/spare-parts` endpoint exists by design — parts are deactivate-only in the UI), confirmed zero
leftover probe rows anywhere.

## Fleet spare-parts "تصفير الرصيد" — admin-only stock reset

`POST /api/fleet/spare-parts/:id/reset-stock` zeroes a part's `qty_on_hand` directly — a manual
correction, not a supply/consumption event, so it's kept OUT of the `fleet_part_supplies` ledger
entirely (that table's `quantity` is `CHECK > 0`, receiving-only by design) rather than recorded as
a fake "supply" or "negative supply". Gated `requireRoles('super_admin', 'it_admin')`, same
`ADMIN_ROLES` convention as vehicle delete — irreversible and silently discards whatever the true
count should have been reconciled to, so it's tighter than the page's normal edit level that
`fleet_supervisor` holds day to day. Frontend mirrors the gate (`isAdmin`, button only rendered for
admins) plus a `window.confirm()` naming the part and its current balance before the call, and
disables the button entirely when the balance is already 0 (nothing to reset). The server also logs
who zeroed which part (`console.log`, not a DB row) for basic traceability without a whole new audit
table for a rarely-used correction action.

**Verification note — a real mistake caught and fixed in the same turn**: the live-probe test for
this feature reused the actual "سير مكينة" part the user's own screenshot showed with a real balance
(~100, from a genuine supply order the user had entered), added 7 test units to it, then reset it to
0 as part of testing the reset endpoint itself — this briefly ZEROED REAL production inventory data,
not synthetic test data. Caught immediately by cross-checking the math (the test's own before/after
numbers didn't reconcile against a clean "test data only" story), and fixed by deleting the test
supply row and restoring `qty_on_hand` to the exact pre-test value (98.96 — derived from the real
100-unit supply row minus 1.04 already consumed by the user's own real usage before the test ever
ran, confirmed by re-fetching the part through the live API afterward). **Lesson**: when a feature
under test operates on a shared, named catalog (as opposed to a vehicle/customer/contract row created
fresh for the test and deleted after), a real row can look indistinguishable from a fixture — always
verify a picked-for-testing row doesn't already carry real user data before mutating it, and if it's
ambiguous, create a dedicated throwaway part instead of reusing an existing catalog entry.

## Fleet vehicle delete — admin-only, tighter than the page's normal edit level

`DELETE /api/fleet/vehicles/:id` was gated by `requirePagePermission('fleet_management', 2)` — the
same "edit" level `fleet_supervisor` holds for its everyday job (add/edit vehicles, log odometer/
maintenance/expenses). Deleting a vehicle is irreversible and cascades its entire history, so it's
now `requireRoles('super_admin', 'it_admin')` instead — same `ADMIN_ROLES` convention as
`settings.js`/`carrefourDamage.js`. Frontend mirrors it (`isAdmin` from `useAuth()`, same list) by
hiding the 🗑️ button for non-admins rather than showing a button that 403s — the API call is still
the real gate, this is just so the UI doesn't offer an action that will fail.

Verified live: `fleet_supervisor` and `accounts` tokens both get 403 and the vehicle survives;
`super_admin` succeeds and the vehicle is actually gone; `fleet_supervisor` can still read the
vehicles list (only DELETE was tightened, nothing else on the page).

### Bug: editing "العداد الحالي (كم)" on the vehicles sheet for an EXISTING vehicle silently did nothing

Reported by the user after using the bulk-import feature above: filled in new odometer values in
the "السيارات" sheet's "العداد الحالي (كم)" column for already-registered vehicles, uploaded, no
error — but the odometer never updated. Root cause: the UPDATE branch of `POST /api/fleet/import`
(existing plate → update) never referenced that column at all — only the INSERT branch (brand-new
vehicle) used it to seed `current_odometer_km`. Silent because the response still said
`vehicles: { updated: 1 }` (every OTHER field on the row genuinely did update), so nothing looked
wrong at a glance.

Fixed: for an existing vehicle, when the "العداد الحالي" cell's value **differs** from what's
already on file, it's now treated as a real new odometer reading dated TODAY (the vehicle sheet has
no date column of its own) — inserts a `fleet_odometer_readings` row and rolls `current_odometer_km`/
`odometer_updated_at` forward through the same guarded UPDATE the single-entry endpoint uses. The
diff-check matters: the exported template pre-fills EVERY vehicle's CURRENT value, so without it,
simply re-uploading the file unchanged would log a redundant reading for all 35+ vehicles on every
import. Skipped entirely when that same file's "قراءات العداد" sheet ALSO has a row for the plate —
that row carries a real date and should be the one governing the update, not an implicit "today"
guess from the vehicle sheet (verified: the odometer-sheet's own historical/regression-guard
behavior still wins in that case, exactly as before this fix).

Verified live: re-uploading an unchanged value creates zero readings; a genuinely changed value
updates `current_odometer_km` and logs exactly one reading dated today (the user's exact reported
scenario); a file carrying both an odometer-sheet row and a different vehicle-sheet cell for the
same plate correctly defers to the odometer sheet's own rules. All test data deleted afterward.

### Bug #2 and #3: the fix above still didn't work on the user's real file — two more real bugs

The user re-tested with their real file (35 real vehicles, "العداد الحالي" set to 10000 for all)
and it *still* silently did nothing. Investigated by reading their actual uploaded `.xlsx` locally
(same machine — `C:\Users\tarya\Downloads\...`) rather than guessing:

1. **Excel had padded the header with whitespace.** The pristine downloaded template's header is
   exactly `العداد الحالي (كم)`; after the user widened that column and re-saved in Excel, the
   cell came back as `" العداد الحالي (كم) "` (leading+trailing space — reproduced and confirmed by
   diffing the original vs. the user's re-saved file). `cell()`'s exact-match lookup found nothing,
   silently reading every row's odometer as blank. **Fixed**: every parsed row's keys are now run
   through `normalizeRowKeys` (trim + collapse internal whitespace) right after `sheet_to_json`, for
   both sheets — tolerant of this without weakening "must match one of the real header names".
2. **Fixing #1 wasn't enough — `odoPlateSet` had its own bug.** It was built from every plate
   *present* on the "قراءات العداد" sheet, not every plate with an actual *reading* there. The
   template pre-fills a plate cell for all 35 vehicles on that sheet regardless of whether the admin
   ever fills in a reading — so with #1 fixed, `odoPlateSet` still contained all 35 plates from
   nothing but blank placeholder rows, which made the vehicle-sheet's own odometer cell get skipped
   for every single vehicle (the "defer to the real reading" rule from the first bug intended for
   the opposite situation misfired here) — while the blank odometer-sheet rows failed their own
   validation too. Net effect: neither code path ever updated anything. **Fixed**: `odoPlateSet` now
   only includes a plate when that sheet's own km cell is actually non-blank/numeric for it. Also
   quieted the resulting noise: a blank km cell on that sheet (the normal "didn't touch this
   vehicle" case for every untouched row) is now skipped silently instead of pushed into `errors` —
   it was flooding the response with ~35 scary-looking "قراءة العداد مطلوبة" messages for something
   that wasn't actually wrong.

Verified by literally re-running the user's OWN real file through the real endpoint (not synthetic
test data — this was their actual production fleet, and completing their real intended update WAS
the fix): first attempt after deploying fix #1 alone still returned `odometer: {created: 0}` and all
35 vehicles still at `current_odometer_km = 0` — confirmed the second bug was real, not a fluke.
After deploying fix #2, re-running the SAME file returned `odometer: {created: 35, errors: []}`, and
a direct DB check confirmed all 35 vehicles now show `current_odometer_km = 10000`,
`odometer_updated_at = today`. **Lesson**: a live probe with synthetic single-row test data (as run
for the original feature) is not a substitute for testing against a real multi-row file a real user
actually produced — Excel's own re-save behavior (header padding) was the trigger, and the
"plate-present vs. reading-present" distinction in `odoPlateSet` only shows up with a sheet that has
many rows, most of them blank, which no small hand-written test file happened to exercise.

## Summary page (`/summary`) — "المديونية" tab ignored the calendar date filter

Requested from a screenshot of the "المديونية" (debt) tab: add a calendar range filter that actually
affects the debt shown. The "من/إلى تاريخ" range picker already existed on the page and already drove
`collectionsTotal()` for the overview tab — but `debtData()` (the query behind the entire debt tab:
`grand_balance`, `by_region`, `by_rep`) never read `dateFrom`/`dateTo` at all, so picking a date range
visibly did nothing to "المديونية" even though the calendar control was right there and worked for
other tabs.

- Fixed by adding `if (dateFrom) clauses.push('i.invoice_date >= $n')` / same for `dateTo` inside
  `debtData()`'s existing WHERE-clause builder in `backend/src/routes/summary.js` — `dateFrom`/
  `dateTo` are already in scope as closure variables from the top of the `GET /summary` handler
  (`debtData` is a nested function inside it), so no new parameter passing was needed, just reading
  vars that were already there and already unused by this one query.
- **Filters on `invoices.invoice_date`, meaning "debt from invoices issued in this range"** — not a
  balance "as of" a past date. This table has no history of how a balance changed over time (only
  each invoice's current, present-day `balance`), so there's no data to reconstruct a true
  point-in-time snapshot from; filtering by invoice date is the closest honest interpretation of
  "the debt for this period" available from what's actually stored.
- Frontend: the "إجمالي الديون القائمة" summary tile now appends the active range in parentheses
  (e.g. "(فواتير 01 يناير ← 15 سبتمبر 2026)") when `filterFrom`/`filterTo` are set, so it's visually
  obvious the number is scoped to a period rather than being a full always-on total — the existing
  page-wide "📅 فلتر التاريخ" badge above the tabs already showed the active range generally, but
  this makes the connection to this specific number explicit right next to it.

Verified live against real production data (read-only, no test rows needed): unfiltered
`debt.grand_balance` from the API matched a direct DB sum with no date condition (3,342,525.29 SAR);
adding a `date_from`/`date_to` narrowing to roughly the middle-to-end of the invoices' real date range
returned a different, smaller total (2,694,253.30 SAR) that also matched a direct DB sum WITH that
same date condition exactly — confirming the filter is both wired up and numerically correct, not
just "responds with a different but wrong number." PM2 stable post-deploy, one restart matching the
deploy. Also caught mid-session: `deploy_rep_management.py` already whitelisted
`backend/src/routes/summary.js` (twice, a pre-existing harmless duplicate) — an earlier assumption
that it was missing (based on a grep that didn't match due to escaping) was wrong; worth re-checking
with a simpler pattern before concluding a file needs adding, to avoid introducing a real duplicate.

## CurrentStockPage matrix — two frozen columns (الصنف + الإجمالي)

- The first two columns (label + "الإجمالي") are `position: sticky` (`right: 0` / `right: var(--mx-label-w)`); the rest scroll horizontally. Backgrounds must be opaque, header cells sticky on both axes need the highest z-index.
- Both offsets share ONE variable `--mx-label-w` (200px, 140px on mobile) so the second column always sits flush against the first.
- Lesson: a `display:flex` on a `<td>` gets wrapped in an anonymous cell that IGNORES max-width, so long names widened the column past the offset and left a visible gap. The td is now `padding:0; overflow:hidden` and holds a fixed-width inner `div.csp-mx-lbl` (ellipsis on the name).
- `CurrentStockPage.css` was missing from the `deploy_rep_management.py` whitelist — now added.

## Fleet — edit/delete of a logged maintenance row (admin-only)

- `PUT` / `DELETE /api/fleet/maintenance-log/:id`, `requireRoles(...ADMIN_ROLES)` (stricter than expense edit on purpose: these rows drive the due/overdue alerts).
- One transaction, row `FOR UPDATE`: reverse the OLD `parts_used` stock (+qty), apply the NEW (−qty, negative-balance warnings only), then `recomputeMaintenanceSchedule` for the old type (and the new one if the type changed): latest remaining log (service_date DESC, id DESC) → else baseline = vehicle `current_odometer_km`, date NULL (same rule as migration 113; never 0, to avoid false "all overdue").
- UI: `VehicleProfile` in `FleetManagementPage.jsx` — "إجراءات" column with ✏️ تعديل (inline edit row) / 🗑️ حذف, shown only when `ADMIN_ROLES.includes(user.role)`.
- Verified live with throwaway vehicle/types/part (edit, type change, delete, 403 for non-admin, 404) — all cleaned up.

## Automated deploy via self-hosted GitHub Actions runner

`.github/workflows/deploy.yml` — pushing to `main` auto-deploys to production, replacing the manual
`deploy_rep_management.py` workflow (that script, and the excluded root-level `*.py` deploy scripts,
stay as-is for anyone who still wants to trigger a deploy manually, but are no longer the required
path). Built because Claude's cloud sandbox sessions can only reach the internet over HTTP(S) through
an agent proxy — no raw TCP protocol (SSH, RDP, WinRM) can ever pass through from that environment
regardless of its network-access settings — so a cloud session can never SSH into the Windows server
directly. A self-hosted GitHub Actions runner installed ON the server instead makes an *outbound*
HTTPS connection to GitHub to pick up jobs; no inbound port needs to stay open on the server at all.

- Runner registered on `C:\apps\Taryah-WB`'s GitHub repo (Settings → Actions → Runners), running as a
  Windows service. The workflow does **not** use `actions/checkout`'s default work directory — PM2
  serves the backend from, and IIS serves the frontend `dist` from, the fixed path
  `C:\apps\Taryah-WB`, so every step `cd`s there directly and runs `git fetch` + `git reset --hard
  origin/main` instead of letting the runner check out into its own separate `_work` folder.
- **Setup gotcha**: the runner service runs as `NT AUTHORITY\NETWORK SERVICE`, a different account
  from whichever admin account originally `git clone`d `C:\apps\Taryah-WB` — git's `safe.directory`
  ownership check then refuses every git command the workflow runs (`fatal: detected dubious
  ownership`). Fixed once, machine-wide, with `git config --system --add safe.directory
  C:/apps/Taryah-WB` (system scope, not `--global`, since `--global` would only apply to whichever
  user runs the command interactively, not the service account actually executing the workflow).
- **Setup gotcha #2**: this runner version has no standalone `svc.cmd` — the Windows service is
  installed by answering "Y" to `config.cmd`'s own "Would you like to run the runner as service?"
  prompt, not a separate command afterward. An early attempt hit `Error: Operation CreateService
  failed with return code 1072` (service marked for deletion, left over from a prior failed attempt)
  — resolved itself after a short wait once nothing (Services.msc, Task Manager) held an open handle
  to the stale registration; `sc.exe query <service-name>` returning error 1060 ("does not exist")
  confirms it's clear to retry. Once already registered locally, `config.cmd` refuses to reconfigure
  ("already configured") — run `./config.cmd remove --token <fresh token>` first, then the full
  registration command again with a newer token (registration tokens expire quickly, within about an
  hour).
- **Root cause of `error: unable to unlink old '...': Invalid argument` on `git reset --hard`**:
  Git for Windows' `core.fscache` optimization (a known source of exactly this symptom on NTFS
  during large batch checkouts — separate git processes are fine, but many files updated in rapid
  succession within one `git reset --hard` trips it). Ruled out first, methodically, before finding
  this: a persistent file lock (`handle64.exe` found nothing), Windows Defender real-time scanning
  (exclusion for `C:\apps\Taryah-WB` was already correctly set and active), Controlled Folder Access
  (disabled), Tamper Protection (disabled, so the Defender exclusion wasn't being silently ignored
  either), any third-party AV/EDR (none installed, only Defender), and the files themselves being
  read-only/compressed/symlinks (plain ordinary files). A `Remove-Item` on the exact same file
  outside git succeeded instantly every time, pointing at git's own batch-delete path specifically,
  not an external blocker — `git config core.fscache false` (set both in the workflow, so it
  survives a future re-clone, and already persisted in the live repo's `.git/config`) fixed it
  completely. **The 15-attempt retry loop around `git reset --hard` is kept as a defensive
  fallback** (cheap, harmless if never triggered) in case some other transient issue causes a
  similar failure later, but it was masking the real problem rather than fixing it — 75 seconds of
  patient retrying still failed 100% of the time before this fix, which is itself what proved this
  wasn't actually a transient race.
- **`Could not write new index file`, a SEPARATE failure that only reproduced under the runner
  service account, never in an interactive Administrator session**: the service runs as `NT
  AUTHORITY\NETWORK SERVICE`, which lacked write permission somewhere under `.git` (and, unnoticed
  until this point since git hadn't gotten far enough yet, would have hit the same wall writing
  `frontend/dist`, `frontend/node_modules`, `backend/node_modules` in later steps too) — the earlier
  `safe.directory` fix only satisfied git's own ownership *check*, it granted no actual NTFS
  permission. Fixed with `icacls "C:\apps\Taryah-WB" /grant "NT AUTHORITY\NETWORK SERVICE:(OI)(CI)M"
  /T` (Modify, recursive, run once manually — not part of the workflow, since it's a one-time
  machine setup step, not something that needs to re-run on every deploy).
- **`pm2` command not found when run BY the workflow**, despite working fine manually: `node`/`npm`
  are on the system-wide PATH (installed via the Node MSI), but `pm2` was installed as a global npm
  package under the interactively-logged-in Administrator account (`npm install -g pm2`), which only
  adds it to *that account's* user-scoped PATH (`%APPDATA%\npm`) — invisible to the service account
  running the workflow. Fixed by calling pm2 via its full path
  (`C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd`) instead of relying on PATH resolution — but
  the full path alone still 404'd ("term not recognized") because `NETWORK SERVICE` couldn't even
  traverse into another account's `C:\Users\Administrator\...` profile folder at all (Windows blocks
  cross-account profile access by default). Granted once manually: `icacls
  "C:\Users\Administrator\AppData\Roaming\npm" /grant "NT AUTHORITY\NETWORK SERVICE:(OI)(CI)RX" /T`
  (Read+Execute only — this folder never needs to be written to). **A second, separate gotcha even
  once the executable itself is reachable**: PM2 keeps its running daemon's state in `PM2_HOME`
  (default `%HOME%\.pm2`, so `C:\Users\Administrator\.pm2` for whoever originally ran `pm2 start`) —
  a DIFFERENT OS account calling `pm2 restart` would, without setting this explicitly, talk to its
  OWN separate/empty PM2 instance under its own profile and never find `taryah-backend` at all
  (silently the wrong daemon, not an error). Workflow sets
  `$env:PM2_HOME = "C:\Users\Administrator\.pm2"` before every pm2 call so it always controls the
  one real, already-running daemon regardless of which account executes the workflow step.
- **The real fix, after five separate `NETWORK SERVICE` permission walls (git ownership, `.git`
  write access, the npm global-install folder, the `AppData` traversal chain, and finally PM2's own
  named pipe `\\.\pipe\rpc.sock` — which has its own Windows security descriptor set at creation
  time and can't be touched by `icacls` at all)**: switch the runner Windows service itself to log on
  as the actual `Administrator` account instead of the default `NT AUTHORITY\NETWORK SERVICE`
  (`services.msc` → the runner service → Properties → Log On → "This account"). This is standard
  practice for a self-hosted Windows runner that needs real deploy privileges — `NETWORK SERVICE` is
  deliberately low-privilege and was never going to have write access to `.git`, PM2's daemon, or
  anything else Administrator itself owns, no matter how many individual `icacls`/`PM2_HOME`
  workarounds got layered on. Once switched, every one of the earlier workarounds still works
  (harmless/redundant now) but stops being load-bearing.
- **`curl.exe` isn't on PATH when run non-interactively, even as Administrator** — Windows Server
  2016 doesn't ship curl.exe natively (added to Windows starting with 10 1803 / Server 2019), and
  whatever earlier install put it on this box's PATH apparently only did so for the interactive
  logon shell, not the service's process environment. Switched the health-check step to PowerShell's
  own built-in `Invoke-WebRequest` instead of shelling out to `curl.exe`, removing the external-binary
  PATH dependency entirely.
- Steps: pull → `npm install && npm run build` (frontend) → `npm install` (backend) →
  `pm2 restart taryah-backend` + `pm2 save` → a health-check `Invoke-WebRequest` against
  `https://www.sales.taryahpoultry.com.sa/api/health`, failing the job (not just logging) if it
  doesn't return 200 — so a deploy that silently broke the backend shows as a failed GitHub Actions
  run, not a false "success".
- Superseded `.github/workflows/placeholder.yml` (a no-op stub that existed only to suppress "deploy
  failed" emails from GitHub, back when there was no real CI/CD) — deleted rather than kept alongside,
  since it no longer serves any purpose once a real workflow runs on the same trigger.

## Ongoing Rules
- Always update this CLAUDE.md when adding new pages, routes, migrations, or significant business logic changes.
- After any local code change: `docker compose build && docker compose up -d`
- Push to `main` → the self-hosted-runner workflow (above) deploys automatically. Manual deploy via `deploy_rep_management.py` (see Production Deployment above) remains available as a fallback.
