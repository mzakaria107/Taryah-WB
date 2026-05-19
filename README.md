# لوحة أرصدة العملاء — Customer Balance Dashboard

نظام متابعة التحصيل والمديونيات لشركة توزيع الغذاء في المملكة العربية السعودية.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite + Tailwind CSS (RTL) |
| Backend | Node.js + Express |
| Database | PostgreSQL 16 |
| Auth | JWT + RBAC |
| PWA | vite-plugin-pwa + Workbox |
| Deployment | Docker Compose + Nginx |

---

## Quick Start (Docker)

### Prerequisites
- Docker Desktop (Windows/Mac) or Docker Engine + Compose plugin (Linux)

### 1. Clone and configure
```bash
cd customer-balance-app
cp .env.example .env
# Edit .env — set a strong JWT_SECRET
```

### 2. Start all services
```bash
docker compose up -d --build
```

### 3. Run migrations and seed data
```bash
# Run migrations
docker compose exec backend node src/db/migrate.js

# Seed initial data (regions + test users + 30 sample invoices)
docker compose exec backend node src/db/seed.js
```

### 4. Open the app
Navigate to **http://localhost** in your browser.

---

## Test Credentials

| Role | Email | Password |
|------|-------|----------|
| Super Admin | admin@company.com | Admin@123 |
| IT Admin | itadmin@company.com | Admin@123 |
| Region Manager (Riyadh) | manager1@company.com | Admin@123 |

---

## Local Development (without Docker)

### Prerequisites
- Node.js 20+
- PostgreSQL 16 running locally

### Backend
```bash
cd backend
cp .env.example .env
# Edit .env with your local DATABASE_URL
npm install
node src/db/migrate.js
node src/db/seed.js
npm run dev
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Frontend runs at `http://localhost:5173`, proxies `/api/*` to `http://localhost:3000`.

---

## Project Structure

```
customer-balance-app/
├── backend/
│   ├── src/
│   │   ├── routes/       auth.js, invoices.js, upload.js, notes.js, users.js
│   │   ├── middleware/   auth.js (JWT+RBAC), upload.js (multer)
│   │   ├── db/           pool.js, migrate.js, seed.js, migrations/
│   │   └── index.js
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/   KPICards, YearStrip, Filters, InvoiceTable, NotesCell, UploadPanel, Navbar
│   │   ├── pages/        Login.jsx, Dashboard.jsx, Admin.jsx
│   │   ├── context/      AuthContext.jsx
│   │   ├── hooks/        useInvoices.js, useNotes.js, useUpload.js
│   │   └── main.jsx
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml
├── nginx.conf
└── README.md
```

---

## RBAC Roles

| Role | Permissions |
|------|-------------|
| `super_admin` | All regions, all data, manage users |
| `region_manager` | Own region only, read + notes |
| `sales_rep` | Own region only, read + notes |
| `it_admin` | Upload files only |

---

## Upload Excel File

The system accepts `.xlsx` files via the Upload Panel (visible to `super_admin` and `it_admin`).

**Supported column headers** (case-insensitive, partial match):
| Excel Column | DB Field |
|-------------|---------|
| Customer Code | customer_id |
| Customer Name | customer_name |
| Territory / المنطقة | region_id (mapped by name) |
| Route | route_id |
| Invoice Number | invoice_number |
| Invoice Date | invoice_date |
| Original Amount | original_amount |
| Amount Paid | paid_amount |
| Balance | balance |
| Customer Type | customer_type |

> If your Excel has different headers, share the file and the column mapping will be updated.

---

## API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/register | Create user |
| POST | /api/auth/login | Login → JWT |
| GET | /api/auth/me | Current user info |

### Invoices
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/invoices | List invoices (filterable) |
| GET | /api/invoices/kpi | Aggregate KPIs |
| GET | /api/invoices/years | Year strip data |
| GET | /api/invoices/:id | Single invoice |

### Notes
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/notes/:invoiceId | Get note |
| PUT | /api/notes/:invoiceId | Upsert note |

### Upload
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/upload/customer-balance | Upload .xlsx |
| GET | /api/upload/batches | Recent upload history |

### Users (super_admin)
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/users | List all users |
| PUT | /api/users/:id | Update user |
| DELETE | /api/users/:id | Delete user |
| GET | /api/users/regions | List regions |

---

## PWA Installation

On mobile: open the app in Chrome/Safari, tap the browser menu → "Add to Home Screen".  
The app works offline for cached data using Workbox NetworkFirst strategy.

---

## Production Notes

1. Change `JWT_SECRET` in `.env` to a long random string.
2. Change default PostgreSQL credentials.
3. Configure HTTPS via a reverse proxy (Nginx + Certbot or Cloudflare).
4. Set `CORS_ORIGIN` to your actual domain.
5. Restrict `/uploads` access in production nginx config.
