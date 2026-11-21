'use strict';

// Admin hardening (#87): the one admin credential check, used by BOTH admin
// logins (AdminJS /admin-panel/login and POST /api/admin/login), so they
// can't drift apart.
//   A1b  per-account lockout (5 failures in 15 minutes; adminLoginLockout)
//   A4   only role = 'admin' may log in; any other role is refused like a
//        wrong password, and counts as a failure
//   A7   an unknown email still costs one bcrypt comparison, against a dummy
//        hash, so response time doesn't reveal which emails are admins
// Result: { ok: true, admin } | { ok: false, reason: 'invalid' | 'locked' }.
// `admin` never includes password_hash.

const bcrypt = require('bcryptjs');
const { adminLoginLockout } = require('./adminLoginLockout');

// bcrypt (cost 12) of 32 random bytes that were discarded: it matches no
// password, and is not a secret. Same cost as real hashes, so the dummy
// comparison takes the same time.
const DUMMY_BCRYPT_HASH = '$2a$12$6kfWkJOlUs8TuMZ.l5JESeXyHLomWzy3EwN9Vn3yRyIfdzC3C8aey';

function createAdminCredentials({ Admin, lockout = adminLoginLockout, compare = (p, h) => bcrypt.compare(p, h) } = {}) {
  if (!Admin) Admin = require('../models/Admin');
  return async function verifyAdminCredentials(email, password) {
    // The lockout key ignores case and spaces (variants share one counter).
    // The lookup keeps today's behaviour, an exact match on the email as typed
    // (only trimmed), so an admin whose stored email has capitals can still log in.
    const typed = String(email ?? '').trim();
    const normalized = typed.toLowerCase();
    if (await lockout.isLocked(normalized)) return { ok: false, reason: 'locked' };

    const row = typed ? await Admin.findByEmail(typed) : null;
    const passwordOk = await compare(String(password ?? ''), row && row.password_hash ? row.password_hash : DUMMY_BCRYPT_HASH);

    if (!row || !passwordOk || row.role !== 'admin') {
      await lockout.recordFailure(normalized);
      return { ok: false, reason: 'invalid' };
    }
    await lockout.recordSuccess(normalized);
    return { ok: true, admin: { id: row.id, email: row.email, name: row.name, role: row.role } };
  };
}

const verifyAdminCredentials = createAdminCredentials();

module.exports = { createAdminCredentials, verifyAdminCredentials, DUMMY_BCRYPT_HASH };
