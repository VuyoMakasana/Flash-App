'use strict';

// Step 1 (#102), audit P0-5: removes the customer's delivery code
// (cash_otp_plain, cash_otp_hash) from every JSON response, wherever an
// order object appears in it. See utils/orderSecrets.js for why this is done
// once, centrally, instead of in each query.

const { stripOrderSecrets } = require('../utils/orderSecrets');

function stripOrderSecretsMiddleware(req, res, next) {
  const sendJson = res.json.bind(res);
  res.json = (body) => sendJson(stripOrderSecrets(body));
  next();
}

module.exports = { stripOrderSecretsMiddleware };
