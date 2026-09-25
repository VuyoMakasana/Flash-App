'use strict';

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { storeOnboardingLimiter } = require('../middleware/rateLimiter');
const StoreOnboardingController = require('../controllers/storeOnboardingController');

// Phase 3 — public store-onboarding application.
//
// Deliberately unauthenticated: this is how a business that has no Flash
// relationship yet asks for one, the same way /api/auth/driver/register works
// for drivers. It grants nothing on its own -- the store and its owner account
// are both created inactive, and only an admin approval turns them on.
//
// There is no corresponding "check my application status" endpoint on purpose.
// Any such lookup, keyed by an email an applicant already knows, would let
// anyone test which businesses have applied.
router.post(
  '/apply',
  storeOnboardingLimiter,
  [
    body('store_name').trim().isLength({ min: 2, max: 200 }),
    body('owner_name').trim().isLength({ min: 2, max: 200 }),
    body('owner_email').isEmail().normalizeEmail(),
    body('owner_phone').optional({ checkFalsy: true }).trim().isLength({ max: 20 }),
    body('address').optional({ checkFalsy: true }).trim().isLength({ max: 500 }),
  ],
  StoreOnboardingController.apply,
);

module.exports = router;
