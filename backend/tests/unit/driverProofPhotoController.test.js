'use strict';
/**
 * tests/unit/driverProofPhotoController.test.js
 *
 * Coverage-remediation Phase 3 — DriverController.submitPickupPhoto/
 * submitDropoffPhoto (via the shared _submitProofPhoto), the real
 * "proof of pickup"/"proof of delivery" one-tap flow: a driver photographs
 * the item at the store or at the customer's door, and that single upload
 * both stores the photo and advances the order's real status. Before this
 * file, only the *bypass* was tested (tests/unit/orderController.test.js
 * proves a driver can't skip this by hitting the generic status-update
 * endpoint directly) -- nothing proved the real, intended photo-submission
 * flow itself actually works end to end.
 *
 * Real-world scenarios this file protects:
 *   - a driver arrives at the store, photographs proof, and the order
 *     correctly advances driver_arrived_store -> picked_up
 *   - a driver arrives at the customer, photographs proof, and the order
 *     correctly advances in_transit -> delivered
 *   - no photo attached at all -> rejected before anything is touched
 *   - a file whose real bytes don't match an allowed image type (the
 *     access-security audit's own finding: a spoofed Content-Type header
 *     is not enough) -> rejected
 *   - a driver tries to submit for an order that isn't theirs -> rejected
 *   - a photo submitted at the wrong stage (e.g. before actually arriving)
 *     -> rejected, order untouched
 *   - the state-machine transition itself rejects (a real business rule)
 *     -> the whole transaction rolls back, not a half-written photo record
 */

jest.mock('../../src/config/database');
jest.mock('../../src/services/s3Service');
jest.mock('../../src/services/orderStateMachineService');

const db = require('../../src/config/database');
const s3Service = require('../../src/services/s3Service');
const { updateOrderStatus, emitOrderUpdate, notifyOrderStatusChange, normalizeState } = require('../../src/services/orderStateMachineService');
const DriverController = require('../../src/controllers/driverController');

const REAL_JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const REAL_PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NOT_AN_IMAGE = Buffer.from('this is just plain text, not an image');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}
function mockReq(overrides = {}) {
  return {
    userId: 'driver-1',
    params: { orderId: 'order-1' },
    file: { buffer: REAL_JPEG_BYTES },
    app: { get: () => null },
    ...overrides,
  };
}
function mockClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  normalizeState.mockImplementation((s) => s);
});

describe('DriverController.submitPickupPhoto / submitDropoffPhoto — input rejection (no DB write)', () => {
  test('rejects when no file is attached at all', async () => {
    const req = mockReq({ file: undefined });
    const res = mockRes();
    await DriverController.submitPickupPhoto(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'A photo is required' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('rejects a file whose real bytes are not a JPEG or PNG, regardless of its declared type', async () => {
    const req = mockReq({ file: { buffer: NOT_AN_IMAGE, mimetype: 'image/png' } }); // spoofed header
    const res = mockRes();
    await DriverController.submitPickupPhoto(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toMatch(/allowed image type/);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('DriverController.submitPickupPhoto — real pickup-proof flow', () => {
  test('an order not found at all returns 404', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const req = mockReq();
    const res = mockRes();
    await DriverController.submitPickupPhoto(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('a driver cannot submit a photo for an order that is not theirs', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'order-1', driver_id: 'some-other-driver', status: 'driver_arrived_store' }] });
    const req = mockReq();
    const res = mockRes();
    await DriverController.submitPickupPhoto(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('rejects a pickup photo submitted before the driver has actually arrived', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'order-1', driver_id: 'driver-1', status: 'driver_assigned' }] });
    const req = mockReq();
    const res = mockRes();
    await DriverController.submitPickupPhoto(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  test('a real, valid pickup photo advances the order to picked_up', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'order-1', driver_id: 'driver-1', status: 'driver_arrived_store' }] });
    s3Service.uploadFile.mockResolvedValue({ publicId: 'flash-order-proof/abc123', resourceType: 'image' });
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    updateOrderStatus.mockResolvedValue({ id: 'order-1', user_id: 'user-1', status: 'picked_up' });

    const req = mockReq();
    const res = mockRes();
    await DriverController.submitPickupPhoto(req, res);

    expect(s3Service.uploadFile).toHaveBeenCalledWith(req.file, 'flash-order-proof');
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE orders\s+SET pickup_photo_public_id/),
      ['flash-order-proof/abc123', 'image', 'order-1'],
    );
    expect(updateOrderStatus).toHaveBeenCalledWith('order-1', 'picked_up', expect.objectContaining({ actorRole: 'driver', externalClient: client }));
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(emitOrderUpdate).toHaveBeenCalled();
    expect(notifyOrderStatusChange).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, status: 'picked_up' });
  });

  test('a real transition rejection rolls back the transaction and returns a clean 400', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'order-1', driver_id: 'driver-1', status: 'driver_arrived_store' }] });
    s3Service.uploadFile.mockResolvedValue({ publicId: 'flash-order-proof/abc123', resourceType: 'image' });
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    updateOrderStatus.mockRejectedValue(new Error('Illegal transition'));

    const req = mockReq();
    const res = mockRes();
    await DriverController.submitPickupPhoto(req, res);

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Illegal transition' });
  });
});

describe('DriverController.submitDropoffPhoto — real delivery-proof flow', () => {
  test('rejects a dropoff photo submitted before the order is actually in transit', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'order-1', driver_id: 'driver-1', status: 'picked_up' }] });
    const req = mockReq({ file: { buffer: REAL_PNG_BYTES } });
    const res = mockRes();
    await DriverController.submitDropoffPhoto(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('a real, valid dropoff photo advances the order to delivered', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'order-1', driver_id: 'driver-1', status: 'in_transit' }] });
    s3Service.uploadFile.mockResolvedValue({ publicId: 'flash-order-proof/def456', resourceType: 'image' });
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    updateOrderStatus.mockResolvedValue({ id: 'order-1', user_id: 'user-1', status: 'delivered' });

    const req = mockReq({ file: { buffer: REAL_PNG_BYTES } });
    const res = mockRes();
    await DriverController.submitDropoffPhoto(req, res);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE orders\s+SET dropoff_photo_public_id/),
      ['flash-order-proof/def456', 'image', 'order-1'],
    );
    expect(updateOrderStatus).toHaveBeenCalledWith('order-1', 'delivered', expect.objectContaining({ actorRole: 'driver' }));
    expect(res.json).toHaveBeenCalledWith({ success: true, status: 'delivered' });
  });
});
