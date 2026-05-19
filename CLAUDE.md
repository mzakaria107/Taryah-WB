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

### Inactive Customer Count
Customers with `total_qty <= 0` (including returns/negative corrections) are counted as "غير متعاملة". Use `<= 0`, not `=== 0`.

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

## Production Deployment

**Server**: Windows Server 2016, IP 176.9.85.242, **native stack (no Docker)**, domain `www.sales.taryahpoultry.com.sa`

**Stack**:
- PostgreSQL 15 → Windows Service (auto-start)
- Node.js 20 backend → PM2 (`taryah-backend`), auto-starts via pm2-windows-startup
- nginx (Windows exe, `C:\tools\nginx-*\`) → NSSM Windows Service (`TaryahNginx`, auto-start)
- React frontend → built to `C:\apps\Taryah-WB\frontend\dist`, served as static files by nginx

**DB connection**: `pool.js` accepts both `DATABASE_URL` (single connection string) **or** individual `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` vars. The `.env` on the server uses the individual vars.

**SSL certs**: win-acme (Let's Encrypt), stored at `C:\certs\fullchain.pem` and `C:\certs\privkey.pem`. nginx references them directly (no container mount needed).

**nginx config**: `nginx.conf` is Windows-native — no Docker upstreams. Serves static files from `C:/apps/Taryah-WB/frontend/dist`, proxies `/api/` to `http://127.0.0.1:3000`.

**Deploy workflow**:
1. Make changes locally → push to `main` on GitHub
2. On server: `powershell -File C:\apps\Taryah-WB\deploy.ps1`
   (git pull → npm build → npm install → pm2 restart → nginx reload)

**Scripts**:
- `scripts/install-server.ps1` — one-time setup (Chocolatey, all tools, DB, clone)
- `scripts/start-services.ps1` — first start after install + SSL setup
- `scripts/deploy.ps1` — routine updates
- `scripts/backup.ps1` — nightly DB dump, 7-day retention (Task Scheduler, 2AM)

**Environment**: Copy `.env.example` → `.env` on server and fill real values. Never commit `.env`.

**Port exposure**: Only 80 (→301 HTTPS redirect) and 443 are public. 3000 and 5432 are firewalled off.

## Ongoing Rules
- Always update this CLAUDE.md when adding new pages, routes, migrations, or significant business logic changes.
- After any code change, a Docker rebuild is required: `docker compose build && docker compose up -d`
