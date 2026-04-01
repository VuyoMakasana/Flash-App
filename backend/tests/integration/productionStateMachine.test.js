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
}));

jest.mock("../../src/services/cashOtpService", () => ({
  generateOtp: jest.fn(),
  verifyOtp: jest.fn(),
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
  getWallet: jest.fn(),
  createPayoutRequest: jest.fn(),
}));

const db = require("../../src/config/database");
const Order = require("../../src/models/Order");
const Return = require("../../src/models/Return");
const cashOtpService = require("../../src/services/cashOtpService");
const { updateOrderStatus } = require("../../src/services/orderStateMachineService");

const { app } = require("../../src/server");

describe("Production state machine API integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("driver lifecycle update endpoint enforces state machine service", async () => {
    Order.getByIdWithDetails.mockResolvedValue({
      id: "order-1",
      driver_id: "driver-1",
      status: "driver_assigned",
    });
    updateOrderStatus.mockResolvedValue({ status: "picked_up" });

    const res = await request(app)
      .put("/api/orders/order-1/status")
      .set("x-user-id", "driver-1")
      .set("x-user-role", "driver")
      .send({ status: "picked_up" });

    expect(res.statusCode).toBe(200);
    expect(updateOrderStatus).toHaveBeenCalledWith(
      "order-1",
      "picked_up",
      expect.objectContaining({ actorId: "driver-1", actorRole: "driver" }),
    );
    expect(res.body).toEqual({ success: true, status: "picked_up" });
  });

  test("cash OTP send + confirm completes order only after OTP verification", async () => {
    db.query
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({ rows: [{ id: "order-cash-1", driver_id: "driver-1", payment_method: "cash", payment_status: "pending_cash", status: "delivered" }] })
      .mockResolvedValueOnce({ rows: [] });

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

  test("customer cancellation after assignment keeps delivery fee mode", async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "order-2",
            user_id: "user-1",
            driver_id: "driver-2",
            status: "driver_assigned",
            delivery_payment_status: "assigned",
            driver_paid: false,
            payment_method: "card",
            payment_status: "paid",
            driver_payout: 90,
            delivery_fee: 90,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    updateOrderStatus.mockResolvedValue({ status: "cancelled" });

    const res = await request(app)
      .post("/api/orders/order-2/cancel")
      .set("x-user-id", "user-1")
      .set("x-user-role", "user")
      .send({ reason: "Need to cancel" });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.refundMode).toBe("store_refund_keep_delivery");
  });

  test("admin return approval creates return order payload", async () => {
    Return.approveReturn.mockResolvedValue({
      returnId: "ret-1",
      status: "approved",
      returnOrder: {
        id: "order-ret-1",
        order_number: "FL-123-RET-AAA",
        status: "waiting_for_driver",
      },
    });

    const res = await request(app)
      .post("/api/returns/ret-1/approve")
      .set("x-user-id", "admin-1")
      .set("x-user-role", "admin")
      .send({});

    expect(res.statusCode).toBe(200);
    expect(Return.approveReturn).toHaveBeenCalledWith("ret-1", "admin-1");
    expect(res.body.success).toBe(true);
    expect(res.body.returnOrder.status).toBe("waiting_for_driver");
  });
});
