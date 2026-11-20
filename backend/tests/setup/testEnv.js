'use strict';

// L0.1 (#69): jest `setupFiles` bootstrap. It runs before every test file.
//
// 1. If backend/.env.test exists, load it. Variables already set in the
//    environment win (CI sets its own), so a local file can never override
//    CI.
// 2. Refuse the whole run unless the database is local and any Paystack key
//    is a TEST key (assertLocalTestEnv).
//
// backend/.env (the app's own env file) is deliberately NOT loaded here.

const path = require('path');
const fs = require('fs');
const { assertLocalTestEnv } = require('./assertLocalTestEnv');

const envTestPath = path.resolve(__dirname, '..', '..', '.env.test');
if (fs.existsSync(envTestPath)) {
  require('dotenv').config({ path: envTestPath, override: false });
}

assertLocalTestEnv(process.env);
