// flash-user-app/hooks/usePaymentConfirmation.js
//
// FI-096 (#100): waits for a card payment to be confirmed by the backend
// after the customer has paid on Paystack's page.
//
// Why: Paystack's page opens in Safari (Linking.openURL resolves as soon as
// Safari opens, not when the customer has paid), and its callback lands on
// a web page, not back in this app. So the app can't be told "done"; it has
// to notice the customer coming BACK (AppState -> 'active') and then ask the
// backend. The Paystack webhook is the source of truth: the backend marks
// the order paid when Paystack confirms, and the 5-minute reconciliation job
// catches a missed webhook. The app only reads GET /payments/status/:orderId.
//
// Polling is deliberately gentle (the API allows 100 requests / 15 min per
// IP): every 4 s, for at most 90 s after each return to the app, only while
// the app is in front. Network errors are ignored and the next poll retries.
//
// state:
//   'idle'      nothing started
//   'waiting'   payment page opened; waiting for the customer to come back
//   'checking'  polling the backend
//   'paid'      the backend confirmed payment
//   'failed'    the payment failed or the order was cancelled (see detail)
//   'timeout'   still not confirmed after 90 s (it may still arrive)

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import api from '../services/api';

const POLL_EVERY_MS = 4000;
const POLL_WINDOW_MS = 90000;

export default function usePaymentConfirmation(orderId) {
  const [state, setState] = useState('idle');
  const [detail, setDetail] = useState(null);
  const stateRef = useRef('idle');
  const timerRef = useRef(null);
  const deadlineRef = useRef(0);
  const mountedRef = useRef(true);

  const set = useCallback((next, info = null) => {
    stateRef.current = next;
    if (mountedRef.current) {
      setState(next);
      setDetail(info);
    }
  }, []);

  const stopTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  // One check against the backend. Returns true when the wait is over.
  const checkOnce = useCallback(async () => {
    try {
      const status = await api.payments.getStatus(orderId);
      if (status?.payment_status === 'paid') { set('paid'); return true; }
      if (status?.payment_status === 'failed') {
        set('failed', 'The payment did not go through. Nothing was charged.');
        return true;
      }
      if (status?.status === 'cancelled') {
        set('failed', 'This order was cancelled before the payment was confirmed.');
        return true;
      }
    } catch (err) {
      if (err?.message === 'SESSION_EXPIRED') { stopTimer(); return true; }
      // Network or server hiccup: the next poll tries again.
    }
    return false;
  }, [orderId, set]);

  const poll = useCallback(async () => {
    stopTimer();
    if (AppState.currentState !== 'active') return; // resumes on return
    const done = await checkOnce();
    if (done || !mountedRef.current) return;
    if (Date.now() >= deadlineRef.current) { set('timeout'); return; }
    timerRef.current = setTimeout(poll, POLL_EVERY_MS);
  }, [checkOnce, set]);

  const beginWindow = useCallback(() => {
    deadlineRef.current = Date.now() + POLL_WINDOW_MS;
    set('checking');
    poll();
  }, [poll, set]);

  // The payment page was opened in the browser: wait for the customer to
  // come back before asking (asking straight away only ever says "pending").
  const startAfterBrowser = useCallback(() => {
    stopTimer();
    set('waiting');
    if (AppState.currentState === 'active') {
      // Some devices keep the app "active" for a moment while Safari opens;
      // the AppState listener below restarts the window on the real return.
      deadlineRef.current = Date.now() + POLL_WINDOW_MS;
    }
  }, [set]);

  // No browser involved (saved card): start checking now.
  const startNow = useCallback(() => beginWindow(), [beginWindow]);

  // "Check again" button.
  const checkNow = useCallback(() => beginWindow(), [beginWindow]);

  const reset = useCallback(() => { stopTimer(); set('idle'); }, [set]);

  useEffect(() => {
    mountedRef.current = true;
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') { stopTimer(); return; }
      const s = stateRef.current;
      if (s === 'waiting' || s === 'checking' || s === 'timeout') beginWindow();
    });
    return () => {
      mountedRef.current = false;
      stopTimer();
      sub.remove();
    };
  }, [beginWindow]);

  return { state, detail, startAfterBrowser, startNow, checkNow, reset };
}
