'use strict';
/**
 * tests/unit/resendWebhook.test.js
 *
 * Email bounce visibility.
 *
 * The problem this closes: sendEmail() resolves the moment Resend ACCEPTS a
 * message, but a bounce happens asynchronously afterwards, so every caller —
 * including the fire-and-forget sendStoreWelcomeEmail — logged success and
 * moved on. A real store password-reset to a real Gmail address bounced on
 * 24 Sep 2026 and nothing recorded it; it was found only by going and looking
 * in Resend's dashboard.
 *
 * Two halves are tested here, and the first matters more than it looks:
 *
 *  1. The endpoint writes to the database on an unauthenticated request. If
 *     the signature check can be bypassed, anyone can forge "bounced" against
 *     any address — including marking a competitor's store owner as
 *     undeliverable. Most of this file is therefore spent trying to get past
 *     verification rather than testing the happy path.
 *
 *  2. Idempotency. Svix retries on any non-2xx and on timeouts, so the same
 *     event legitimately arrives more than once.
 */

jest.mock('../../src/config/database');

const crypto = require('crypto');
const pool = require('../../src/config/database');
const WebhookController = require('../../src/controllers/webhookController');
const { EMAIL_SUBJECTS, TRACKED_EMAIL_KINDS } = require('../../src/services/emailService');

const SECRET_BYTES = Buffer.from('a'.repeat(32));
const SIGNING_SECRET = 'whsec_' + SECRET_BYTES.toString('base64');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.send = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function sign(svixId, timestamp, rawBody, secretBytes = SECRET_BYTES) {
  const signedContent = `${svixId}.${timestamp}.${rawBody}`;
  return crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
}

// Builds a genuinely, correctly signed request the way Svix would.
function signedRequest(eventBody, { svixId = 'msg_test_1', skewSeconds = 0, secretBytes = SECRET_BYTES } = {}) {
  const raw = Buffer.from(JSON.stringify(eventBody), 'utf8');
  const timestamp = String(Math.floor(Date.now() / 1000) + skewSeconds);
  const signature = sign(svixId, timestamp, raw.toString('utf8'), secretBytes);
  return {
    body: raw,
    headers: {
      'svix-id': svixId,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
  };
}

function bounceEvent(subject = EMAIL_SUBJECTS.STORE_WELCOME, to = 'owner@example.com') {
  return {
    type: 'email.bounced',
    data: { email_id: 're_abc123', to: [to], subject, bounce: { message: 'mailbox full', subType: 'General' } },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RESEND_WEBHOOK_SECRET = SIGNING_SECRET;
  // Default: the insert succeeds and matches no store user.
  pool.query.mockResolvedValue({ rows: [{ id: 'evt-1' }] });
});

afterEach(() => {
  delete process.env.RESEND_WEBHOOK_SECRET;
});

// ─────────────────────────────────────────────────────────────────────────────
// Signature verification — the adversarial half
// ─────────────────────────────────────────────────────────────────────────────

describe('handleResend — the endpoint cannot be spoofed', () => {
  test('a correctly signed event is accepted', async () => {
    const req = signedRequest(bounceEvent());
    const res = makeRes();
    await WebhookController.handleResend(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('an UNSIGNED request is rejected and writes nothing', async () => {
    const res = makeRes();
    await WebhookController.handleResend(
      { body: Buffer.from(JSON.stringify(bounceEvent())), headers: {} }, res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a request signed with the WRONG secret is rejected', async () => {
    const req = signedRequest(bounceEvent(), { secretBytes: Buffer.from('b'.repeat(32)) });
    const res = makeRes();
    await WebhookController.handleResend(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a TAMPERED body invalidates the signature', async () => {
    // The attack this blocks: capture a real delivered event, swap the payload
    // for a bounce against someone else, replay it.
    const req = signedRequest(bounceEvent());
    const tampered = JSON.parse(req.body.toString('utf8'));
    tampered.data.to = ['victim@example.com'];
    req.body = Buffer.from(JSON.stringify(tampered), 'utf8');

    const res = makeRes();
    await WebhookController.handleResend(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('an OLD timestamp is rejected even with a valid signature (replay window)', async () => {
    // Without a tolerance, one captured request stays replayable forever.
    const req = signedRequest(bounceEvent(), { skewSeconds: -3600 });
    const res = makeRes();
    await WebhookController.handleResend(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a FUTURE timestamp is rejected too', async () => {
    const req = signedRequest(bounceEvent(), { skewSeconds: 3600 });
    const res = makeRes();
    await WebhookController.handleResend(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('a non-v1 signature version is not accepted', async () => {
    const req = signedRequest(bounceEvent());
    req.headers['svix-signature'] = req.headers['svix-signature'].replace('v1,', 'v0,');
    const res = makeRes();
    await WebhookController.handleResend(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('one valid signature among several is accepted (secret rotation)', async () => {
    // Svix sends multiple space-delimited signatures while a secret is being
    // rotated. Refusing those would drop every event during a rotation.
    const req = signedRequest(bounceEvent());
    const good = req.headers['svix-signature'];
    req.headers['svix-signature'] = `v1,${Buffer.from('not-the-signature').toString('base64')} ${good}`;
    const res = makeRes();
    await WebhookController.handleResend(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('a signature of the wrong LENGTH is rejected without throwing', async () => {
    // timingSafeEqual throws on a length mismatch; the guard must catch that
    // rather than 500, which would make Svix retry a forged event forever.
    const req = signedRequest(bounceEvent());
    req.headers['svix-signature'] = 'v1,' + Buffer.from('short').toString('base64');
    const res = makeRes();
    await WebhookController.handleResend(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('refuses to process anything when no signing secret is configured', async () => {
    // Fail closed. Accepting unverified events would be an unauthenticated
    // write path into the database.
    delete process.env.RESEND_WEBHOOK_SECRET;
    const req = signedRequest(bounceEvent());
    const res = makeRes();
    await WebhookController.handleResend(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a non-raw body is rejected (a global JSON parser would break signing)', async () => {
    const res = makeRes();
    await WebhookController.handleResend(
      { body: bounceEvent(), headers: { 'svix-id': 'a', 'svix-timestamp': '1', 'svix-signature': 'v1,x' } },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Recording
// ─────────────────────────────────────────────────────────────────────────────

describe('recordResendEvent', () => {
  test('records the event and flags the store user whose welcome email bounced', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'evt-1' }] })   // insert
      .mockResolvedValueOnce({ rows: [{ id: 'su-1' }] });   // store_users update

    const result = await WebhookController.recordResendEvent('msg_1', bounceEvent());

    const [insertSql, insertParams] = pool.query.mock.calls[0];
    expect(insertSql).toMatch(/INSERT INTO email_events/);
    expect(insertSql).toMatch(/ON CONFLICT \(svix_id\) DO NOTHING/);
    expect(insertParams[0]).toBe('msg_1');
    expect(insertParams[3]).toBe('owner@example.com');

    const [updateSql, updateParams] = pool.query.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE store_users/);
    expect(updateSql).toContain(TRACKED_EMAIL_KINDS[EMAIL_SUBJECTS.STORE_WELCOME].statusColumn);
    expect(updateParams).toEqual(['owner@example.com', 'bounced']);
    expect(result.storeUsersUpdated).toBe(1);
  });

  test('the password-reset email is tracked too, not only the welcome email', async () => {
    // Same failure mode, same blast radius — and it is the one that actually
    // bounced for real.
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'evt-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'su-1' }] });

    await WebhookController.recordResendEvent('msg_2', bounceEvent(EMAIL_SUBJECTS.STORE_PASSWORD_RESET));

    const [updateSql] = pool.query.mock.calls[1];
    expect(updateSql).toContain(TRACKED_EMAIL_KINDS[EMAIL_SUBJECTS.STORE_PASSWORD_RESET].statusColumn);
  });

  test('a delivery delay is recorded as delayed, not bounced', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'evt-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'su-1' }] });

    const event = bounceEvent();
    event.type = 'email.delivery_delayed';
    await WebhookController.recordResendEvent('msg_3', event);

    expect(pool.query.mock.calls[1][1]).toEqual(['owner@example.com', 'delayed']);
  });

  test('a duplicate delivery is ignored — Svix retries', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // ON CONFLICT DO NOTHING

    const result = await WebhookController.recordResendEvent('msg_repeat', bounceEvent());

    expect(result.duplicate).toBe(true);
    // Critically, the account is NOT touched a second time.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('a delivered event is logged but never clears an existing bounce', async () => {
    // "This person did not get it" is the operationally interesting state; a
    // later unrelated delivery must not erase it.
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'evt-1' }] });

    const event = bounceEvent();
    event.type = 'email.delivered';
    await WebhookController.recordResendEvent('msg_4', event);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toMatch(/INSERT INTO email_events/);
  });

  test('an untracked subject is still logged, but updates no account', async () => {
    // Customer password resets, SOS alerts and order escalation all share this
    // transport. They belong in the log; they have no store_users row to flag.
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'evt-1' }] });

    await WebhookController.recordResendEvent('msg_5', bounceEvent('SOS ALERT — order 123'));

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('a bounce for an address with no store user records the event without error', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'evt-1' }] })
      .mockResolvedValueOnce({ rows: [] }); // no matching store user

    const result = await WebhookController.recordResendEvent('msg_6', bounceEvent());
    expect(result.storeUsersUpdated).toBe(0);
  });

  test('the raw provider payload is retained for diagnosis', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'evt-1' }] });
    const event = bounceEvent('untracked');
    await WebhookController.recordResendEvent('msg_7', event);

    const params = pool.query.mock.calls[0][1];
    expect(JSON.parse(params[6])).toEqual(event);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The subject map cannot drift from the senders
// ─────────────────────────────────────────────────────────────────────────────

describe('EMAIL_SUBJECTS is the single source of truth', () => {
  // Attribution is done by subject, so if a sender's subject were edited
  // without updating the map, bounces would silently stop being attributed and
  // nothing would fail — the same class of silent gap as the store-suspension
  // isAccessible mismatch.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'services', 'emailService.js'), 'utf8',
  );

  test('the store senders use the constants rather than inline strings', () => {
    expect(source).toContain('subject: EMAIL_SUBJECTS.STORE_WELCOME,');
    expect(source).toContain('subject: EMAIL_SUBJECTS.STORE_PASSWORD_RESET,');
  });

  test('no sender restates a tracked subject as a literal', () => {
    for (const subject of Object.values(EMAIL_SUBJECTS)) {
      expect(source).not.toContain(`subject: '${subject}'`);
    }
  });

  test('every tracked subject maps to a distinct pair of columns', () => {
    const statusColumns = Object.values(TRACKED_EMAIL_KINDS).map((k) => k.statusColumn);
    expect(new Set(statusColumns).size).toBe(statusColumns.length);
    for (const entry of Object.values(TRACKED_EMAIL_KINDS)) {
      expect(entry.statusColumn).toMatch(/^[a-z_]+$/);
      expect(entry.timestampColumn).toMatch(/^[a-z_]+$/);
    }
  });

  test('every EMAIL_SUBJECTS value has a TRACKED_EMAIL_KINDS entry', () => {
    for (const subject of Object.values(EMAIL_SUBJECTS)) {
      expect(TRACKED_EMAIL_KINDS[subject]).toBeDefined();
    }
  });
});
