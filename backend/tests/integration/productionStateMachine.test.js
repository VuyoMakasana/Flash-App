const request = require("supertest");

jest.mock("node-cron", () => ({
  schedule: jest.fn(),
}));

jest.mock("../../src/socket/socketServer", () => jest.fn());

jest.mock("../../src/middleware/auth", () => ({
  authenticate: (req, _res, next) => {
    req.userId = req.headers["x-user-id"] || "user-1";
    req.userRole = req.headers["x-user-role"] || "user";
    req.driverStatus = "approved";
    next();
  },
  requireRole:
    (...roles) =>
    (req, res, next) => {
      if (!roles.includes(req.userRole)) {
        return res.status(403).json({ error: "forbidden" });
      }
      return next();
    },
  requireApprovedDriver: (_req, _res, next) => next(),
}));

jest.mock("../../src/config/database", () => ({
  query: jest.fn(),
  connect: jest.fn(async () => ({
    query: jest.fn(),
    release: jest.fn(),
  })),
  end: jest.fn(),
}));

jest.mock("../../src/services/orderStateMachineService", () => ({
  updateOrderStatus: jest.fn(),
  assignDriver: jest.fn(),
  normalizeState: jest.fn((s) => s),
  emitOrderUpdate: jest.fn(),
  notifyOrderStatusChange: jest.fn(async () => {}),
}));

jest.mock("../../src/services/cashOtpService", () => ({
  generateOtp: jest.fn(),
  verifyOtp: jest.fn(),
}));

// recordCashCommission/checkCommissionBlock each run several of their own
// client.query calls (commission-debt insert, wallet upsert, a FOR UPDATE
// select, and a conditional auto-deduct branch) — mocking at this service
// boundary avoids needing to replicate that entire internal query sequence
// just to test confirmCashReceived's own transaction, matching how this file
// already mocks cashOtpService/fleetIntelligenceService at their boundaries
// rather than the raw queries underneath them.
jest.mock("../../src/services/driverCommissionService", () => ({
  recordCashCommission: jest.fn(),
  checkCommissionBlock: jest.fn().mockResolvedValue({ blocked: false }),
}));

jest.mock("../../src/services/fleetIntelligenceService", () => ({
  autoAssignNearestDriver: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../src/models/Order", () => ({
  getByIdWithDetails: jest.fn(),
  getUserOrders: jest.fn(),
  create: jest.fn(),
  query: jest.fn(),
}));

jest.mock("../../src/models/Return", () => ({
  requestReturn: jest.fn(),
  pickupReturn: jest.fn(),
  getCredits: jest.fn(),
  getUserReturns: jest.fn(),
  approveReturn: jest.fn(),
}));

jest.mock("../../src/models/DriverWallet", () => ({
  transaction: jest.fn(async (fn) => fn({ query: jest.fn() })),
  reversePending: jest.fn(),
  creditAvailable: jest.fn(),
  getWallet: jest.fn(),
  createPayoutRequest: jest.fn(),
}));

// cancelOrder's pre-pickup split path calls this for real for a paid card
// order — mocked at the service boundary so the test never reaches
// paystackService.refundTransaction (a real external call).
jest.mock("../../src/services/refundService", () => ({
  refundOrderPayment: jest.fn(),
}));

const db = require("../../src/config/database");
const DriverWallet = require("../../src/models/DriverWallet");
const RefundService = require("../../src/services/refundService");
const Order = require("../../src/models/Order");
const Return = require("../../src/models/Return");
const cashOtpService = require("../../src/services/cashOtpService");
const { updateOrderStatus } = require("../../src/services/orderStateMachineService");

const { app } = require("../../src/server");

describe("Production state machine API integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const ORDER_1_ID = "11111111-1111-1111-1111-111111111111";

  test("driver lifecycle update endpoint enforces state machine service", async () => {
    Order.getByIdWithDetails.mockResolvedValue({
      id: ORDER_1_ID,
      driver_id: "driver-1",
      status: "driver_assigned",
    });
    updateOrderStatus.mockResolvedValue({ status: "picked_up" });

    const res = await request(app)
      .put(`/api/orders/${ORDER_1_ID}/status`)
      .set("x-user-id", "driver-1")
      .set("x-user-role", "driver")
      .send({ status: "picked_up" });

    expect(res.statusCode).toBe(200);
    expect(updateOrderStatus).toHaveBeenCalledWith(
      ORDER_1_ID,
      "picked_up",
      expect.objectContaining({ actorId: "driver-1", actorRole: "driver" }),
    );
    expect(res.body).toEqual({ success: true, status: "picked_up" });
  });

  test("cash OTP send + confirm completes order only after OTP verification", async () => {
    // sendCashOtp reads the order via the top-level db.query(...).
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "order-cash-1",
          user_id: "user-1",
          driver_id: "driver-1",
          payment_method: "cash",
          payment_status: "pending_cash",
          status: "delivered",
        },
      ],
    });

    // confirmCashReceived runs inside its own transaction via db.connect(),
    // not the top-level db.query — BEGIN / SELECT ... FOR UPDATE / UPDATE /
    // COMMIT all go through this client instead.
    db.connect.mockResolvedValueOnce({
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            id: "order-cash-1",
            driver_id: "driver-1",
            user_id: "user-1",
            payment_method: "cash",
            payment_status: "pending_cash",
            status: "delivered",
          }],
        }) // SELECT ... FOR UPDATE
        .mockResolvedValueOnce({ rows: [] }) // UPDATE orders SET payment_status='paid'
        .mockResolvedValueOnce({ rows: [] }), // COMMIT
      release: jest.fn(),
    });

    cashOtpService.generateOtp.mockResolvedValue({
      otp: "123456",
      order: { cash_otp_expires_at: new Date().toISOString() },
    });
    cashOtpService.verifyOtp.mockResolvedValue({ valid: true });
    updateOrderStatus.mockResolvedValue({ status: "completed" });

    const sendOtp = await request(app)
      .post("/api/payments/cash/send-otp")
      .set("x-user-id", "driver-1")
      .set("x-user-role", "driver")
      .send({ orderId: "order-cash-1" });

    expect(sendOtp.statusCode).toBe(200);
    expect(cashOtpService.generateOtp).toHaveBeenCalledWith("order-cash-1");

    const confirm = await request(app)
      .post("/api/payments/cash/confirm")
      .set("x-user-id", "driver-1")
      .set("x-user-role", "driver")
      .send({ orderId: "order-cash-1", otp: "123456" });

    expect(confirm.statusCode).toBe(200);
    expect(cashOtpService.verifyOtp).toHaveBeenCalledWith("order-cash-1", "123456");
    expect(updateOrderStatus).toHaveBeenCalledWith(
      "order-cash-1",
      "completed",
      expect.objectContaining({ actorId: "driver-1", actorRole: "driver" }),
    );
  });

  const ORDER_2_ID = "22222222-2222-2222-2222-222222222222";

  test("customer cancellation after assignment applies the confirmed 10/5/85 split", async () => {
    // Item value (subtotal) 500, delivery fee 90 →
    //   store 10% = 50, driver 5% = 25, customer = 425 (items) + 90 (delivery, in full) = 515.
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: ORDER_2_ID,
          user_id: "user-1",
          driver_id: "driver-2",
          status: "driver_assigned",
          delivery_payment_status: "assigned",
          driver_paid: false,
          payment_method: "card",
          payment_status: "paid",
          driver_payout: 90,
          delivery_fee: 90,
          subtotal: 500,
        },
      ],
    });

    // The pre-pickup split writes the order_cancellations row (RETURNING id)
    // and the order_cancellation_store_shares row inside the same
    // transaction as the wallet credit and status update — both of those
    // are mocked at the service/model boundary (updateOrderStatus,
    // DriverWallet.reversePending/creditAvailable), so only the two real
    // client.query calls need mocking here.
    const mockClient = {
      query: jest.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: "cancellation-1" }] }) // INSERT order_cancellations RETURNING id
        .mockResolvedValueOnce({}) // INSERT order_cancellation_store_shares
        .mockResolvedValueOnce({}), // COMMIT
      release: jest.fn(),
    };
    db.connect.mockResolvedValueOnce(mockClient);

    updateOrderStatus.mockResolvedValue({ status: "cancelled", user_id: "user-1" });
    RefundService.refundOrderPayment.mockResolvedValue({ status: "processing", refund_reference: "rf_1" });

    const res = await request(app)
      .post(`/api/orders/${ORDER_2_ID}/cancel`)
      .set("x-user-id", "user-1")
      .set("x-user-role", "user")
      .send({ reason: "Need to cancel" });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.refundMode).toBe("pre_pickup_split");
    expect(res.body.split).toEqual(
      expect.objectContaining({
        itemValue: 500,
        deliveryFee: 90,
        isCash: false,
        storeAmount: 50,
        driverAmount: 25,
        customerItemRefund: 425,
        deliveryFeeRefund: 90,
        totalCustomerRefund: 515,
      }),
    );
    expect(DriverWallet.creditAvailable).toHaveBeenCalledWith(
      mockClient, "driver-2", 25, ORDER_2_ID, "pre_pickup_cancellation_compensation",
    );
    expect(RefundService.refundOrderPayment).toHaveBeenCalledWith(
      ORDER_2_ID, "user-1", "Need to cancel", 515,
    );
    expect(res.body.refundStatus).toBe("processing");
  });

  const RETURN_1_ID = "33333333-3333-3333-3333-333333333333";

  test("admin return approval creates return order payload", async () => {
    Return.approveReturn.mockResolvedValue({
      returnId: RETURN_1_ID,
      status: "approved",
      returnOrder: {
        id: "order-ret-1",
        order_number: "FL-123-RET-AAA",
        status: "waiting_for_driver",
      },
    });

    const res = await request(app)
      .post(`/api/returns/${RETURN_1_ID}/approve`)
      .set("x-user-id", "admin-1")
      .set("x-user-role", "admin")
      .send({});

    expect(res.statusCode).toBe(200);
    expect(Return.approveReturn).toHaveBeenCalledWith(RETURN_1_ID, "admin-1");
    expect(res.body.success).toBe(true);
    expect(res.body.returnOrder.status).toBe("waiting_for_driver");
  });
});
