'use strict';

const express = require('express');
const router = express.Router();
const MarketingLead = require('../models/MarketingLead');
const { sendMarketingLeadEmail } = require('../services/emailService');

// Public, unauthenticated by design — these back the marketing website's
// (flash-website-rebuild) waitlist, contact, and driver/seller application
// forms, which have no login of their own. Same validation contract as the
// original flash-server implementation (routes/waitlist.js, contact.js,
// applications.js) that these replace, so the frontend needs no changes
// beyond pointing VITE_API_URL at this backend.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set(['customer', 'seller', 'driver']);
const VALID_SUBJECTS = new Set([
  'general',
  'customer-support',
  'seller-enquiry',
  'driver-enquiry',
  'investment',
  'press',
]);
const MAX_LEN = { name: 120, city: 60, message: 2000 };

router.post('/waitlist', async (req, res) => {
  const { email, role } = req.body || {};

  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (role !== undefined && !VALID_ROLES.has(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanRole = role || 'customer';

  try {
    const row = await MarketingLead.addWaitlistSignup(cleanEmail, cleanRole);
    sendMarketingLeadEmail({ kind: 'waitlist', email: cleanEmail, role: cleanRole })
      .catch((err) => console.error('[Marketing] waitlist notify email failed:', err.message));
    return res.status(201).json({ status: 'joined', id: row.id });
  } catch (err) {
    console.error('[Marketing] waitlist write failed:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/contact', async (req, res) => {
  const { name, email, subject, message } = req.body || {};

  if (typeof name !== 'string' || !name.trim() || name.length > MAX_LEN.name) {
    return res.status(400).json({ error: 'Please enter your name.' });
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (subject !== undefined && !VALID_SUBJECTS.has(subject)) {
    return res.status(400).json({ error: 'Invalid subject.' });
  }
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_LEN.message) {
    return res.status(400).json({ error: 'Please enter a message.' });
  }

  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  const cleanSubject = subject || 'general';
  const cleanMessage = message.trim();

  try {
    const row = await MarketingLead.addContactMessage(cleanName, cleanEmail, cleanSubject, cleanMessage);
    sendMarketingLeadEmail({
      kind: 'contact', name: cleanName, email: cleanEmail, subject: cleanSubject, message: cleanMessage,
    }).catch((err) => console.error('[Marketing] contact notify email failed:', err.message));
    return res.status(201).json({ status: 'received', id: row.id });
  } catch (err) {
    console.error('[Marketing] contact message write failed:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

function validateApplication(body) {
  const { name, email, city, message } = body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_LEN.name) {
    return 'Please enter your name.';
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return 'Please enter a valid email address.';
  }
  if (city !== undefined && (typeof city !== 'string' || city.length > MAX_LEN.city)) {
    return 'Invalid city.';
  }
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_LEN.message) {
    return 'Please enter a short message.';
  }
  return null;
}

async function handleApplication(applicantType, req, res) {
  const error = validateApplication(req.body);
  if (error) return res.status(400).json({ error });

  const { name, email, city, message } = req.body;
  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  const cleanCity = (city || '').trim();
  const cleanMessage = message.trim();

  try {
    const row = await MarketingLead.addApplication(applicantType, cleanName, cleanEmail, cleanCity, cleanMessage);
    sendMarketingLeadEmail({
      kind: 'application', applicantType, name: cleanName, email: cleanEmail, city: cleanCity, message: cleanMessage,
    }).catch((err) => console.error(`[Marketing] ${applicantType} application notify email failed:`, err.message));
    return res.status(201).json({ status: 'received', id: row.id });
  } catch (err) {
    console.error(`[Marketing] ${applicantType} application write failed:`, err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

router.post('/applications/driver', (req, res) => handleApplication('driver', req, res));
router.post('/applications/seller', (req, res) => handleApplication('seller', req, res));

module.exports = router;
