// Load .env from backend/ directory regardless of working directory
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const path     = require('path');
const fs       = require('fs');
const pool     = require('./db/pool');

const authRoutes     = require('./routes/auth');
const invoiceRoutes  = require('./routes/invoices');
const notesRoutes    = require('./routes/notes');
const uploadRoutes   = require('./routes/upload');
const usersRoutes    = require('./routes/users');
const exportRoutes   = require('./routes/export');
const settingsRoutes  = require('./routes/settings');
const paymentsRoutes      = require('./routes/payments');
const salesActivityRoutes = require('./routes/salesActivity');
const salesTasksRoutes    = require('./routes/salesTasks');
const notificationsRoutes = require('./routes/notifications');
const fridgesRoutes       = require('./routes/fridges');
const stockRoutes         = require('./routes/stock');
const currentStockRoutes  = require('./routes/currentStock');
const permissionsRoutes        = require('./routes/permissions');
const reconciliationsRoutes    = require('./routes/reconciliations');
const salesReportRoutes        = require('./routes/salesReport');
const coverageRoutes           = require('./routes/coverage');
const summaryRoutes            = require('./routes/summary');
const hypermarketsRoutes       = require('./routes/hypermarkets');
const categoryPerformanceRoutes = require('./routes/categoryPerformance');
const regionPerformanceRoutes  = require('./routes/regionPerformance');
const qualityIssuesRoutes      = require('./routes/qualityIssues');
const collectionsRoutes        = require('./routes/collections');
const agingRoutes              = require('./routes/aging');
const salesRepsRoutes          = require('./routes/salesReps');
const performanceDashboardRoutes = require('./routes/performanceDashboard');
const commissionsRoutes        = require('./routes/commissions');
const targetApprovalsRoutes    = require('./routes/targetApprovals');
const profitabilityRoutes      = require('./routes/profitability');
const discountShopsRoutes      = require('./routes/discountShops');
const carrefourDamageRoutes    = require('./routes/carrefourDamage');
const qualityReturnsRoutes     = require('./routes/qualityReturns');
const fleetRoutes              = require('./routes/fleet');

/* ── Auto-run pending DB migrations on startup ── */
async function runMigrations() {
  const migrationsDir = path.join(__dirname, 'db', 'migrations');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         SERIAL PRIMARY KEY,
      filename   VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const files = fs.readdirSync(migrationsDir).sort().filter(f => f.endsWith('.sql'));
  for (const file of files) {
    const { rows } = await pool.query('SELECT id FROM _migrations WHERE filename=$1', [file]);
    if (rows.length) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
    console.log(`  migration applied: ${file}`);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
/* Bind address. Defaults to every interface because under Docker the nginx
   container reaches the backend across the container network — a loopback
   bind would make it unreachable there.
   On the Windows production box BIND_HOST=127.0.0.1: IIS is the only client,
   and a WILDCARD bind is what let another service (WaNotifyServer, on
   127.0.0.1:3001) silently take over the loopback address IIS proxies to
   while PM2 still reported us "online". Claiming the specific address makes
   that collision impossible — a second binder now fails loudly instead. */
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';

// Trust the nginx reverse proxy (needed for express-rate-limit with X-Forwarded-For)
app.set('trust proxy', 1);

// Security
app.use(helmet());
// Internal dashboard — allow all origins, reflect them (required for credentials: true)
app.use(cors({ origin: true, credentials: true }));

// Rate limiting
// IIS ARR forwards the client address as "IP:port" which express-rate-limit
// rejects (ERR_ERL_INVALID_IP_ADDRESS) — strip the port and disable the check.
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'محاولات كثيرة جداً، يرجى المحاولة لاحقاً' },
  keyGenerator: (req) => {
    const raw = req.ip || req.socket?.remoteAddress || 'unknown';
    return raw.replace(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/, '$1');
  },
  validate: { ip: false },
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files (restrict in production)
app.use('/uploads', express.static(path.resolve(process.env.UPLOAD_DIR || './uploads')));

// Routes
app.use('/api/auth',     authRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/notes',    notesRoutes);
app.use('/api/upload',   uploadRoutes);
app.use('/api/users',    usersRoutes);
app.use('/api/export',   exportRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/payments',        paymentsRoutes);
app.use('/api/sales-activity', salesActivityRoutes);
app.use('/api/sales-tasks',   salesTasksRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/fridges',       fridgesRoutes);
app.use('/api/stock',         stockRoutes);
app.use('/api/current-stock', currentStockRoutes);
app.use('/api/permissions',      permissionsRoutes);
app.use('/api/reconciliations',  reconciliationsRoutes);
app.use('/api/sales-report',     salesReportRoutes);
app.use('/api/coverage',         coverageRoutes);
app.use('/api/summary',          summaryRoutes);
app.use('/api/hypermarkets',     hypermarketsRoutes);
app.use('/api/category-performance', categoryPerformanceRoutes);
app.use('/api/region-performance',   regionPerformanceRoutes);
app.use('/api/quality-issues',       qualityIssuesRoutes);
app.use('/api/collections',      collectionsRoutes);
app.use('/api/aging',            agingRoutes);
app.use('/api/sales-reps',       salesRepsRoutes);
app.use('/api/performance-dashboard', performanceDashboardRoutes);
app.use('/api/commissions',      commissionsRoutes);
app.use('/api/target-approvals', targetApprovalsRoutes);
app.use('/api/profitability',    profitabilityRoutes);
app.use('/api/discount-shops',   discountShopsRoutes);
app.use('/api/carrefour-damage', carrefourDamageRoutes);
app.use('/api/quality-returns',  qualityReturnsRoutes);
app.use('/api/fleet',            fleetRoutes);

// Last-upload timestamps for the three daily reports
const { verifyToken: _vt } = require('./middleware/auth');
app.get('/api/last-uploads', _vt, async (_req, res) => {
  try {
    const [balRes, payRes, saRes] = await Promise.all([
      pool.query(
        `SELECT MAX(created_at) AS ts FROM upload_batches
         WHERE file_type='customer_balance' AND status='success'`
      ),
      pool.query(`SELECT MAX(uploaded_at) AS ts FROM payments`),
      pool.query(`SELECT MAX(uploaded_at) AS ts FROM sales_activity`),
    ]);
    res.json({
      customer_balance: balRes.rows[0]?.ts || null,
      payments:         payRes.rows[0]?.ts || null,
      sales_activity:   saRes.rows[0]?.ts  || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'خطأ داخلي في الخادم' });
});

/* ── Daily profitability snapshot — 11:59 PM every day ──────── */
const cron = require('node-cron');
const { fetchFromNetSuite } = require('./routes/profitability');
cron.schedule('59 23 * * *', async () => {
  console.log('[Cron] Daily profitability snapshot starting...');
  try {
    await fetchFromNetSuite();
    console.log('[Cron] Daily profitability snapshot complete.');
  } catch (err) {
    console.error('[Cron] Profitability snapshot failed:', err.message);
  }
}, { timezone: 'Asia/Riyadh' });

runMigrations()
  .then(() => {
    app.listen(PORT, BIND_HOST, () => console.log(`✓ Server running on ${BIND_HOST}:${PORT}`));
  })
  .catch(err => {
    console.error('Migration failed, starting anyway:', err.message);
    app.listen(PORT, BIND_HOST, () => console.log(`✓ Server running on ${BIND_HOST}:${PORT}`));
  });

module.exports = app;
