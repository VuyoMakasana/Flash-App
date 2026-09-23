import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { getToken } from '../services/api';

const SOCKET_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

// Admin Platform Phase 3 — the Store Admin Portal's real-time connection.
// Mirrors the mobile apps' own socket.io-client convention (CLAUDE.md:
// "both apps hold a socket.io-client connection authenticated via
// socket.handshake.auth.token"). The backend's socketServer.js auto-joins
// this connection to `store:<storeId>` using the storeId claim baked into
// the STORE_JWT_SECRET-signed token itself — never a value this hook could
// spoof by asking to join an arbitrary room.
//
// Deliberately simple: any 'order_update' event just re-triggers the
// caller's own refetch (onOrderUpdate) rather than trying to patch local
// state in place — a full refetch is cheap at this scale (a single store's
// order list) and avoids an entire class of "merged the wrong shape of
// partial update" bugs for a real, if unglamorous, correctness win.
export function useStoreSocket(onOrderUpdate) {
  useEffect(() => {
    const token = getToken();
    if (!token) return undefined;

    const socket = io(SOCKET_URL, { auth: { token }, transports: ['websocket', 'polling'] });
    socket.on('order_update', () => {
      if (typeof onOrderUpdate === 'function') onOrderUpdate();
    });

    return () => {
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
