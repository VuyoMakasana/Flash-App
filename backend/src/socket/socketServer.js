const jwt = require('jsonwebtoken');

module.exports = function setupSocket(io) {

  // ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId   = decoded.id;
      socket.userRole = decoded.role;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    // Every user/driver joins their personal room immediately
    socket.join(`${socket.userRole}:${socket.userId}`);

    // ── USER: Track an order ──────────────────────────────────────────────────
    socket.on('track_order', ({ orderId }) => {
      if (socket.userRole === 'user') {
        socket.join(`order:${orderId}`);
        socket.join(`chat:${orderId}`);   // also join chat room
      }
    });

    socket.on('stop_tracking', ({ orderId }) => {
      socket.leave(`order:${orderId}`);
      socket.leave(`chat:${orderId}`);
    });

    // ── DRIVER: Live location update ──────────────────────────────────────────
    // The HTTP route POST /api/drivers/location handles DB write + arrival alerts.
    // This event is for pure socket-only clients that bypass the HTTP route.
    socket.on('driver_location_update', ({ lat, lng, orderId }) => {
      if (socket.userRole !== 'driver') return;
      const payload = { driverId: socket.userId, lat, lng, timestamp: new Date().toISOString() };
      if (orderId) io.to(`order:${orderId}`).emit('driver_location', payload);
      io.to('admin').emit('driver_location', { ...payload, orderId });
    });

    // ── DRIVER: Online / offline status ──────────────────────────────────────
    socket.on('driver_status', ({ online }) => {
      if (socket.userRole !== 'driver') return;
      io.to('admin').emit('driver_status_change', {
        driverId: socket.userId, online, timestamp: new Date().toISOString(),
      });
    });

    // ── DRIVER: Join / leave the order pool ───────────────────────────────────
    socket.on('join_driver_pool', () => {
      if (socket.userRole === 'driver') {
        socket.join('driver_pool');
        socket.join(`driver:${socket.userId}`); // personal driver room
      }
    });

    socket.on('leave_driver_pool', () => {
      socket.leave('driver_pool');
    });

    // ── DRIVER: Join order chat room ──────────────────────────────────────────
    socket.on('join_order_chat', ({ orderId }) => {
      if (socket.userRole === 'driver') {
        socket.join(`order:${orderId}`);
        socket.join(`chat:${orderId}`);
      }
    });

    socket.on('leave_order_chat', ({ orderId }) => {
      socket.leave(`chat:${orderId}`);
    });

    // ── FLEET alert acknowledgement ───────────────────────────────────────────
    socket.on('fleet_alert_ack', ({ alertId, action }) => {
      // action: 'repositioning' | 'declined'
    });

    // ── ADMIN room ────────────────────────────────────────────────────────────
    socket.on('join_admin', () => {
      if (socket.userRole === 'admin') socket.join('admin');
    });

    // ── Feed: Real-time like notifications ────────────────────────────────────
    socket.on('post_liked', ({ postId, postOwnerId }) => {
      io.to(`user:${postOwnerId}`).emit('feed_notification', {
        type: 'like', postId,
        message: 'Someone liked your Flash post',
      });
    });

    socket.on('disconnect', () => {});
    socket.on('error', (err) => {
      console.error(`[Socket] Error for ${socket.userId}:`, err.message);
    });
  });

  // ─── SERVER-SIDE HELPERS ─────────────────────────────────────────────────
  io.notifyNewOrder = (orderId, isCashDelivery = false, extra = {}) => {
    io.to('driver_pool').emit('new_order_available', { orderId, isCashDelivery, ...extra });
  };

  io.notifyOrderUpdate = (orderId, userId, status) => {
    io.to(`order:${orderId}`).emit('order_update', { orderId, status, timestamp: new Date().toISOString() });
    io.to(`user:${userId}`).emit('order_update', { orderId, status });
  };

  io.notifyReturnCredit = (userId, creditAmount, returnId) => {
    io.to(`user:${userId}`).emit('return_credit_issued', {
      returnId, creditAmount,
      message: `R${creditAmount.toFixed(2)} store credit added instantly!`,
    });
  };
};
