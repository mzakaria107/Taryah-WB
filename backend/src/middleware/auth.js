const jwt = require('jsonwebtoken');

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

// Applies region filter: non-super_admin users only see their region
function applyRegionFilter(req, _res, next) {
  if (req.user.role !== 'super_admin' && req.user.region_id) {
    req.regionFilter = req.user.region_id;
  } else {
    req.regionFilter = null; // all regions
  }
  next();
}

module.exports = { verifyToken, requireRoles, applyRegionFilter };
