const express  = require('express');
const xlsx     = require('xlsx');
const pool     = require('../db/pool');
const upload   = require('../middleware/upload');
const { verifyToken, requireRoles } = require('../middleware/auth');
const { fetchNetSuiteInventory, testConnection } = require('../utils/netsuite');

const router = express.Router();
const ADMIN  = ['super_admin', 'it_admin'];

function safeNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

// Detect category (subtotal) rows vs product rows in the distribution sheet
function isProductRow(name) {
  return /\d+\s*gm|\d+\s*kg|\d+\s*g\b|bulk|fillet|wing|thigh|breast|gizzard|liver|heart|leg\b|drum|halves|pieces|mandi|spicy|shawerma|minced/i
    .test(name);
}

// Excel column header → area_code mapping (matches Areas Daily Orders.xlsx)
const AREA_COL_MAP = {
  'Hael':               'hael',
  'Arar - Sakaka':      'arar_sakaka',
  'El Madina':          'el_madina',
  'Qassem':             'qassem',
  'Riyadh':             'riyadh',
  'Shaqraa':            'shaqraa',
  'Al Dawadmy':         'al_dawadmy',
  'Carrefour - Riyadh': 'carrefour_riyadh',
  'Atayeb Alulya':      'atayeb_alulya',
};

// ── GET /api/stock/areas ──────────────────────────────────────
router.get('/areas', verifyToken, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM stock_areas WHERE is_active = true ORDER BY sort_order, area_name'
    );
    res.json({ areas: rows });
  } catch (err) {
    console.error('[Stock] areas:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /api/stock/combined ───────────────────────────────────
// Latest snapshot + latest distribution merged by item_name
router.get('/combined', verifyToken, async (_req, res) => {
  try {
    const [snapRes, distRes, areasRes] = await Promise.all([
      pool.query(
        `SELECT s.*, u.name AS synced_by_name
         FROM stock_snapshots s
         LEFT JOIN users u ON u.id = s.synced_by
         ORDER BY s.synced_at DESC LIMIT 1`
      ),
      pool.query(
        `SELECT d.*, u.name AS uploaded_by_name
         FROM stock_distributions d
         LEFT JOIN users u ON u.id = d.uploaded_by
         ORDER BY d.uploaded_at DESC LIMIT 1`
      ),
      pool.query(
        'SELECT * FROM stock_areas WHERE is_active = true ORDER BY sort_order'
      ),
    ]);

    const areas   = areasRes.rows;
    const snap    = snapRes.rows[0]  || null;
    const dist    = distRes.rows[0]  || null;

    // Build stock map: item_name → {qty_on_hand, qty_available, ...}
    const stockMap = {};
    if (snap) {
      const { rows } = await pool.query(
        'SELECT * FROM stock_snapshot_items WHERE snapshot_id = $1 ORDER BY category, item_name',
        [snap.id]
      );
      rows.forEach(r => { stockMap[r.item_name] = r; });
    }

    // Build distribution map: item_name → { area_id → quantity }
    const distMap  = {};
    const catMap   = {};  // item_name → category (from distribution)
    if (dist) {
      const { rows } = await pool.query(
        `SELECT di.item_name, di.category, di.area_id, di.quantity
         FROM stock_distribution_items di
         WHERE di.distribution_id = $1`,
        [dist.id]
      );
      rows.forEach(r => {
        if (!distMap[r.item_name])  distMap[r.item_name] = {};
        distMap[r.item_name][r.area_id] = safeNum(r.quantity);
        if (!catMap[r.item_name]) catMap[r.item_name] = r.category;
      });
    }

    // Union of all item names (from both sources)
    const allNames = new Set([
      ...Object.keys(stockMap),
      ...Object.keys(distMap),
    ]);

    const items = Array.from(allNames).sort((a, b) => {
      const ca = (stockMap[a]?.category || catMap[a] || '');
      const cb = (stockMap[b]?.category || catMap[b] || '');
      return ca.localeCompare(cb) || a.localeCompare(b);
    }).map(name => {
      const s = stockMap[name] || {};
      const d = distMap[name]  || {};
      const totDist = areas.reduce((sum, ar) => sum + (d[ar.id] || 0), 0);
      return {
        item_name:     name,
        category:      s.category || catMap[name] || '',
        netsuite_id:   s.netsuite_id || '',
        qty_on_hand:   s.qty_on_hand    !== undefined ? safeNum(s.qty_on_hand)    : null,
        qty_available: s.qty_available  !== undefined ? safeNum(s.qty_available)  : null,
        distribution:  d,        // { area_id → qty }
        tot_dist:      totDist,
      };
    });

    res.json({ snapshot: snap, distribution: dist, areas, items });
  } catch (err) {
    console.error('[Stock] combined:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /api/stock/snapshots ──────────────────────────────────
router.get('/snapshots', verifyToken, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || 50), 200);
    const offset = parseInt(req.query.offset || 0);
    const { rows } = await pool.query(
      `SELECT s.*, u.name AS synced_by_name
       FROM stock_snapshots s
       LEFT JOIN users u ON u.id = s.synced_by
       ORDER BY s.synced_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: cnt } = await pool.query('SELECT COUNT(*) FROM stock_snapshots');
    res.json({ snapshots: rows, total: parseInt(cnt[0].count) });
  } catch (err) {
    console.error('[Stock] snapshots list:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /api/stock/snapshots/:id ──────────────────────────────
router.get('/snapshots/:id', verifyToken, async (req, res) => {
  try {
    const snapRes = await pool.query(
      `SELECT s.*, u.name AS synced_by_name
       FROM stock_snapshots s LEFT JOIN users u ON u.id = s.synced_by
       WHERE s.id = $1`,
      [req.params.id]
    );
    if (!snapRes.rows.length) return res.status(404).json({ error: 'لم يتم العثور على السجل' });
    const itemsRes = await pool.query(
      'SELECT * FROM stock_snapshot_items WHERE snapshot_id = $1 ORDER BY category, item_name',
      [req.params.id]
    );
    res.json({ snapshot: snapRes.rows[0], items: itemsRes.rows });
  } catch (err) {
    console.error('[Stock] snapshot detail:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── POST /api/stock/sync ─ Sync from NetSuite ─────────────────
router.post('/sync', verifyToken, requireRoles(...ADMIN), async (req, res) => {
  try {
    const cfgRes = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'netsuite_config'"
    );
    if (!cfgRes.rows.length || !cfgRes.rows[0].value) {
      return res.status(400).json({ error: 'إعدادات NetSuite غير مكتملة. أضف الإعدادات أولاً.' });
    }
    const cfg = cfgRes.rows[0].value;
    const missing = ['account_id', 'consumer_key', 'consumer_secret', 'token_key', 'token_secret']
      .filter(f => !cfg[f]);
    if (missing.length) {
      return res.status(400).json({ error: `إعدادات NetSuite ناقصة: ${missing.join(', ')}` });
    }

    console.log('[Stock] Syncing from NetSuite...');
    const items = await fetchNetSuiteInventory({
      accountId:      cfg.account_id,
      consumerKey:    cfg.consumer_key,
      consumerSecret: cfg.consumer_secret,
      tokenKey:       cfg.token_key,
      tokenSecret:    cfg.token_secret,
      savedSearchId:  cfg.saved_search_id,
    });
    console.log(`[Stock] Got ${items.length} items from NetSuite`);

    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      const snapDate = req.body.snapshot_date || new Date().toISOString().split('T')[0];
      const { rows: [snap] } = await dbClient.query(
        `INSERT INTO stock_snapshots (snapshot_date, synced_by, source, notes, item_count)
         VALUES ($1, $2, 'netsuite', $3, $4) RETURNING id`,
        [snapDate, req.user.id, req.body.notes || null, items.length]
      );

      const BATCH = 500, COLS = 7;
      for (let i = 0; i < items.length; i += BATCH) {
        const chunk = items.slice(i, i + BATCH);
        const vals  = [];
        const ph    = chunk.map((item, idx) => {
          const b = idx * COLS;
          vals.push(snap.id, item.item_name, item.category || '', item.netsuite_id,
                    item.item_code, item.qty_on_hand, item.qty_available);
          return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`;
        });
        await dbClient.query(
          `INSERT INTO stock_snapshot_items
             (snapshot_id, item_name, category, netsuite_id, item_code, qty_on_hand, qty_available)
           VALUES ${ph.join(',')}`,
          vals
        );
      }
      await dbClient.query('COMMIT');
      res.json({ success: true, snapshotId: snap.id, itemCount: items.length });
    } catch (err) {
      await dbClient.query('ROLLBACK');
      throw err;
    } finally {
      dbClient.release();
    }
  } catch (err) {
    console.error('[Stock] sync error:', err.message);
    res.status(500).json({ error: `فشل في المزامنة: ${err.message}` });
  }
});

// ── POST /api/stock/test-connection ──────────────────────────
router.post('/test-connection', verifyToken, requireRoles(...ADMIN), async (req, res) => {
  try {
    const cfg = req.body;
    const missing = ['account_id', 'consumer_key', 'consumer_secret', 'token_key', 'token_secret']
      .filter(f => !cfg[f]);
    if (missing.length) return res.status(400).json({ error: `حقول ناقصة: ${missing.join(', ')}` });

    await testConnection({
      accountId:      cfg.account_id,
      consumerKey:    cfg.consumer_key,
      consumerSecret: cfg.consumer_secret,
      tokenKey:       cfg.token_key,
      tokenSecret:    cfg.token_secret,
    });
    res.json({ success: true, message: 'تم الاتصال بـ NetSuite بنجاح' });
  } catch (err) {
    console.error('[Stock] test-connection:', err.message);
    res.status(400).json({ success: false, error: `فشل الاتصال: ${err.message}` });
  }
});

// ── GET /api/stock/distributions ─────────────────────────────
router.get('/distributions', verifyToken, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || 50), 200);
    const offset = parseInt(req.query.offset || 0);
    const { rows } = await pool.query(
      `SELECT d.*, u.name AS uploaded_by_name
       FROM stock_distributions d
       LEFT JOIN users u ON u.id = d.uploaded_by
       ORDER BY d.uploaded_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: cnt } = await pool.query('SELECT COUNT(*) FROM stock_distributions');
    res.json({ distributions: rows, total: parseInt(cnt[0].count) });
  } catch (err) {
    console.error('[Stock] distributions list:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /api/stock/distributions/:id ─────────────────────────
router.get('/distributions/:id', verifyToken, async (req, res) => {
  try {
    const distRes = await pool.query(
      `SELECT d.*, u.name AS uploaded_by_name
       FROM stock_distributions d LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.id = $1`,
      [req.params.id]
    );
    if (!distRes.rows.length) return res.status(404).json({ error: 'لم يتم العثور على السجل' });
    const { rows: areas }  = await pool.query(
      'SELECT * FROM stock_areas WHERE is_active = true ORDER BY sort_order'
    );
    const { rows: distItems } = await pool.query(
      `SELECT di.*, sa.sort_order
       FROM stock_distribution_items di
       LEFT JOIN stock_areas sa ON sa.id = di.area_id
       WHERE di.distribution_id = $1
       ORDER BY di.category, di.item_name, sa.sort_order`,
      [req.params.id]
    );

    // Pivot: item_name → { category, areas: { area_id → qty } }
    const itemMap = {};
    distItems.forEach(r => {
      if (!itemMap[r.item_name]) itemMap[r.item_name] = { item_name: r.item_name, category: r.category, distribution: {} };
      itemMap[r.item_name].distribution[r.area_id] = safeNum(r.quantity);
    });

    res.json({
      distribution: distRes.rows[0],
      areas,
      items: Object.values(itemMap).sort((a, b) =>
        (a.category || '').localeCompare(b.category) || a.item_name.localeCompare(b.item_name)
      ),
    });
  } catch (err) {
    console.error('[Stock] distribution detail:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── POST /api/stock/distribution/upload ──────────────────────
router.post(
  '/distribution/upload',
  verifyToken, requireRoles(...ADMIN),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });

    try {
      const workbook = xlsx.readFile(req.file.path, { cellDates: false, dense: true, sheetStubs: false });
      const ws = workbook.Sheets[workbook.SheetNames[0]];

      // Row 0 = title ("Distribution"), Row 1 = blank, Row 2 = headers
      const rawRows = xlsx.utils.sheet_to_json(ws, { defval: null, raw: true, range: 2 });
      if (!rawRows.length) return res.status(400).json({ error: 'الملف فارغ' });

      // Load areas from DB
      const { rows: areasDB } = await pool.query(
        'SELECT * FROM stock_areas WHERE is_active = true ORDER BY sort_order'
      );
      const areasByCode = Object.fromEntries(areasDB.map(a => [a.area_code, a]));

      const distItems   = [];
      let currentCat    = '';

      for (const row of rawRows) {
        const name = String(row['Items'] || '').trim();
        if (!name) continue;

        if (!isProductRow(name)) {
          // Category / subtotal row — track category, skip from items
          currentCat = name;
          continue;
        }

        // Product row — extract per-area quantities
        for (const [colName, areaCode] of Object.entries(AREA_COL_MAP)) {
          const area = areasByCode[areaCode];
          if (!area) continue;
          distItems.push({
            item_name: name,
            category:  currentCat,
            area_id:   area.id,
            area_name: area.area_name,
            quantity:  safeNum(row[colName]),
          });
        }
      }

      if (!distItems.length) {
        return res.status(400).json({ error: 'لم يتم العثور على بيانات في الملف. تأكد من تنسيق الملف.' });
      }

      const uniqueItems = [...new Set(distItems.map(d => d.item_name))].length;
      const distDate    = req.body.distribution_date || new Date().toISOString().split('T')[0];
      const notes       = req.body.notes || null;

      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');

        const { rows: [dist] } = await dbClient.query(
          `INSERT INTO stock_distributions (distribution_date, uploaded_by, notes, item_count)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [distDate, req.user.id, notes, uniqueItems]
        );

        const BATCH = 500, COLS = 6;
        for (let i = 0; i < distItems.length; i += BATCH) {
          const chunk = distItems.slice(i, i + BATCH);
          const vals  = [];
          const ph    = chunk.map((item, idx) => {
            const b = idx * COLS;
            vals.push(dist.id, item.item_name, item.category, item.area_id, item.area_name, item.quantity);
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`;
          });
          await dbClient.query(
            `INSERT INTO stock_distribution_items
               (distribution_id, item_name, category, area_id, area_name, quantity)
             VALUES ${ph.join(',')}`,
            vals
          );
        }

        await dbClient.query('COMMIT');
        console.log(`[Stock] Distribution uploaded: ${uniqueItems} items × ${areasDB.length} areas`);
        res.json({ success: true, distributionId: dist.id, itemCount: uniqueItems, rowCount: distItems.length });
      } catch (err) {
        await dbClient.query('ROLLBACK');
        throw err;
      } finally {
        dbClient.release();
      }
    } catch (err) {
      console.error('[Stock] distribution upload error:', err.message);
      res.status(500).json({ error: `فشل في معالجة الملف: ${err.message}` });
    }
  }
);

module.exports = router;
