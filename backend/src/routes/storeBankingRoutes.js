'use strict';

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const {
  authenticateStore,
  requireOwnStore,
  requireStorePasswordCurrent,
  requireStoreRole,
} = require('../middleware/auth');
const { storeWriteLimiter } = require('../middleware/rateLimiter');
const StoreBankingController = require('../controllers/storeBankingController');

// Phase 2a — the store's payout destination.
//
// OWNER ONLY, and deliberately narrower than the Finance role's access
// elsewhere in this portal. Finance can see financials; redirecting where the
// money is SENT is a different privilege, and the founder's decision was
// explicit. requireStoreRole('owner') is the enforcement — the portal hiding
// the screen is not.
//
// authenticateStore also re-checks the store's live status on every request, so
// a suspended store cannot reach any of this even with a valid token.
router.use(
  authenticateStore,
  requireOwnStore,
  requireStorePasswordCurrent,
  requireStoreRole('owner'),
);

// What is on file. Never returns the recipient_code or an account number.
router.get('/', StoreBankingController.getDestination);

// The bank dropdown. Behind the same owner guard as the rest: it is only needed
// to render the form, and there is no reason for other roles to enumerate it.
router.get('/banks', StoreBankingController.listBanks);

// Set or replace the destination.
//
// account_number is validated for shape only — 6 to 20 digits covers South
// African account numbers without hardcoding a single bank's format. The real
// check is that the bank resolves it AND the holder's name matches, which the
// controller does; a length rule cannot establish that an account is real.
router.post(
  '/',
  storeWriteLimiter,
  [
    body('account_number').isString().trim().matches(/^[0-9]{6,20}$/)
      .withMessage('Enter the account number as digits only.'),
    body('bank_code').isString().trim().isLength({ min: 1, max: 20 }),
    body('account_name').isString().trim().isLength({ min: 2, max: 200 }),
    // Re-authentication. Not a length rule — any non-empty string, because the
    // real check is bcrypt against the stored hash, and imposing a minimum here
    // would reject a legacy password that is shorter than today's policy.
    body('password').isString().isLength({ min: 1 })
      .withMessage('Your password is required to change payout details.'),
  ],
  StoreBankingController.setDestination,
);

module.exports = router;
