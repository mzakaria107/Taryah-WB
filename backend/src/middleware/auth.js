const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'لم يتم توفير رمز المصادقة' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'رمز المصادقة غير صالح أو منتهي الصلاحية' });
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'ليس لديك صلاحية للوصول إلى هذا المورد' });
    }
    next();
  };
}

// Applies region filter: only super_admin and it_admin (+ a few HQ roles) see
// all regions. Everyone else is scoped to the set of regions assigned to
// them (a user can now have more than one). req.regionFilter is either:
//   - null            → no restriction, all regions
//   - an array of ids  → restrict to these regions (empty array = none)
function applyRegionFilter(req, _res, next) {
  const allRegionRoles = ['super_admin', 'it_admin', 'sales_manager', 'top_management', 'accounts'];
  if (!allRegionRoles.includes(req.user.role)) {
    const ids = Array.isArray(req.user.region_ids) && req.user.region_ids.length
      ? req.user.region_ids
      : (req.user.region_id ? [req.user.region_id] : []);
    req.regionFilter = ids;
  } else {
    req.regionFilter = null; // all regions
  }
  next();
}

// Checks a role's granted access_level for a page (from the page_permissions
// table managed on /permissions), instead of a hardcoded role list — so
// granting a role edit/view access there actually takes effect on the API.
// super_admin/it_admin always pass (mirrors PermissionsContext's frontend bypass).
function requirePagePermission(pageKey, minLevel = 1) {
  return async (req, res, next) => {
    if (['super_admin', 'it_admin'].includes(req.user.role)) return next();
    try {
      const { rows } = await pool.query(
        'SELECT access_level FROM page_permissions WHERE page_key = $1 AND role = $2',
        [pageKey, req.user.role]
      );
      const level = rows[0]?.access_level ?? 0;
      if (level < minLevel) {
        return res.status(403).json({ error: 'ليس لديك صلاحية للوصول إلى هذا المورد' });
      }
      next();
    } catch (err) {
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  };
}

module.exports = { verifyToken, requireRoles, applyRegionFilter, requirePagePermission };
