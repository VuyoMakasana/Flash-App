// backend/src/services/emailService.js
// Install: npm install nodemailer   (run inside backend/)
'use strict';

const nodemailer = require('nodemailer');
const pool = require('../config/database');

// FLASH — deploy/Sentry/admin-email pass: real, individual admin accounts
// have existed since Phase 0 (the `admins` table), but these operational
// notifications were still pointed at a static ADMIN_EMAIL env var left
// over from the old single-shared-credential model. Reading the real
// admins table means adding a second admin later automatically notifies
// them too, with no config change — the env var could only ever reach one
// inbox. Notifies every real admin (there is exactly one today); per-admin
// routing (e.g. only whoever handled a related record) is a natural,
// separate extension for once there's more than one, not built here.
async function getAdminEmails() {
  try {
    const result = await pool.query('SELECT email FROM admins ORDER BY created_at ASC');
    return result.rows.map((r) => r.email);
  } catch (err) {
    console.error('[Email] Failed to look up admin emails from database:', err.message);
    return [];
  }
}

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
const FROM_ADDRESS = process.env.EMAIL_FROM || 'Flash <noreply@flashdelivery.co.za>';
const APP_URL      = process.env.APP_URL    || 'http://localhost:3000';
// The Store Admin Portal is a separate deployment from this backend, so it is
// NOT APP_URL (which points at the public app domain, not at the portal).
// Defaulted rather than required so the reset email keeps working without extra
// configuration; override once the portal moves to its own subdomain.
const STORE_PORTAL_URL = process.env.STORE_PORTAL_URL || 'https://flash-store-portal.onrender.com';

// Resend's HTTP API key. Resend's SMTP password IS the API key, so an existing
// SMTP-configured deployment needs no new environment variable — but
// RESEND_API_KEY is preferred where it's set, because naming the thing it
// actually is beats inheriting it from an SMTP field.
const RESEND_API_KEY = process.env.RESEND_API_KEY
  || (/(^|\.)resend\.com$/i.test(process.env.SMTP_HOST || '') ? process.env.SMTP_PASS : null);

// Send over Resend's HTTPS API (port 443) instead of SMTP.
//
// Why this exists: Render blocks outbound traffic on SMTP ports 25, 465 and
// 587 for free web services, so nodemailer could never open a TCP connection
// at all from this deployment. It failed at connectionTimeout every time --
// "Connection timeout", ~10s, before auth or TLS was even attempted. Confirmed
// live in production, and confirmed against Render's own changelog. Resend
// itself was never the problem: all five of its SMTP ports answer from an
// unrestricted network, and its HTTPS API responds in under a second.
//
// Port 443 is not, and realistically will not be, blocked. This also returns a
// structured JSON error on failure rather than a socket timeout, which is what
// makes the silent-failure problem fixable at all.
async function sendViaResendApi({ to, subject, html, text }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html, text }),
    // Belt and braces: fetch has no default timeout either, and this runs in a
    // fire-and-forget path where a hung request would leak quietly.
    signal: AbortSignal.timeout(15_000),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Surface Resend's own message -- it is specific and actionable (an
    // unverified sending domain, for instance, says exactly that).
    throw new Error(
      `Resend API ${response.status}: ${payload.message || payload.name || 'unknown error'}`,
    );
  }

  return { messageId: payload.id, via: 'resend-api' };
}

async function sendEmail({ to, subject, html, text }) {
  // Preferred path. Tried first wherever an API key is available, because SMTP
  // is unreachable from this platform (see sendViaResendApi above).
  if (RESEND_API_KEY) {
    const info = await sendViaResendApi({ to, subject, html, text });
    console.log(`[Email] Sent to ${to} via Resend API — id: ${info.messageId}`);
    return info;
  }

  if (!transporter) {
    // Dev mode — nothing configured. Print to console so you can still test.
    console.log('[Email] DEV MODE — would send email:');
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body:    ${text || '(html only)'}`);
    return { messageId: 'dev-mode-no-send' };
  }

  // Retained for any deployment using a non-Resend SMTP provider, or one on a
  // network that permits SMTP egress.
  const info = await transporter.sendMail({
    from:    FROM_ADDRESS,
    to,
    subject,
    html,
    text,
  });

  console.log(`[Email] Sent to ${to} via SMTP — messageId: ${info.messageId}`);
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
// return is sitting ready for the manual refund/reject decision. Email to
// every real admin (getAdminEmails, above) is the only currently-real
// notification channel — there is no in-app admin push/socket alert today.

async function sendReturnAwaitingReviewEmail({ returnId, orderNumber, refundAmount }) {
  const adminEmails = await getAdminEmails();
  if (!adminEmails.length) {
    console.warn('[Email] No admin accounts found — skipping return-awaiting-review notification');
    return null;
  }

  return sendEmail({
    to:      adminEmails,
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

// ─── SOS alert — immediate, regardless of who's watching the panel ────────
// Addendum 2 §4's own notification tiering named this as the single most
// important item to wire up first: before this, an SOS alert only ever
// reached a live Socket.io connection to the 'admin' room (sosController.js's
// io.to('admin').emit) — missed entirely if nobody had the panel open at
// that exact moment. Email fires regardless, the same way
// sendReturnAwaitingReviewEmail already proved out for returns.

async function sendSosAlertEmail({ alertId, orderId, orderNumber, triggeredByRole, pickupAddress, dropoffAddress, lat, lng }) {
  const adminEmails = await getAdminEmails();
  if (!adminEmails.length) {
    console.warn('[Email] No admin accounts found — skipping SOS alert notification');
    return null;
  }

  const mapsLink = (lat != null && lng != null)
    ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
    : null;

  return sendEmail({
    to:      adminEmails,
    subject: `SOS ALERT — order ${orderNumber || orderId}`,
    text:    `An SOS alert was just triggered by a ${triggeredByRole} on order ${orderNumber || orderId}.\n\n`
      + `Pickup: ${pickupAddress || '(not recorded)'}\nDropoff: ${dropoffAddress || '(not recorded)'}\n`
      + (mapsLink ? `Live location: ${mapsLink}\n` : 'Live location: not provided\n')
      + `\nAlert ID: ${alertId}\nAcknowledge it in the admin panel as soon as you've responded.`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:sans-serif;background:#f5f5f5;padding:20px;margin:0">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;border:3px solid #C20012">
    <div style="text-align:center;margin-bottom:24px">
      <div style="display:inline-block;background:#C20012;border-radius:16px;padding:16px">
        <span style="color:#fff;font-size:24px;font-weight:900;letter-spacing:2px">SOS ALERT</span>
      </div>
    </div>
    <p style="color:#111827;font-size:16px">Triggered by a <strong>${triggeredByRole}</strong> on order <strong>${orderNumber || orderId}</strong>.</p>
    <p style="color:#6b7280;margin-bottom:4px"><strong>Pickup:</strong> ${pickupAddress || '(not recorded)'}</p>
    <p style="color:#6b7280;margin-top:0"><strong>Dropoff:</strong> ${dropoffAddress || '(not recorded)'}</p>
    ${mapsLink ? `<div style="text-align:center;margin:24px 0"><a href="${mapsLink}" style="display:inline-block;background:#C20012;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-weight:700;font-size:16px">Open Live Location</a></div>` : '<p style="color:#9ca3af">No location data was provided.</p>'}
    <p style="color:#9ca3af;font-size:12px;border-top:1px solid #f3f4f6;padding-top:16px;margin-bottom:0">
      Alert ID: ${alertId} — acknowledge it in the admin panel as soon as you've responded.
    </p>
  </div>
</body>
</html>`,
  });
}

// ─── Store missed-order reliability (§2.12 audit) ──────────────────────────
// Same reasoning as sendSosAlertEmail directly above: a live
// io.to('admin') socket alert is real, but nothing if the panel isn't
// open at that exact moment. A new order reaching pending_store_
// acceptance previously had no admin-facing signal at all -- not even a
// socket alert, let alone this durable fallback. Not fired on every
// order (that would just become noise to ignore at real volume) -- only
// once an order has actually been sitting long enough that it's at real
// risk of being auto-cancelled, and again, distinctly, if that auto-
// cancellation actually happens.
const ESCALATION_STAGE_LABEL = {
  acceptance:  'awaiting store acceptance',
  preparation: 'marked ready for pickup',
};

async function sendOrderEscalationEmail({ id, order_number, total }, stage) {
  const adminEmails = await getAdminEmails();
  if (!adminEmails.length) {
    console.warn('[Email] No admin accounts found — skipping order escalation notification');
    return null;
  }
  const stageLabel = ESCALATION_STAGE_LABEL[stage] || stage;
  const amount = parseFloat(total || 0).toFixed(2);

  return sendEmail({
    to:      adminEmails,
    subject: `Action needed — order ${order_number} still ${stageLabel}`,
    text:    `Order ${order_number} (R${amount}) has been ${stageLabel} for a while and will be automatically `
      + `cancelled and refunded soon if nobody acts on it.\n\nHandle it now in the admin panel: order ID ${id}.`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:sans-serif;background:#f5f5f5;padding:20px;margin:0">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;border:2px solid #f59e0b">
    <h2 style="color:#111827;margin-top:0">Action needed — order ${order_number}</h2>
    <p style="color:#6b7280">This order has been <strong>${stageLabel}</strong> for a while now and will be automatically cancelled and refunded soon if nobody acts on it.</p>
    <p style="color:#111827;font-size:20px;font-weight:800">R${amount}</p>
    <p style="color:#9ca3af;font-size:12px;border-top:1px solid #f3f4f6;padding-top:16px;margin-bottom:0">
      Order ID: ${id}
    </p>
  </div>
</body>
</html>`,
  });
}

async function sendOrderMissedEmail({ id, order_number, total }, stage) {
  const adminEmails = await getAdminEmails();
  if (!adminEmails.length) {
    console.warn('[Email] No admin accounts found — skipping missed-order notification');
    return null;
  }
  const stageLabel = ESCALATION_STAGE_LABEL[stage] || stage;
  const amount = parseFloat(total || 0).toFixed(2);

  return sendEmail({
    to:      adminEmails,
    subject: `Missed order — ${order_number} was auto-cancelled`,
    text:    `Order ${order_number} (R${amount}) was automatically cancelled just now because it was never `
      + `${stageLabel} in time. The customer has already been notified and refunded in full.\n\nOrder ID: ${id}.`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:sans-serif;background:#f5f5f5;padding:20px;margin:0">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;border:2px solid #C20012">
    <h2 style="color:#111827;margin-top:0">Missed order — ${order_number}</h2>
    <p style="color:#6b7280">This order was just automatically cancelled because it was never <strong>${stageLabel}</strong> in time. The customer has already been notified and refunded in full.</p>
    <p style="color:#111827;font-size:20px;font-weight:800">R${amount} <span style="color:#6b7280;font-size:13px;font-weight:400">refunded</span></p>
    <p style="color:#9ca3af;font-size:12px;border-top:1px solid #f3f4f6;padding-top:16px;margin-bottom:0">
      Order ID: ${id}
    </p>
  </div>
</body>
</html>`,
  });
}

// ─── Marketing site leads (waitlist / contact / driver+seller applications) ─
// Same notification shape as sendReturnAwaitingReviewEmail / sendSosAlertEmail
// above — email to every real admin, since there is no other real-time
// channel for these (no admin currently has the panel open watching for a
// new public-site submission the way an order/return is watched).
async function sendMarketingLeadEmail({ kind, email, role, name, subject, message, applicantType, city }) {
  const adminEmails = await getAdminEmails();
  if (!adminEmails.length) {
    console.warn('[Email] No admin accounts found — skipping marketing lead notification');
    return null;
  }

  let subjectLine, textBody, htmlBody;

  if (kind === 'waitlist') {
    subjectLine = `New early-access signup — ${email}`;
    textBody = `${email} joined the FLASH early-access list as a ${role}.`;
    htmlBody = `<p><strong>${escapeHtmlLite(email)}</strong> joined the FLASH early-access list as a <strong>${escapeHtmlLite(role)}</strong>.</p>`;
  } else if (kind === 'contact') {
    subjectLine = `New contact message — ${subject} (${name})`;
    textBody = `From: ${name} <${email}>\nSubject: ${subject}\n\n${message}`;
    htmlBody = `<p><strong>${escapeHtmlLite(name)}</strong> (${escapeHtmlLite(email)}) — subject: <strong>${escapeHtmlLite(subject)}</strong></p><p>${escapeHtmlLite(message).replace(/\n/g, '<br>')}</p>`;
  } else if (kind === 'application') {
    subjectLine = `New ${applicantType} application — ${name}`;
    textBody = `${name} <${email}> applied to be a ${applicantType}${city ? ` (${city})` : ''}.\n\n${message}`;
    htmlBody = `<p><strong>${escapeHtmlLite(name)}</strong> (${escapeHtmlLite(email)}) applied to be a <strong>${escapeHtmlLite(applicantType)}</strong>${city ? ` in ${escapeHtmlLite(city)}` : ''}.</p><p>${escapeHtmlLite(message).replace(/\n/g, '<br>')}</p>`;
  } else {
    return null;
  }

  return sendEmail({
    to:      adminEmails,
    subject: subjectLine,
    text:    textBody,
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
    <h2 style="color:#111827;margin-top:0">${escapeHtmlLite(subjectLine)}</h2>
    <div style="color:#374151">${htmlBody}</div>
    <p style="color:#9ca3af;font-size:12px;border-top:1px solid #f3f4f6;padding-top:16px;margin-bottom:0">
      From the flashdelivery.co.za marketing site — visible in the admin panel.
    </p>
  </div>
</body>
</html>`,
  });
}

// Minimal escaping — same purpose as adminPanel.js's own escapeHtml, kept
// local here since these two files don't otherwise share helpers.
function escapeHtmlLite(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────────
// STORE PORTAL EMAILS (ported from test/close-coverage-gaps, store subset only).
// That branch's sendAdminPasswordResetEmail is deliberately NOT ported: it
// belongs to the admin password-reset feature, which has no routes, no
// controller methods and no admin_password_tokens table on this line.
// ─── Store Password Reset (Admin Platform Phase 3) ─────────────────────────
// Phase 1 fix: this used to instruct the recipient to "submit it with a POST
// request to /api/store-auth/reset-password". That was written before the
// portal had a reset page, and no real store owner can act on it. The portal
// now has /reset-password (a paste-the-code form), so the email links there.
// The raw code is still shown, because that page asks for it explicitly.
// Subject lines for the two store-account emails whose delivery Flash needs to
// be able to see. They live here as constants because TWO places depend on the
// exact string: the senders below, and the Resend webhook handler, which maps a
// bounce back to the kind of email that bounced (webhookController.handleResend).
//
// Same reasoning as STORE_STATUS_TRANSITIONS in models/Store.js -- if the
// sender and the consumer each spelled the subject out separately, editing one
// would silently stop bounces being attributed, and nothing would fail. A test
// asserts the senders actually use these.
const EMAIL_SUBJECTS = {
  STORE_WELCOME: 'Your Flash Store Portal account is ready',
  STORE_PASSWORD_RESET: 'Reset your Flash store account password',
};

// Maps a subject back to the store_users columns it should update. Used only by
// the webhook handler; kept beside the subjects so a new tracked email cannot be
// added without deciding where its status is recorded.
const TRACKED_EMAIL_KINDS = {
  [EMAIL_SUBJECTS.STORE_WELCOME]: {
    kind: 'welcome',
    statusColumn: 'welcome_email_status',
    timestampColumn: 'welcome_email_status_at',
  },
  [EMAIL_SUBJECTS.STORE_PASSWORD_RESET]: {
    kind: 'password_reset',
    statusColumn: 'reset_email_status',
    timestampColumn: 'reset_email_status_at',
  },
};

async function sendStorePasswordResetEmail(toEmail, resetToken) {
  const resetLink = `${STORE_PORTAL_URL}/reset-password`;

  return sendEmail({
    to:      toEmail,
    subject: EMAIL_SUBJECTS.STORE_PASSWORD_RESET,
    text:    `A password reset was requested for your Flash store account.\n\nReset code:\n${resetToken}\n\n`
      + `Open ${resetLink} and enter the code above to set a new password.\n\n`
      + `This code expires in 1 hour and can only be used once. If you did not request this, ignore this email — your account is safe.`,
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
    <h2 style="color:#111827;margin-top:0">Reset your store account password</h2>
    <p style="color:#6b7280">A password reset was requested for your Flash store account. Use the code below to set a new password.</p>
    <div style="text-align:center;margin:24px 0">
      <code style="display:inline-block;background:#f3f4f6;color:#111827;padding:14px 20px;border-radius:12px;font-weight:700;font-size:15px;word-break:break-all">${resetToken}</code>
    </div>
    <div style="text-align:center;margin:24px 0">
      <a href="${resetLink}" style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:700;font-size:15px">Set a new password</a>
    </div>
    <p style="color:#6b7280;font-size:13px">Or open <a href="${resetLink}" style="color:#111827">${resetLink}</a> and enter the code above.</p>
    <p style="color:#9ca3af;font-size:13px">This code expires in <strong>1 hour</strong> and can only be used once. If you did not request this, ignore this email — your account is safe.</p>
  </div>
</body>
</html>`,
  });
}

// ─── Store Owner Welcome (Admin Platform Phase 3, Option C onboarding) ─────
// Sent exactly once, at the moment a Flash admin clicks "Verify & Activate
// Onboarding" on a store's AdminJS record — the real completion of Option C
// (docs/ADMIN_PLATFORM_PHASE1_STORE_IDENTITY_PROPOSAL.md): the first
// store_users row for a newly-verified store gets a real, temporary
// password (force_password_reset = true, same structural guarantee as the
// founder's own seeded admin account), emailed here rather than ever
// displayed/logged in plaintext anywhere else.
async function sendStoreWelcomeEmail(toEmail, ownerName, inviteToken) {
  // Points at the dedicated first-password page rather than /reset-password.
  // Both spend the same store_password_tokens row through the same endpoint —
  // only the copy differs, and a newly-approved owner should not be greeted by
  // a page titled "Set a NEW password" asking for a "Reset code". The token
  // stays out of this URL deliberately: it is pasted from the code shown in
  // the email body, so a single-use credential never reaches browser history,
  // a Referer header, or the static host's access logs.
  const setPasswordLink = `${STORE_PORTAL_URL}/set-password`;

  return sendEmail({
    to:      toEmail,
    subject: EMAIL_SUBJECTS.STORE_WELCOME,
    text:    `Hi ${ownerName},

Your store has been approved and your Flash Store Portal account is ready.

`
      + `Set your password to get started.

Setup code:
${inviteToken}

`
      + `Open ${setPasswordLink} and enter the code above to choose your password.

`
      + `This code expires in 7 days and can only be used once. If you weren't expecting this, contact Flash support.`,
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
    <h2 style="color:#111827;margin-top:0">Your Store Portal account is ready</h2>
    <p style="color:#6b7280">Hi ${escapeHtmlLite(ownerName)}, your store has been approved. Set your password below to sign in for the first time.</p>
    <div style="text-align:center;margin:24px 0">
      <code style="display:inline-block;background:#f3f4f6;color:#111827;padding:14px 20px;border-radius:12px;font-weight:700;font-size:15px;word-break:break-all">${escapeHtmlLite(inviteToken)}</code>
    </div>
    <div style="text-align:center;margin:24px 0">
      <a href="${setPasswordLink}" style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:700;font-size:15px">Set your password</a>
    </div>
    <p style="color:#6b7280;font-size:13px">Or open <a href="${setPasswordLink}" style="color:#111827">${setPasswordLink}</a> and enter the code above.</p>
    <p style="color:#9ca3af;font-size:13px">This code expires in <strong>7 days</strong> and can only be used once. If you weren't expecting this, contact Flash support.</p>
  </div>
</body>
</html>`,
  });
}

module.exports = {
  EMAIL_SUBJECTS,
  TRACKED_EMAIL_KINDS,
  sendPasswordResetEmail, sendEmailVerificationEmail, sendReturnAwaitingReviewEmail,
  sendSosAlertEmail, sendOrderEscalationEmail, sendOrderMissedEmail, sendMarketingLeadEmail,
  sendStorePasswordResetEmail, sendStoreWelcomeEmail,
};
