// backend/src/services/emailService.js
// Install: npm install nodemailer   (run inside backend/)
'use strict';

const nodemailer = require('nodemailer');

// Build transporter once at module load.
// Reads SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS from environment.
// Falls back to a "test account" logger in development when SMTP is not configured.
function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    // Development fallback: just log emails to console instead of sending them.
    return null;
  }

  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465', // true for 465, false for 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: process.env.NODE_ENV === 'production',
    },
    // CRITICAL FIX: nodemailer has no timeout by default, so a wrong host/port
    // or blocked outbound connection hangs the underlying socket for minutes
    // instead of failing fast — confirmed live: a bad SMTP config left
    // /register and /resend-verification hanging past 170s with no response,
    // since both awaited this send directly in the request path.
    connectionTimeout: 10_000,
    greetingTimeout:   10_000,
    socketTimeout:     10_000,
  });
}

const transporter = createTransporter();
const FROM_ADDRESS = process.env.EMAIL_FROM || 'Flash <makasanaivyson@gmail.com>';
const APP_URL      = process.env.APP_URL    || 'http://localhost:3000';

async function sendEmail({ to, subject, html, text }) {
  if (!transporter) {
    // Dev mode — no SMTP configured. Print to console so you can still test.
    console.log('[Email] DEV MODE — would send email:');
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body:    ${text || '(html only)'}`);
    return { messageId: 'dev-mode-no-send' };
  }

  const info = await transporter.sendMail({
    from:    FROM_ADDRESS,
    to,
    subject,
    html,
    text,
  });

  console.log(`[Email] Sent to ${to} — messageId: ${info.messageId}`);
  return info;
}

// ─── Password Reset ────────────────────────────────────────────────────────

async function sendPasswordResetEmail(toEmail, resetToken) {
  // The mobile app deep-link opens this URL and reads the token from the URL.
  // Format: flash://reset-password?token=<token>
  // For web admin: APP_URL/reset-password?token=<token>
  const resetLink = `${APP_URL}/reset-password?token=${encodeURIComponent(resetToken)}`;
  const deepLink  = `flash://reset-password?token=${encodeURIComponent(resetToken)}`;

  return sendEmail({
    to:      toEmail,
    subject: 'Reset your Flash password',
    text:    `You requested a password reset.\n\nPaste this link in your browser:\n${resetLink}\n\nOr open the Flash app and enter this code manually:\n${resetToken}\n\nThis link expires in 1 hour. If you did not request this, ignore this email.`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:sans-serif;background:#f5f5f5;padding:20px;margin:0">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px">
    <div style="text-align:center;margin-bottom:24px">
      <div style="display:inline-block;background:#0a0a0a;border-radius:16px;padding:16px">
        <span style="color:#fff;font-size:28px;font-weight:900;letter-spacing:4px">FLASH</span>
      </div>
    </div>
    <h2 style="color:#111827;margin-top:0">Reset your password</h2>
    <p style="color:#6b7280">You requested a password reset for your Flash account. Tap the button below to set a new password.</p>
    <div style="text-align:center;margin:24px 0">
      <a href="${deepLink}" style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-weight:700;font-size:16px">Reset Password</a>
    </div>
    <p style="color:#9ca3af;font-size:13px">This link expires in <strong>1 hour</strong>. If you did not request this, ignore this email — your account is safe.</p>
    <p style="color:#9ca3af;font-size:12px;border-top:1px solid #f3f4f6;padding-top:16px;margin-bottom:0">
      Can't tap the button? Copy this link:<br>
      <span style="color:#6b7280;word-break:break-all">${resetLink}</span>
    </p>
  </div>
</body>
</html>`,
  });
}

// ─── Email Verification ────────────────────────────────────────────────────

async function sendEmailVerificationEmail(toEmail, verifyToken) {
  const verifyLink = `${APP_URL}/verify-email?token=${encodeURIComponent(verifyToken)}`;
  const deepLink   = `flash://verify-email?token=${encodeURIComponent(verifyToken)}`;

  return sendEmail({
    to:      toEmail,
    subject: 'Verify your Flash email address',
    text:    `Welcome to Flash!\n\nVerify your email address by opening this link:\n${verifyLink}\n\nOr open the Flash app and it will verify automatically.\nThis link expires in 24 hours.`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:sans-serif;background:#f5f5f5;padding:20px;margin:0">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px">
    <div style="text-align:center;margin-bottom:24px">
      <div style="display:inline-block;background:#0a0a0a;border-radius:16px;padding:16px">
        <span style="color:#fff;font-size:28px;font-weight:900;letter-spacing:4px">FLASH</span>
      </div>
    </div>
    <h2 style="color:#111827;margin-top:0">Verify your email</h2>
    <p style="color:#6b7280">Welcome to Flash! Tap the button below to confirm your email address and start ordering.</p>
    <div style="text-align:center;margin:24px 0">
      <a href="${deepLink}" style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-weight:700;font-size:16px">Verify Email</a>
    </div>
    <p style="color:#9ca3af;font-size:13px">This link expires in <strong>24 hours</strong>.</p>
    <p style="color:#9ca3af;font-size:12px;border-top:1px solid #f3f4f6;padding-top:16px;margin-bottom:0">
      Can't tap the button? Copy this link:<br>
      <span style="color:#6b7280;word-break:break-all">${verifyLink}</span>
    </p>
  </div>
</body>
</html>`,
  });
}

// ─── Returns — awaiting final review ───────────────────────────────────────
// Fired the instant a return's reverse-delivery order reaches 'completed'
// while the return itself is still 'approved' (i.e. dispatched but not yet
// finalized) — closes the gap where nothing would otherwise tell anyone a
// return is sitting ready for the manual refund/reject decision. There is
// no admin dashboard/app in this codebase, so email to ADMIN_EMAIL is the
// only currently-real notification channel.

async function sendReturnAwaitingReviewEmail({ returnId, orderNumber, refundAmount }) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn('[Email] ADMIN_EMAIL not configured — skipping return-awaiting-review notification');
    return null;
  }

  return sendEmail({
    to:      adminEmail,
    subject: `Return ready for final review — ${orderNumber}`,
    text:    `Return ${returnId} (order ${orderNumber}) has been delivered back to the store and is awaiting your final decision.\n\nRefund amount if approved: R${parseFloat(refundAmount).toFixed(2)}\n\nFinalize or reject via POST /api/returns/${returnId}/finalize-refund or /reject.`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:sans-serif;background:#f5f5f5;padding:20px;margin:0">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px">
    <div style="text-align:center;margin-bottom:24px">
      <div style="display:inline-block;background:#0a0a0a;border-radius:16px;padding:16px">
        <span style="color:#fff;font-size:28px;font-weight:900;letter-spacing:4px">FLASH</span>
      </div>
    </div>
    <h2 style="color:#111827;margin-top:0">Return ready for final review</h2>
    <p style="color:#6b7280">The item for order <strong>${orderNumber}</strong> has been delivered back to the store. It's awaiting your final decision — refund or reject.</p>
    <p style="color:#111827;font-size:20px;font-weight:800">R${parseFloat(refundAmount).toFixed(2)} <span style="color:#6b7280;font-size:13px;font-weight:400">refund if approved</span></p>
    <p style="color:#9ca3af;font-size:12px;border-top:1px solid #f3f4f6;padding-top:16px;margin-bottom:0">
      Return ID: ${returnId}
    </p>
  </div>
</body>
</html>`,
  });
}

module.exports = { sendPasswordResetEmail, sendEmailVerificationEmail, sendReturnAwaitingReviewEmail };
