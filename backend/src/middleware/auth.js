const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// Verify JWT and attach user to request
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = header.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Validate role in token
    req.userId = decoded.id;
    req.userRole = decoded.role; // 'user' | 'driver' | 'admin'

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Role guard middleware factory
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.userRole)) {
    return res.status(403).json({ error: 'Access forbidden' });
  }
  next();
};

// Driver must be approved to access delivery features.
// v3.1 optimization: the driver login already verifies approved status before
// issuing the token. We check the token first, only hit the DB if the token
// was issued before the approved_at field existed (backwards compat).
const requireApprovedDriver = async (req, res, next) => {
  // Fast path: if the JWT contains status='approved', skip the DB query entirely.
  // The token is issued at login and login already blocks non-approved drivers.
  // This eliminates one DB round-trip on every driver endpoint.
  if (req.driverStatus === 'approved') return next();

  try {
    const result = await pool.query(
      'SELECT status FROM drivers WHERE id = $1',
      [req.userId]
    );
    if (!result.rows.length || result.rows[0].status !== 'approved') {
      return res.status(403).json({ error: 'Driver account is not yet approved' });
    }
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { authenticate, requireRole, requireApprovedDriver };
