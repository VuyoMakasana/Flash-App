'use strict';

const Driver = require('../models/Driver');
const Order = require('../models/Order');
const { checkDriverSubscriptionAllowed } = require('../services/subscriptionService');
const { isWithinNelsonMandelaBay, OUTSIDE_SERVICE_AREA_MESSAGE } = require('../utils/geoBoundary');
const { detectRealMimeType } = require('../utils/fileSignature');
const DriverWallet = require('../models/DriverWallet');
const db = require('../config/database');
const s3Service = require('../services/s3Service');
const {
  assignDriver,
  normalizeState,
  requeueOrderForDriverSearch,
  emitOrderUpdate,
  updateOrderStatus,
  notifyOrderStatusChange,
} = require('../services/orderStateMachineService');
const { autoAssignNearestDriver } = require('../services/autoMatchService');
const PayoutService = require('../services/payoutService');
const paystackService = require('../services/paystackService');
const { saveDriverPushToken, sendPushNotification } = require('../services/notificationService');
const bcrypt = require('bcryptjs');
const { isClosedNow } = require('../services/operatingHoursService');
const {
  checkCommissionBlock,
  getWalletWithDebt,
} = require('../services/driverCommissionService');

class DriverController {
  static async getProfile(req, res) {
    try {
      const driver = await Driver.findById(req.userId, 'drivers');
      if (!driver) {
        return res.status(404).json({ error: 'Driver not found' });
      }
      const { password_hash, ...safeDriver } = driver;
      const docs = await Driver.getDocuments(req.userId);
      res.json({ driver: safeDriver, documents: docs });
    } catch (err) {
      console.error('[Driver] getProfile error:', err.message);
      res.status(500).json({ error: 'Failed to fetch profile' });
    }
  }

  static async updateProfile(req, res) {
    const { name, phone, vehicle_type, vehicle_plate } = req.body;
    try {
      const driver = await Driver.updateProfile(req.userId, {
        name, phone, vehicle_type, vehicle_plate,
      });
      const { password_hash, ...safeDriver } = driver;
      res.json({ driver: safeDriver });
    } catch (err) {
      console.error('[Driver] updateProfile error:', err.message);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  }

  static async deleteAccount(req, res) {
    try {
      await Driver.deleteAccount(req.userId);
      res.json({ success: true });
    } catch (err) {
      if (err.message === 'ACTIVE_ORDER') {
        return res.status(409).json({ error: 'You have an active delivery in progress. Finish or hand it off before deleting your account.' });
      }
      if (err.message === 'UNPAID_BALANCE') {
        return res.status(409).json({ error: 'You have an outstanding wallet balance. Request a payout before deleting your account.' });
      }
      if (err.message === 'ACTIVE_SUBSCRIPTION') {
        const dateStr = new Date(err.expiresAt).toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });
        return res.status(409).json({ error: `You have an active subscription until ${dateStr}. Please wait until it expires before deleting your account.` });
      }
      if (err.message === 'Driver not found') {
        return res.status(404).json({ error: 'Driver not found' });
      }
      console.error('[Driver] deleteAccount error:', err.message);
      res.status(500).json({ error: 'Failed to delete account' });
    }
  }

  static async uploadDocument(req, res) {
    const { document_type } = req.body;
    const REQUIRED_DOCS = [
      'government_id',
      'drivers_license',
      'police_certified',
      'profile_photo',
      'vehicle_registration',
    ];

    if (!REQUIRED_DOCS.includes(document_type)) {
      return res.status(400).json({
        error: `Invalid document type. Must be one of: ${REQUIRED_DOCS.join(', ')}`,
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // H-access-audit FIX: multer's fileFilter (driverRoutes.js) only checks
    // the client-declared Content-Type header, which is trivially spoofed —
    // proven live in the access-security audit. This checks the file's
    // actual leading bytes, which fileFilter itself can't do (multer calls
    // it before the body is read, so req.file.buffer isn't populated yet).
    if (!detectRealMimeType(req.file.buffer)) {
      return res.status(400).json({
        error: 'File content does not match an allowed type (PDF, JPG, or PNG).',
      });
    }

    try {
      const result = await Driver.uploadDocument(req.userId, document_type, req.file);

      const uploadedTypes = await db.query(
        `SELECT document_type FROM driver_documents WHERE driver_id = $1 AND verified = false`,
        [req.userId],
      );
      const uploaded = uploadedTypes.rows.map((r) => r.document_type);
      const allDone  = REQUIRED_DOCS.every((d) => uploaded.includes(d));

      if (allDone) {
        await db.query(
          `UPDATE drivers SET status = 'documents_submitted', updated_at = NOW()
           WHERE id = $1 AND status = 'pending_documents'`,
          [req.userId],
        );

        const io = req.app.get('io');
        if (io) {
          io.to('admin').emit('driver_application_ready', {
            driverId: req.userId,
            driverName: req.body?.name || 'New Driver',
            message: 'A driver has submitted all required documents and is awaiting approval.',
            timestamp: new Date().toISOString(),
          });
        }
      }

      res.json(result);
    } catch (err) {
      console.error('[Driver] uploadDocument error:', err.message);
      res.status(500).json({ error: 'Upload failed' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // setOnlineStatus — COMMISSION BLOCK CHECK
  //
  // Drivers with outstanding commission debt >= R200 OR >= 10 unpaid cash
  // deliveries are blocked from going online until they clear the debt.
  // ─────────────────────────────────────────────────────────────────────────
  static async setOnlineStatus(req, res) {
    const { online, lat, lng } = req.body;

    if (typeof online === 'undefined') {
      return res.status(400).json({ error: 'online field is required' });
    }

    try {
      // Only block when trying to go ONLINE
      if (online) {
        const block = await checkCommissionBlock(req.userId);
        if (block.blocked) {
          return res.status(403).json({
            error: `Outstanding commission debt. Pay R${block.debtAmount.toFixed(2)} before going online.`,
            code: 'COMMISSION_DEBT_BLOCKED',
            debtAmount: block.debtAmount,
            unpaidDeliveries: block.unpaidDeliveries,
          });
        }

        // Previously only enforced in getAvailableOrders, which let a
        // driver with an expired subscription go online and stay online
        // indefinitely without ever being told why no orders were showing.
        const subCheck = await checkDriverSubscriptionAllowed(req.userId);
        if (!subCheck.allowed) {
          return res.status(403).json({ error: subCheck.reason, requiresSubscription: true });
        }

        // Flash only operates within Nelson Mandela Bay — checked here
        // (rather than only at registration) so a driver can't go online
        // from outside the service area on any given day, not just at
        // signup. Requires the driver app to send its current device
        // position along with the go-online request.
        if (!isWithinNelsonMandelaBay(lat, lng)) {
          return res.status(403).json({ error: OUTSIDE_SERVICE_AREA_MESSAGE });
        }
      }

      await Driver.setOnlineStatus(req.userId, online);
      res.json({ online: !!online });
    } catch (err) {
      console.error('[Driver] setOnlineStatus error:', err.message);
      res.status(500).json({ error: 'Failed to update status' });
    }
  }

  static async updateLocation(req, res) {
    const { lat, lng, orderId } = req.body;
    const io = req.app.get('io');

    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng required' });
    }

    try {
      await Driver.updateLocation(req.userId, lat, lng, orderId, io);
      res.json({ success: true });
    } catch (err) {
      console.error('[Driver] updateLocation error:', err.message);
      res.status(500).json({ error: 'Failed to update location' });
    }
  }

  static async getAvailableOrders(req, res) {
    try {
      if (isClosedNow()) {
        return res.json({
          orders: [],
          closed: true,
          message: 'Flash is currently closed. Orders are available 07:00 – 19:00 SAST.',
        });
      }

      const subCheck = await checkDriverSubscriptionAllowed(req.userId);
      if (!subCheck.allowed) {
        return res.status(403).json({ error: subCheck.reason, requiresSubscription: true });
      }

      // NOTE: Driver.getAvailableOrders(req.userId) already excludes orders
      // that have an unexpired preferred_driver_id pointing at a different
      // driver (see Driver.js fix). This driver simply won't see those
      // orders in the list until the exclusivity window lapses.
      const orders = await Driver.getAvailableOrders(req.userId);
      res.json({ orders });
    } catch (err) {
      console.error('[Driver] getAvailableOrders error:', err.message);
      res.status(500).json({ error: 'Failed to fetch orders' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // acceptOrder — COMMISSION BLOCK CHECK + TRUSTED DRIVER EXCLUSIVITY CHECK
  //
  // CHANGE FROM ORIGINAL: passes enforceTrustedDriverWindow: true so that
  // assignDriver() (orderStateMachineService) rejects the accept attempt if
  // this order is still inside another driver's trusted-driver window. This
  // is the self-accept path — it must never let an uninvited driver win an
  // order the customer routed to someone specific. Compare to
  // orderController.selectDriver, which intentionally omits this flag.
  // ─────────────────────────────────────────────────────────────────────────
  static async acceptOrder(req, res) {
    const { orderId } = req.params;
    const io = req.app.get('io');

    try {
      // Block commission-indebted drivers from accepting new orders
      const block = await checkCommissionBlock(req.userId);
      if (block.blocked) {
        return res.status(403).json({
          error: `Outstanding commission debt. Pay R${block.debtAmount.toFixed(2)} before accepting orders.`,
          code: 'COMMISSION_DEBT_BLOCKED',
          debtAmount: block.debtAmount,
          unpaidDeliveries: block.unpaidDeliveries,
        });
      }

      const order = await assignDriver(orderId, req.userId, {
        io,
        enforceTrustedDriverWindow: true,
      });

      if (io) {
        io.to(`order:${orderId}`).emit('order_update', {
          orderId,
          status: 'driver_assigned',
          driverId: req.userId,
        });
      }

      res.json({ order });
    } catch (err) {
      console.error('[Driver] acceptOrder error:', err.message);
      res.status(400).json({ error: err.message || 'Failed to accept order' });
    }
  }

  static async cancelAssignedOrder(req, res) {
    const { orderId } = req.params;
    const io = req.app.get('io');

    try {
      const result = await db.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);

      if (!result.rows.length) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = result.rows[0];
      if (String(order.driver_id) !== String(req.userId)) {
        return res.status(403).json({ error: 'Not your order' });
      }

      const state = normalizeState(order.status);
      if (['picked_up', 'in_transit', 'delivered', 'completed'].includes(state)) {
        return res.status(409).json({ error: 'Cannot cancel after pickup without admin override' });
      }

      const payout = parseFloat(order.driver_payout || order.delivery_fee || 0);

      // Wallet reversal, cancel-count/penalty bookkeeping, and the
      // order-status requeue to 'waiting_for_driver' now share a single
      // transaction. Previously these were two separate transactions
      // (DriverWallet.transaction(...), then a second independent
      // BEGIN/COMMIT inside requeueOrderForDriverSearch) — a crash between
      // them could reverse the driver's pending payout and record the
      // penalty while the order stayed assigned to a driver who just
      // cancelled, or vice versa.
      const client = await db.connect();
      let requeuedOrder;
      try {
        await client.query('BEGIN');

        await client.query(
          `UPDATE drivers SET cancel_count = COALESCE(cancel_count, 0) + 1, updated_at = NOW()
           WHERE id = $1`,
          [req.userId],
        );

        if (payout > 0) {
          await DriverWallet.reversePending(
            client, req.userId, payout, orderId, 'driver_cancel_before_pickup',
          );
        }

        await client.query(
          `INSERT INTO driver_penalties (driver_id, order_id, amount, reason)
           VALUES ($1, $2, $3, $4)`,
          [req.userId, orderId, 20, 'driver_cancelled_before_pickup'],
        );

        requeuedOrder = await requeueOrderForDriverSearch(
          orderId,
          { actorId: req.userId, actorRole: 'driver' },
          client,
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Side effects only fire after the transaction above has committed.
      emitOrderUpdate(io, orderId, requeuedOrder.user_id, requeuedOrder.status);

      if (io) {
        io.to('driver_pool').emit('new_order_available', { orderId, reassigned: true });
      }

      await autoAssignNearestDriver(orderId, io).catch(() => null);

      return res.json({ success: true, status: 'waiting_for_driver', penaltyApplied: 20 });
    } catch (err) {
      console.error('[Driver] cancelAssignedOrder error:', err.message);
      return res.status(400).json({ error: err.message || 'Failed to cancel assignment' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Package protection: a driver-taken photo is required to advance past
  // driver_arrived_store (proof of pickup) and past in_transit (proof of
  // delivery). One request does both the upload and the status transition —
  // a one-tap flow, not a separate "upload then advance" pair of steps.
  // Photos are stored the same way driver documents already are (Cloudinary,
  // private/authenticated, public_id + resource_type only — never a
  // permanent URL); see GET /api/orders/:orderId/photos for how they're
  // actually viewed later, via a short-lived signed URL generated on demand.
  // ─────────────────────────────────────────────────────────────────────────
  static async submitPickupPhoto(req, res) {
    return DriverController._submitProofPhoto(req, res, {
      requiredState: 'driver_arrived_store',
      targetState: 'picked_up',
      columnPrefix: 'pickup_photo',
    });
  }

  static async submitDropoffPhoto(req, res) {
    return DriverController._submitProofPhoto(req, res, {
      requiredState: 'in_transit',
      targetState: 'delivered',
      columnPrefix: 'dropoff_photo',
    });
  }

  static async _submitProofPhoto(req, res, { requiredState, targetState, columnPrefix }) {
    const { orderId } = req.params;
    const io = req.app.get('io');

    if (!req.file) {
      return res.status(400).json({ error: 'A photo is required' });
    }
    const realType = detectRealMimeType(req.file.buffer);
    if (!['image/jpeg', 'image/png'].includes(realType)) {
      return res.status(400).json({ error: 'File content does not match an allowed image type (JPG or PNG).' });
    }

    try {
      const result = await db.query(`SELECT id, driver_id, status FROM orders WHERE id = $1`, [orderId]);
      if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });

      const order = result.rows[0];
      if (String(order.driver_id) !== String(req.userId)) {
        return res.status(403).json({ error: 'Not your order' });
      }
      if (normalizeState(order.status) !== requiredState) {
        return res.status(409).json({ error: `A photo can only be submitted while the order is at ${requiredState}` });
      }

      const uploadResult = await s3Service.uploadFile(req.file, 'flash-order-proof');

      const client = await db.connect();
      let updatedOrder;
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE orders
           SET ${columnPrefix}_public_id = $1, ${columnPrefix}_resource_type = $2, ${columnPrefix}_at = NOW(), updated_at = NOW()
           WHERE id = $3`,
          [uploadResult.publicId, uploadResult.resourceType, orderId],
        );
        updatedOrder = await updateOrderStatus(orderId, targetState, {
          actorId:        req.userId,
          actorRole:      'driver',
          externalClient: client,
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      emitOrderUpdate(io, orderId, updatedOrder.user_id, updatedOrder.status);
      await notifyOrderStatusChange(updatedOrder, targetState);

      return res.json({ success: true, status: normalizeState(updatedOrder.status) });
    } catch (err) {
      console.error('[Driver] submitProofPhoto error:', err.message);
      return res.status(400).json({ error: err.message || 'Failed to submit photo' });
    }
  }

  static async getEarnings(req, res) {
    try {
      const earnings = await Driver.getEarnings(req.userId);
      const wallet   = await getWalletWithDebt(req.userId);
      res.json({ ...earnings, wallet });
    } catch (err) {
      console.error('[Driver] getEarnings error:', err.message);
      res.status(500).json({ error: 'Failed to fetch earnings' });
    }
  }

  // Returns wallet balance WITH commission debt fields
  static async getWallet(req, res) {
    try {
      const wallet = await getWalletWithDebt(req.userId);
      res.json({ wallet });
    } catch (err) {
      console.error('[Driver] getWallet error:', err.message);
      res.status(500).json({ error: 'Failed to fetch wallet' });
    }
  }

  static async requestPayout(req, res) {
    const { amount } = req.body;
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Valid payout amount is required' });
    }
    try {
      const request = await DriverWallet.createPayoutRequest(req.userId, amount);
      const payout  = await PayoutService.processRequestedPayout(request.id);
      res.status(201).json({ payoutRequest: request, payout });
    } catch (err) {
      console.error('[Driver] requestPayout error:', err.message);
      res.status(400).json({ error: err.message || 'Failed to request payout' });
    }
  }

  static async getActiveOrder(req, res) {
    try {
      const order = await Driver.getActiveOrder(req.userId);
      res.json({ order });
    } catch (err) {
      console.error('[Driver] getActiveOrder error:', err.message);
      res.status(500).json({ error: 'Failed to fetch active order' });
    }
  }

  static async getNearbyDrivers(req, res) {
    const { lat, lng } = req.query;
    try {
      const drivers = await Driver.getNearby(lat, lng);
      res.json({ drivers });
    } catch (err) {
      console.error('[Driver] getNearbyDrivers error:', err.message);
      res.status(500).json({ error: 'Failed to fetch nearby drivers' });
    }
  }

  static async getAvailability(req, res) {
    try {
      const anyOnline = await Driver.anyOnline();
      res.json({ anyOnline });
    } catch (err) {
      console.error('[Driver] getAvailability error:', err.message);
      res.status(500).json({ error: 'Failed to check driver availability' });
    }
  }

  static async getSupportedBanks(req, res) {
    try {
      const result = await paystackService.getBankList();
      if (!result.status) {
        return res.status(502).json({ error: 'Could not fetch bank list' });
      }
      res.json({ banks: result.data || [] });
    } catch (err) {
      console.error('[Driver] getSupportedBanks error:', err.message);
      res.status(500).json({ error: 'Failed to fetch bank list' });
    }
  }

  static async verifyBankAccount(req, res) {
    const { account_number, bank_code } = req.body;
    if (!account_number || !bank_code) {
      return res.status(400).json({ error: 'account_number and bank_code are required' });
    }
    try {
      const result = await paystackService.verifyBankAccount(account_number, bank_code);
      if (!result.status) {
        return res.status(400).json({ error: result.message || 'Could not verify account' });
      }
      res.json({
        account_name: result.data?.account_name,
        account_number: result.data?.account_number,
      });
    } catch (err) {
      console.error('[Driver] verifyBankAccount error:', err.message);
      res.status(500).json({ error: 'Bank account verification failed' });
    }
  }

  static async saveBankAccount(req, res) {
    const { account_number, bank_code, account_name, password } = req.body;
    if (!account_number || !bank_code || !account_name) {
      return res.status(400).json({
        error: 'account_number, bank_code, and account_name are required',
      });
    }
    if (!password) {
      return res.status(400).json({ error: 'Password confirmation is required to change payout details' });
    }

    try {
      // H-5 FIX: step-up auth. Previously, anyone holding a driver's
      // session token alone (stolen device, leaked JWT) could redirect all
      // future payouts to their own account with no further check, and the
      // real driver had no signal until a payout went missing. Require the
      // driver to re-enter their password immediately before activating a
      // new payout destination.
      //
      // Password re-entry, not OTP: there's no reliable SMS/OTP delivery
      // infrastructure wired up yet, and shipping a real (if simpler)
      // protection now beats blocking this fix on building that first. A
      // one-time-code step is a reasonable future upgrade, not a rejected
      // approach — swap this check for one when OTP delivery exists.
      const driver = await Driver.findById(req.userId, 'drivers');
      if (!driver) {
        return res.status(404).json({ error: 'Driver not found' });
      }
      const passwordValid = await bcrypt.compare(password, driver.password_hash);
      if (!passwordValid) {
        return res.status(401).json({ error: 'Incorrect password' });
      }

      const recipientRes = await paystackService.createTransferRecipient({
        name: account_name,
        accountNumber: account_number,
        bankCode: bank_code,
        description: `Flash driver – ${req.userId}`,
      });

      if (!recipientRes.status) {
        return res.status(400).json({ error: recipientRes.message || 'Failed to register bank account' });
      }

      const recipientCode = recipientRes.data?.recipient_code;
      if (!recipientCode) {
        return res.status(502).json({ error: 'Invalid response from payment provider' });
      }

      await db.query(
        `UPDATE transfer_recipients SET is_active = false, updated_at = NOW()
         WHERE driver_id = $1`,
        [req.userId],
      );

      await db.query(
        `INSERT INTO transfer_recipients
           (driver_id, recipient_code, account_number, bank_code, account_name, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (driver_id, account_number, bank_code)
         DO UPDATE SET recipient_code = $2, is_active = true, updated_at = NOW()`,
        [req.userId, recipientCode, account_number, bank_code, account_name],
      );

      // H-5 FIX: notify the driver's own device on every payout-destination
      // change, so a real driver has an immediate signal if this wasn't
      // them — not just silence until a payout goes missing.
      sendPushNotification({
        tokens: driver.push_token,
        title:  'Payout details changed',
        body:   'Your bank account for payouts was just updated. If this wasn\'t you, contact support immediately.',
      }).catch(() => {});

      res.status(201).json({ success: true, recipient_code: recipientCode, account_name });
    } catch (err) {
      console.error('[BankAccount] Save error:', err.message);
      res.status(500).json({ error: 'Failed to save bank account' });
    }
  }

  static async getBankAccount(req, res) {
    try {
      const result = await db.query(
        `SELECT account_name, bank_code,
                CONCAT(REPEAT('*', LENGTH(account_number) - 4), RIGHT(account_number, 4)) AS masked_account_number
         FROM transfer_recipients
         WHERE driver_id = $1 AND is_active = true
         ORDER BY created_at DESC LIMIT 1`,
        [req.userId],
      );
      if (!result.rows.length) {
        return res.json({ bank_account: null });
      }
      res.json({ bank_account: result.rows[0] });
    } catch (err) {
      console.error('[Driver] getBankAccount error:', err.message);
      res.status(500).json({ error: 'Failed to fetch bank account' });
    }
  }

  static async savePushToken(req, res) {
    const { push_token } = req.body;
    if (!push_token) return res.status(400).json({ error: 'push_token required' });
    try {
      await db.query(
        `UPDATE drivers SET push_token = $1, updated_at = NOW() WHERE id = $2`,
        [push_token, req.userId],
      );
      res.json({ success: true });
    } catch (err) {
      console.error('[Driver] savePushToken error:', err.message);
      res.status(500).json({ error: 'Failed to save push token' });
    }
  }

  static async registerPushToken(req, res) {
    const { push_token } = req.body;
    if (!push_token || !String(push_token).startsWith('ExponentPushToken[')) {
      return res.status(400).json({ error: 'A valid Expo push token is required' });
    }
    try {
      await saveDriverPushToken(req.userId, push_token);
      res.json({ success: true });
    } catch (err) {
      console.error('[Driver] registerPushToken error:', err.message);
      res.status(500).json({ error: 'Failed to register push token' });
    }
  }
}

module.exports = DriverController;