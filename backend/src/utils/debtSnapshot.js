/**
 * debtSnapshot.js — freezes each rep's outstanding balance for a CLOSED
 * month the first time it's read.
 *
 * commissions.js and performanceDashboard.js both compute "المديونية
 * القائمة" from a live SUM(balance) over invoices. That's correct for the
 * current, still-open month, but for a past month it means the figure
 * keeps drifting after the fact as invoices/payments continue to post —
 * a commission already reviewed for July could silently change in August.
 * Once a month is closed, its balance is locked in on first read (an
 * on-demand snapshot, not a scheduled job) and every later read for that
 * same rep/month returns the same frozen number.
 */
const pool = require('../db/pool');

function isClosedMonth(year, month) {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  return year < curY || (year === curY && month < curM);
}

/**
 * @param reps    [{ id, netsuite_name }] — the reps to resolve balances for
 * @param year, month
 * @returns { [netsuite_name]: outstanding_balance }
 */
async function getRepBalances(reps, year, month) {
  const nsNames = reps.map(r => r.netsuite_name).filter(Boolean);
  const live = {};
  if (nsNames.length) {
    const balRes = await pool.query(
      `SELECT sales_rep_name, COALESCE(SUM(balance),0) AS outstanding_balance
       FROM invoices
       WHERE sales_rep_name = ANY($1::text[]) AND status IN ('unpaid','partial') AND balance > 0
       GROUP BY sales_rep_name`,
      [nsNames]
    );
    balRes.rows.forEach(r => { live[r.sales_rep_name] = parseFloat(r.outstanding_balance); });
  }

  if (!isClosedMonth(year, month) || !reps.length) return live;

  const repIds = reps.map(r => r.id);
  const snapRes = await pool.query(
    `SELECT rep_id, outstanding_balance FROM rep_debt_snapshots
     WHERE rep_id = ANY($1::int[]) AND year = $2 AND month = $3`,
    [repIds, year, month]
  );
  const snapByRepId = {};
  snapRes.rows.forEach(r => { snapByRepId[r.rep_id] = parseFloat(r.outstanding_balance); });

  const missing = reps.filter(r => !(r.id in snapByRepId));
  if (missing.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of missing) {
        const bal = live[r.netsuite_name] || 0;
        await client.query(
          `INSERT INTO rep_debt_snapshots (rep_id, year, month, outstanding_balance)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (rep_id, year, month) DO NOTHING`,
          [r.id, year, month, bal]
        );
        snapByRepId[r.id] = bal;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  const result = {};
  reps.forEach(r => { result[r.netsuite_name] = snapByRepId[r.id] ?? 0; });
  return result;
}

module.exports = { isClosedMonth, getRepBalances };
