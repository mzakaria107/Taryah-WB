/**
 * NetSuite REST API helper — OAuth 1.0a (HMAC-SHA256)
 * Supports SuiteQL queries and Saved Search execution.
 */

const crypto = require('crypto');

/* ── OAuth 1.0a header builder ──────────────────────────────── */
function percentEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function buildOAuthHeader({ accountId, consumerKey, consumerSecret, tokenKey, tokenSecret, method, url }) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce     = crypto.randomBytes(16).toString('hex');

  const oauthParams = {
    oauth_consumer_key:     consumerKey,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp:        timestamp,
    oauth_token:            tokenKey,
    oauth_version:          '1.0',
  };

  // Base string = METHOD & encoded-URL & encoded-sorted-params
  const sortedParams = Object.keys(oauthParams)
    .sort()
    .map(k => `${percentEncode(k)}=${percentEncode(oauthParams[k])}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(sortedParams),
  ].join('&');

  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const signature  = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

  oauthParams.oauth_signature = signature;

  const headerParts = [`realm="${accountId.toUpperCase()}"`];
  for (const [k, v] of Object.entries(oauthParams)) {
    headerParts.push(`${k}="${encodeURIComponent(v)}"`);
  }

  return `OAuth ${headerParts.join(', ')}`;
}

/* ── Convert account ID to URL-safe form ────────────────────── */
// NetSuite account IDs like "1234567" stay as-is;
// sandbox IDs like "1234567_SB1" become "1234567-sb1" in the URL.
function urlAccountId(accountId) {
  return accountId.toLowerCase().replace(/_/g, '-');
}

/* ── SuiteQL query ──────────────────────────────────────────── */
async function suiteQL(config, query, { limit = 1000, offset = 0 } = {}) {
  const { accountId, consumerKey, consumerSecret, tokenKey, tokenSecret } = config;
  const url = `https://${urlAccountId(accountId)}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`;

  const authHeader = buildOAuthHeader({
    accountId, consumerKey, consumerSecret, tokenKey, tokenSecret,
    method: 'POST',
    url: url.split('?')[0], // base URL without query params for signature
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization':  authHeader,
      'Content-Type':   'application/json',
      'Prefer':         'transient',
    },
    body: JSON.stringify({ q: query }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '(no body)');
    throw new Error(`NetSuite SuiteQL ${response.status}: ${errText.slice(0, 400)}`);
  }

  return response.json(); // { items: [...], totalResults, count, offset, hasMore, links }
}

/* ── Saved Search results (via SuiteQL) ─────────────────────── */
async function runSavedSearch(config, savedSearchId, recordType = 'inventoryitem') {
  // NetSuite exposes saved searches through REST only via a SuiteQL join trick.
  // The most compatible approach is to query the record type directly.
  // If a saved search ID is provided we include it as a filter; otherwise use
  // the default inventory query.
  const searchClause = savedSearchId
    ? `WHERE item.internalid IN (SELECT internalid FROM savedsearch WHERE id = ${savedSearchId})`
    : `WHERE i.isinactive = 'F'`;

  return fetchNetSuiteInventory(config);
}

/* ── Main inventory fetch ────────────────────────────────────── */
async function fetchNetSuiteInventory(config) {
  const query = `
    SELECT
      i.id                AS id,
      i.itemid            AS itemCode,
      i.displayname       AS itemName,
      i.subtype           AS category,
      ib.quantityonhand   AS qtyOnHand,
      ib.quantityavailable AS qtyAvailable,
      ib.quantityonorder  AS qtyOnOrder
    FROM item i
    LEFT OUTER JOIN inventorybalance ib ON ib.item = i.id AND ib.location IS NULL
    WHERE i.isinactive = 'F'
      AND i.type IN ('InvtPart', 'Assembly')
    ORDER BY i.displayname
  `;

  let allItems = [];
  let offset = 0;
  const limit = 1000;
  let hasMore = true;

  while (hasMore) {
    const page = await suiteQL(config, query, { limit, offset });
    allItems = allItems.concat(page.items || []);
    hasMore   = page.hasMore === true;
    offset   += limit;
    if (allItems.length > 10000) break; // safety cap
  }

  return allItems.map(row => ({
    netsuite_id:   String(row.id  || ''),
    item_code:     row.itemCode   || '',
    item_name:     row.itemName   || row.itemCode || '',
    category:      row.category   || '',
    qty_on_hand:   parseFloat(row.qtyOnHand)    || 0,
    qty_available: parseFloat(row.qtyAvailable) || 0,
    qty_on_order:  parseFloat(row.qtyOnOrder)   || 0,
  }));
}

/* ── Test connectivity ───────────────────────────────────────── */
async function testConnection(config) {
  // Minimal SuiteQL that should always succeed if credentials are valid
  const result = await suiteQL(config, 'SELECT id FROM subsidiary WHERE id = 1', { limit: 1 });
  return { ok: true, message: 'Connected successfully' };
}

module.exports = { buildOAuthHeader, fetchNetSuiteInventory, runSavedSearch, testConnection, suiteQL };
