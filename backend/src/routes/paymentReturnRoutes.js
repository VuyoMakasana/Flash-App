'use strict';

// Step 1 (#102), FI-119: where Paystack sends the customer's browser after
// the hosted payment page (paystackService's callback_url).
//
// It used to be APP_URL/payment/callback, which is the marketing site's
// "coming soon" page. This page is deliberately static:
//   - it never reads or echoes the query string (Paystack appends
//     ?trxref=…&reference=…), so it exposes no data and can't be used to
//     reflect content;
//   - it states nothing about the payment's outcome, because Paystack can
//     send the customer here after a cancelled attempt too. The app confirms
//     the outcome with the backend when the customer returns
//     (flash-user-app/hooks/usePaymentConfirmation.js);
//   - no script, no external resources, not cached, not indexed.

const express = require('express');

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Return to Flash</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0A0A0A; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 360px; padding: 32px 24px; text-align: center; }
  .mark { font-size: 32px; font-weight: 900; letter-spacing: 6px; color: #F59E0B; margin-bottom: 24px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { color: #D1D5DB; font-size: 16px; line-height: 1.5; margin: 0 0 12px; }
</style>
</head>
<body>
<main>
  <div class="mark">FLASH</div>
  <h1>You can go back to Flash now</h1>
  <p>Close this page and open the Flash app. If you paid, we're confirming it now and your order will update there.</p>
  <p>You won't be charged twice.</p>
</main>
</body>
</html>`;

function createPaymentReturnRouter() {
  const router = express.Router();
  router.get('/payment/return', (req, res) => {
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    });
    res.status(200).send(PAGE);
  });
  return router;
}

// Where Paystack should send the customer. PAYSTACK_CALLBACK_URL is an
// optional override (e.g. a staging host); production defaults to the API's
// own public address.
function paymentReturnUrl() {
  if (process.env.PAYSTACK_CALLBACK_URL) return process.env.PAYSTACK_CALLBACK_URL;
  if (process.env.NODE_ENV === 'production') return 'https://api.flashdelivery.co.za/payment/return';
  return `http://localhost:${process.env.PORT || 3000}/payment/return`;
}

module.exports = { createPaymentReturnRouter, paymentReturnUrl, PAGE };
