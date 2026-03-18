const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');

const generateToken = (id, role) =>
  jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });

// ─────────────────────────────────────────
// USER REGISTER
// ─────────────────────────────────────────
router.post(
  '/user/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, password, phone } = req.body;

    try {
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      const password_hash = await bcrypt.hash(password, 12);

      const result = await pool.query(
        `INSERT INTO users (name, email, password_hash, phone)
         VALUES ($1, $2, $3, $4) RETURNING id, name, email, phone, terms_accepted, created_at`,
        [name, email, password_hash, phone || null]
      );

      const user = result.rows[0];
      const token = generateToken(user.id, 'user');

      res.status(201).json({ token, user });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Registration failed' });
    }
  }
);

// ─────────────────────────────────────────
// USER LOGIN
// ─────────────────────────────────────────
router.post(
  '/user/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;

    try {
      const result = await pool.query(
        'SELECT id, name, email, phone, password_hash, terms_accepted FROM users WHERE email = $1',
        [email]
      );

      if (!result.rows.length) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const user = result.rows[0];
      const match = await bcrypt.compare(password, user.password_hash);

      if (!match) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = generateToken(user.id, 'user');
      const { password_hash: _, ...safeUser } = user;

      res.json({ token, user: safeUser });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

// ─────────────────────────────────────────
// USER ACCEPT TERMS
// ─────────────────────────────────────────
router.post('/user/accept-terms', async (req, res) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });

  try {
    const token = header.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    await pool.query(
      'UPDATE users SET terms_accepted = true, terms_accepted_at = NOW() WHERE id = $1',
      [decoded.id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to accept terms' });
  }
});

// ─────────────────────────────────────────
// DRIVER REGISTER
// ─────────────────────────────────────────
router.post(
  '/driver/register',
  [
    body('name').trim().notEmpty(),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }),
    body('phone').notEmpty().withMessage('Phone number required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, password, phone, vehicle_type, vehicle_plate } = req.body;

    try {
      const existing = await pool.query('SELECT id FROM drivers WHERE email = $1', [email]);
      if (existing.rows.length) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      const password_hash = await bcrypt.hash(password, 12);

      const result = await pool.query(
        `INSERT INTO drivers (name, email, password_hash, phone, vehicle_type, vehicle_plate, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending_documents')
         RETURNING id, name, email, phone, vehicle_type, vehicle_plate, status, created_at`,
        [name, email, password_hash, phone, vehicle_type || null, vehicle_plate || null]
      );

      const driver = result.rows[0];
      // Give a temp token only for document upload — no dashboard access yet
      const token = generateToken(driver.id, 'driver');

      res.status(201).json({ token, driver });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Registration failed' });
    }
  }
);

// ─────────────────────────────────────────
// DRIVER LOGIN
// ─────────────────────────────────────────
router.post(
  '/driver/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;

    try {
      const result = await pool.query(
        'SELECT id, name, email, phone, password_hash, status, vehicle_type, vehicle_plate, profile_photo_url, rating, is_online FROM drivers WHERE email = $1',
        [email]
      );

      if (!result.rows.length) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const driver = result.rows[0];
      const match = await bcrypt.compare(password, driver.password_hash);

      if (!match) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Block login if not approved
      if (driver.status !== 'approved') {
        const messages = {
          pending_documents: 'Please upload your required documents to continue.',
          documents_submitted: 'Your documents are under review. You will be notified once approved.',
          under_review: 'Your application is being reviewed by our team.',
          rejected: 'Your driver application was not approved. Please contact support.',
        };
        return res.status(403).json({
          error: messages[driver.status] || 'Account not approved',
          status: driver.status,
        });
      }

      const token = generateToken(driver.id, 'driver');
      const { password_hash: _, ...safeDriver } = driver;

      res.json({ token, driver: safeDriver });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

module.exports = router;
