'use strict';
/**
 * tests/unit/socketServer.test.js
 *
 * Unit coverage for socket/socketServer.js — flagged by the audit at 0%
 * statement coverage despite being the entire authorization boundary for
 * every real-time channel in the app (order tracking, chat, driver
 * location broadcast, the driver pool). setupSocket(io) registers its
 * middleware/handlers via io.use()/io.on()/socket.on() against whatever
 * io/socket objects it's given, so this drives the real exported function
 * against a minimal mock io/socket harness that captures those handlers
 * and invokes them directly - not a reimplementation of the auth logic.
 */

jest.mock('../../src/config/database');
jest.mock('jsonwebtoken');

const pool = require('../../src/config/database');
const jwt = require('jsonwebtoken');
const setupSocket = require('../../src/socket/socketServer');

process.env.JWT_SECRET = 'test_secret_32_chars_minimum_here';

function createMockIo() {
  const middlewares = [];
  let connectionHandler = null;
  const rooms = {}; // roomName -> { emit }
  const io = {
    use: (fn) => middlewares.push(fn),
    on: (event, handler) => { if (event === 'connection') connectionHandler = handler; },
    to: jest.fn((room) => {
      if (!rooms[room]) rooms[room] = { emit: jest.fn() };
      return rooms[room];
    }),
    _middlewares: middlewares,
    _connect: async (socket) => {
      for (const mw of middlewares) {
        let err;
        await new Promise((resolve) => mw(socket, (e) => { err = e; resolve(); }));
        if (err) return err;
      }
      connectionHandler(socket);
      return null;
    },
    _rooms: rooms,
  };
  return io;
}

let _socketIdCounter = 0;
function createMockSocket({ token = 'valid-token', id } = {}) {
  // Unique per call by default - canAccessOrderRoomCached() caches
  // authorization decisions keyed by `${socket.id}:${orderId}` inside the
  // real module for 30s. Reusing the same socket id across tests that use
  // the same orderId but expect different authorization outcomes would
  // silently reuse an earlier test's cached result instead of exercising
  // the pool.query mock each test configures.
  const socketId = id || `sock-${++_socketIdCounter}`;
  const handlers = {};
  return {
    id: socketId,
    handshake: { auth: { token } },
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    on: (event, handler) => { handlers[event] = handler; },
    _handlers: handlers,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

// ─── Auth middleware ────────────────────────────────────────────────────────

describe('socket auth middleware', () => {
  test('rejects a connection with no token', async () => {
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket({ token: undefined });
    socket.handshake = { auth: {} };

    const err = await io._connect(socket);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Authentication required');
  });

  test('rejects an invalid/unverifiable token', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('bad signature'); });
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket({ token: 'garbage' });

    const err = await io._connect(socket);
    expect(err.message).toBe('Invalid token');
  });

  test('rejects a token whose jti has been revoked', async () => {
    jwt.verify.mockReturnValue({ id: 'u1', role: 'user', jti: 'revoked-jti-1' });
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] }); // revoked_tokens hit
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket({ token: 'a-revoked-token' });

    const err = await io._connect(socket);
    expect(err.message).toBe('Token revoked');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('revoked_tokens'),
      ['revoked-jti-1'],
    );
  });

  test('accepts a valid, non-revoked token and attaches user identity to the socket', async () => {
    jwt.verify.mockReturnValue({ id: 'u1', role: 'user', jti: 'live-jti' });
    pool.query.mockResolvedValue({ rows: [] }); // not revoked
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket({ token: 'a-live-token' });

    const err = await io._connect(socket);
    expect(err).toBeNull();
    expect(socket.userId).toBe('u1');
    expect(socket.userRole).toBe('user');
  });

  test('skips the revocation check entirely when the token has no jti (e.g. legacy tokens)', async () => {
    jwt.verify.mockReturnValue({ id: 'u1', role: 'user' }); // no jti
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket({ token: 'no-jti-token' });

    const err = await io._connect(socket);
    expect(err).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ─── Connection-time room joins ─────────────────────────────────────────────

describe('connection-time room joins', () => {
  test('every socket auto-joins its own role:id room', async () => {
    jwt.verify.mockReturnValue({ id: 'u1', role: 'user' });
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket();

    await io._connect(socket);
    expect(socket.join).toHaveBeenCalledWith('user:u1');
  });

  test('admins additionally join the shared admin broadcast room', async () => {
    jwt.verify.mockReturnValue({ id: 'admin1', role: 'admin' });
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket();

    await io._connect(socket);
    expect(socket.join).toHaveBeenCalledWith('admin');
  });

  test('non-admins do not join the shared admin room', async () => {
    jwt.verify.mockReturnValue({ id: 'u1', role: 'user' });
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket();

    await io._connect(socket);
    expect(socket.join).not.toHaveBeenCalledWith('admin');
  });
});

// ─── track_order authorization (customer live tracking) ────────────────────

describe('track_order authorization', () => {
  async function connectAs(role, userId) {
    jwt.verify.mockReturnValue({ id: userId, role });
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket();
    await io._connect(socket);
    return { io, socket };
  }

  test('a user who owns the order can join its tracking room', async () => {
    const { socket } = await connectAs('user', 'u1');
    pool.query.mockResolvedValue({ rows: [{ user_id: 'u1', driver_id: 'd1' }] });

    await socket._handlers['track_order']({ orderId: 'o1' });
    expect(socket.join).toHaveBeenCalledWith('order:o1');
    expect(socket.join).toHaveBeenCalledWith('chat:o1');
  });

  test('a user who does NOT own the order cannot join its tracking room', async () => {
    const { socket } = await connectAs('user', 'attacker-u2');
    pool.query.mockResolvedValue({ rows: [{ user_id: 'real-owner-u1', driver_id: 'd1' }] });

    await socket._handlers['track_order']({ orderId: 'o1' });
    expect(socket.join).not.toHaveBeenCalledWith('order:o1');
    expect(socket.join).not.toHaveBeenCalledWith('chat:o1');
  });

  test('a driver role cannot use track_order at all, even for their own assigned order', async () => {
    const { socket } = await connectAs('driver', 'd1');
    pool.query.mockResolvedValue({ rows: [{ user_id: 'u1', driver_id: 'd1' }] });

    await socket._handlers['track_order']({ orderId: 'o1' });
    // track_order's role gate is `socket.userRole === 'user'` only -
    // drivers use join_order_chat instead, never this event.
    expect(socket.join).not.toHaveBeenCalledWith('order:o1');
  });
});

// ─── driver_location_update authorization (mirrors the C-4 REST-layer fix,
//     at the socket-event layer specifically) ────────────────────────────

describe('driver_location_update authorization', () => {
  async function connectAsDriver(driverId) {
    jwt.verify.mockReturnValue({ id: driverId, role: 'driver' });
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket();
    await io._connect(socket);
    return { io, socket };
  }

  test('a driver cannot broadcast a location tagged with an order they do not own', async () => {
    const { io, socket } = await connectAsDriver('driver-B');
    pool.query.mockResolvedValue({ rows: [{ user_id: 'u1', driver_id: 'driver-A' }] }); // owned by A, not B

    await socket._handlers['driver_location_update']({ lat: -33.9, lng: 25.6, orderId: 'o1' });
    expect(io._rooms['order:o1']).toBeUndefined(); // never even opened the room to emit into it
  });

  test('a driver CAN broadcast a location for an order they own', async () => {
    const { io, socket } = await connectAsDriver('driver-A');
    pool.query.mockResolvedValue({ rows: [{ user_id: 'u1', driver_id: 'driver-A' }] });

    await socket._handlers['driver_location_update']({ lat: -33.9, lng: 25.6, orderId: 'o1' });
    expect(io._rooms['order:o1'].emit).toHaveBeenCalledWith(
      'driver_location',
      expect.objectContaining({ driverId: 'driver-A', lat: -33.9, lng: 25.6 }),
    );
    // Also always mirrored to the admin fleet view.
    expect(io._rooms['admin'].emit).toHaveBeenCalledWith(
      'driver_location',
      expect.objectContaining({ driverId: 'driver-A', orderId: 'o1' }),
    );
  });

  test('a non-driver role cannot trigger driver_location_update', async () => {
    jwt.verify.mockReturnValue({ id: 'u1', role: 'user' });
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket();
    await io._connect(socket);

    await socket._handlers['driver_location_update']({ lat: -33.9, lng: 25.6, orderId: 'o1' });
    expect(pool.query).not.toHaveBeenCalled(); // returned before ever checking ownership
  });
});

// ─── join_driver_pool (HIGH-10: only approved drivers may join) ────────────

describe('join_driver_pool', () => {
  async function connectAsDriver(driverId) {
    jwt.verify.mockReturnValue({ id: driverId, role: 'driver' });
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket();
    await io._connect(socket);
    return socket;
  }

  test('an unapproved driver is denied and never joins the pool', async () => {
    const socket = await connectAsDriver('d1');
    pool.query.mockResolvedValue({ rows: [] }); // not approved

    await socket._handlers['join_driver_pool']();
    expect(socket.emit).toHaveBeenCalledWith(
      'join_driver_pool_denied',
      expect.objectContaining({ reason: expect.stringMatching(/not yet approved/i) }),
    );
    expect(socket.join).not.toHaveBeenCalledWith('driver_pool');
  });

  test('an approved driver joins the pool and their own driver room', async () => {
    const socket = await connectAsDriver('d1');
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] }); // approved

    await socket._handlers['join_driver_pool']();
    expect(socket.join).toHaveBeenCalledWith('driver_pool');
    expect(socket.join).toHaveBeenCalledWith('driver:d1');
  });
});

// ─── Periodic re-verification (HIGH-9: a token that expires mid-connection
//     must terminate the socket, not stay valid until the client reconnects) ─

describe('periodic token re-verification', () => {
  test('disconnects the socket and emits auth_expired once the token can no longer be verified', async () => {
    jest.useFakeTimers();
    jwt.verify.mockReturnValue({ id: 'u1', role: 'user' }); // valid at connect time
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket();
    await io._connect(socket);

    // Token has since expired - the periodic check re-verifies from
    // socket.handshake.auth.token every 14 minutes, so a later jwt.verify
    // failure must be caught even though the connection itself succeeded.
    jwt.verify.mockImplementation(() => { throw new Error('jwt expired'); });

    await jest.advanceTimersByTimeAsync(14 * 60 * 1000);

    expect(socket.emit).toHaveBeenCalledWith('auth_expired');
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    jest.useRealTimers();
  });

  test('does not disconnect a socket whose token is still valid at the 14-minute check', async () => {
    jest.useFakeTimers();
    jwt.verify.mockReturnValue({ id: 'u1', role: 'user' });
    const io = createMockIo();
    setupSocket(io);
    const socket = createMockSocket();
    await io._connect(socket);

    await jest.advanceTimersByTimeAsync(14 * 60 * 1000);

    expect(socket.emit).not.toHaveBeenCalledWith('auth_expired');
    expect(socket.disconnect).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
