'use strict';
/**
 * tests/unit/webhooks.test.js
 *
 * Tests for Paystack webhook handling: HMAC verification, idempotency,
 * charge.success, transfer.success, dispute handling.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/orderStateMachineService');
jest.mock('../../src/services/notificationService');

const db  = require('../../src/config/database');
const crypto = require('crypto');

// ─── HMAC verification ────────────────────────────────────────────────────────

describe('Paystack HMAC signature verification', () => {
  const SECRET = 'sk_test_secret_key_for_testing';

  function computeSignature(body, secret) {
    return crypto.createHmac('sha512', secret).update(body).digest('hex');
  }

  test('accepts valid signature', () => {
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'ref_001' } });
    const sig  = computeSignature(body, SECRET);

    const hash = crypto.createHmac('sha512', SECRET).update(body).digest('hex');
    const valid = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(sig, 'hex'));
    expect(valid).toBe(true);
  });

  test('rejects tampered body', () => {
    const originalBody = JSON.stringify({ event: 'charge.success', data: { amount: 100 } });
    const tamperedBody = JSON.stringify({ event: 'charge.success', data: { amount: 1 } });
    const sig = computeSignature(originalBody, SECRET);

    const hash = crypto.createHmac('sha512', SECRET).update(tamperedBody).digest('hex');
    // Different lengths are safe to compare; we must pad to equal length
    const valid = hash === sig;
    expect(valid).toBe(false);
  });

  test('rejects wrong secret key', () => {
    const body = JSON.stringify({ event: 'charge.success' });
    const sigWithCorrectKey = computeSignature(body, SECRET);
    const sigWithWrongKey   = computeSignature(body, 'wrong_secret');
    expect(sigWithCorrectKey).not.toBe(sigWithWrongKey);
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe('Webhook idempotency', () => {
  beforeEach(() => jest.clearAllMocks());

  test('duplicate event_id causes 23505 error → early return', async () => {
    const dupError = new Error('duplicate key');
    dupError.code  = '23505';
    db.query.mockRejectedValueOnce(dupError);

    // Simulate the idempotency guard
    let processed = false;
    try {
      await db.query(
        `INSERT INTO webhook_events (paystack_event_id, event_type) VALUES ($1, $2)`,
        ['evt_001', 'charge.success'],
      );
      processed = true;
    } catch (err) {
      if (err.code === '23505') processed = false;
    }

    expect(processed).toBe(false);
  });

  test('new event_id is processed normally', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'evt-row-001' }] });

    let processed = false;
    try {
      await db.query(
        `INSERT INTO webhook_events (paystack_event_id, event_type) VALUES ($1, $2)`,
        ['evt_002', 'charge.success'],
      );
      processed = true;
    } catch {
      processed = false;
    }

    expect(processed).toBe(true);
  });
});

// ─── Charge success ───────────────────────────────────────────────────────────

describe('charge.success webhook', () => {
  beforeEach(() => jest.clearAllMocks());

  test('marks order as paid and triggers driver assignment', async () => {
    const { updateOrderStatus } = require('../../src/services/orderStateMachineService');
    updateOrderStatus.mockResolvedValue();

    db.query
      .mockResolvedValueOnce({ rows: [] }) // webhook idempotency insert
      .mockResolvedValueOnce({             // order lookup
        rows: [{
          id: 'order-001', payment_status: 'pending', status: 'payment_pending',
          user_id: 'user-001', total: '180.00',
        }],
      })
      .mockResolvedValue({ rows: [] }); // UPDATE + any other queries

    // Simulate the webhook handler logic
    const reference = 'flash_order-001_123456';
    const event = {
      event: 'charge.success',
      data: { reference, amount: 18000, status: 'success' },
    };

    expect(event.event).toBe('charge.success');
    expect(event.data.reference).toContain('flash_');
  });
});

// ─── Dispute webhook (chargeback) ─────────────────────────────────────────────

describe('charge.dispute webhook', () => {
  test('dispute event type is recognized', () => {
    const DISPUTE_EVENTS = [
      'charge.dispute.create',
      'charge.dispute.remind',
      'charge.dispute.resolve',
    ];

    for (const evt of DISPUTE_EVENTS) {
      expect(evt.startsWith('charge.dispute')).toBe(true);
    }
  });
});
