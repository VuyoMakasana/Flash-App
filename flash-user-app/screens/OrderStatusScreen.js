import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Alert, ActivityIndicator, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import api from '../services/api';

// FIX 4: Align status steps with backend state machine values
const STEPS = [
  { key: 'paid',                label: 'Order Confirmed',  icon: 'checkmark-circle' },
  { key: 'driver_assigned',     label: 'Driver Assigned',  icon: 'person' },
  { key: 'driver_arrived_store',label: 'At Store',         icon: 'storefront' },
  { key: 'picked_up',           label: 'Picked Up',        icon: 'bag' },
  { key: 'in_transit',          label: 'On the Way',       icon: 'car' },
  { key: 'delivered',           label: 'Delivered',        icon: 'home' },
];

// scheduled_for_morning/waiting_for_driver were missing here entirely, so an
// order that had genuinely already paid and confirmed fell through to rank 0
// — the same as a brand-new, unconfirmed order — making it look like payment
// never registered.
const ORDER_RANK = {
  scheduled_for_morning: 1,
  waiting_for_driver: 1,
  paid: 1,
  driver_assigned: 2,
  driver_arrived_store: 3,
  picked_up: 4,
  in_transit: 5,
  delivered: 6,
  completed: 6,
};

// Mirrors the backend's own eligibility window (Return.js's
// ELIGIBILITY_WINDOW_HOURS) — this is a UX convenience only, the server is
// the real, authoritative check. Blocked for the first RETURN_WINDOW_HOURS
// after delivery, open at and after that mark indefinitely (no upper
// bound). delivered_at missing entirely (an order that reached
// delivered/completed before that column existed) is treated the same
// conservative way the backend treats it: not eligible, since there's no
// way to verify the window.
const RETURN_WINDOW_HOURS = 48;

function getReturnEligibility(order) {
  if (!order.delivered_at) {
    return { canRequest: false, message: 'Returns aren’t available for this order.' };
  }
  const elapsedHours = (Date.now() - new Date(order.delivered_at).getTime()) / 36e5;
  if (elapsedHours < RETURN_WINDOW_HOURS) {
    return { canRequest: false, message: `Returns open ${RETURN_WINDOW_HOURS} hours after delivery` };
  }
  return { canRequest: true, message: null };
}

export default function OrderStatusScreen() {
  const navigation  = useNavigation();
  const route       = useRoute();
  const { order: routeOrder, orderId } = route.params || {};

  const [order,     setOrder]     = useState(routeOrder || null);
  const [loading,   setLoading]   = useState(!routeOrder && !!orderId);
  const [ratingValue, setRatingValue]         = useState(0);
  const [submittingRating, setSubmittingRating] = useState(false);
  const [ratingSubmitted, setRatingSubmitted]   = useState(false);
  const [fetchingCashOtp, setFetchingCashOtp]   = useState(false);
  const [photos, setPhotos] = useState(null);

  // Package protection — pickup/drop-off proof photos. Fetched once the
  // order has actually reached a status where a photo could exist; signed
  // URLs are short-lived, so this always fetches fresh rather than caching.
  useEffect(() => {
    const id = order?.id;
    const hasPhotos = ['picked_up', 'in_transit', 'delivered', 'completed'].includes(order?.status);
    if (!id || !hasPhotos) return;
    api.orders.getPhotos(id).then(setPhotos).catch(() => {});
  }, [order?.id, order?.status]);

  // If we were only passed an orderId (e.g. from PaymentScreen fallback), fetch the full order
  useEffect(() => {
    if (!routeOrder && orderId) {
      api.orders.getOrder(orderId)
        .then(data => setOrder(data.order))
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [routeOrder, orderId]);

  // While payment is pending, poll briefly so the screen can move to
  // confirmed as soon as webhook finalization is complete.
  useEffect(() => {
    const id = order?.id || orderId;
    const isPendingPayment =
      order?.payment_status === 'pending' || order?.status === 'payment_pending';

    if (!id || !isPendingPayment) return;

    let cancelled = false;
    let timeoutId;

    const poll = async () => {
      try {
        const data = await api.orders.getOrder(id);
        if (data?.order) {
          setOrder(data.order);
        }
      } catch (_) {}

      if (!cancelled) {
        timeoutId = setTimeout(poll, 5000);
      }
    };

    timeoutId = setTimeout(poll, 5000);

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [order?.id, order?.payment_status, order?.status, orderId]);

  const currentRank = ORDER_RANK[order?.status] || 0;

  const handleReturn = () => {
    navigation.navigate('ReturnRequest', { order });
  };

  // Mirrors the backend's own boundary in orderController.cancelOrder — a
  // UX convenience only, the server is the real, authoritative check.
  // There was no cancel entry point anywhere in the app before this; the
  // backend route and API wrapper already existed but nothing ever called
  // them.
  const canCancel = !!order.status
    && !['picked_up', 'in_transit', 'delivered', 'completed', 'cancelled'].includes(order.status);

  const handleCancel = () => {
    navigation.navigate('CancelOrder', { order });
  };

  // The code itself never appears in any push notification or socket event
  // (lock-screen visibility, consistent with how this code is handled
  // everywhere else in the app) — this is the only place a customer can
  // actually see it, fetched fresh on tap so it's never stale.
  const handleViewCashCode = async () => {
    setFetchingCashOtp(true);
    try {
      const data = await api.payments.getCashOtp(order.id);
      Alert.alert(
        'Your Cash Code',
        `${data.otp}\n\nGive this code to your driver to confirm you received your order.`,
      );
    } catch (e) {
      if (e.message === 'SESSION_EXPIRED') return;
      Alert.alert('Not available yet', e.message || 'Could not retrieve your code.');
    } finally {
      setFetchingCashOtp(false);
    }
  };

  const handleSubmitRating = async () => {
    if (!ratingValue) {
      Alert.alert('Pick a rating', 'Tap a star to rate your driver.');
      return;
    }
    setSubmittingRating(true);
    try {
      await api.orders.rateDriver(order.id, ratingValue);
      setRatingSubmitted(true);
    } catch (e) {
      if (e.message === 'SESSION_EXPIRED') return;
      Alert.alert('Error', e.message || 'Could not submit rating.');
    } finally {
      setSubmittingRating(false);
    }
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color="#0a0a0a" /></View>;
  }

  if (!order) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={48} color="#d1d5db" />
        <Text style={{ color: '#9ca3af', marginTop: 12 }}>Order not found</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Status */}
      <View style={styles.card}>
        <Text style={styles.orderNum}>Order #{order.order_number || order.id?.slice(0, 8)}</Text>
        <Text style={styles.total}>R{order.total}</Text>

        {(order.payment_status === 'pending' || order.status === 'payment_pending') && (
          <View style={styles.pendingBanner}>
            <Ionicons name="time-outline" size={16} color="#b45309" />
            <Text style={styles.pendingBannerText}>Waiting for payment confirmation...</Text>
          </View>
        )}

        {/* CANCELLED: previously the progress steps just showed frozen at
            rank 0 with no explanation at all for why nothing was moving. */}
        {order.status === 'cancelled' && (
          <View style={styles.cancelledBanner}>
            <Ionicons name="close-circle" size={16} color="#ef4444" />
            <View style={{ flex: 1 }}>
              <Text style={styles.cancelledTitle}>Order Cancelled</Text>
              <Text style={styles.cancelledBody}>
                This order was cancelled. If you were charged, your refund will follow the policy in our Terms & Conditions.
              </Text>
            </View>
          </View>
        )}

        {/* SCHEDULED FOR MORNING: order paid outside operating hours (07:00–19:00 SAST) */}
        {order.status === 'scheduled_for_morning' && (
          <View style={styles.noDriverBanner}>
            <Ionicons name="moon-outline" size={16} color="#b45309" />
            <View style={{ flex: 1 }}>
              <Text style={styles.noDriverTitle}>Scheduled for the morning</Text>
              <Text style={styles.noDriverBody}>
                Flash is currently closed. Your order is confirmed and will be assigned to a driver at 07:00.
              </Text>
            </View>
          </View>
        )}

        {/* NO-DRIVER WARNING: Shows when order is paid but no driver found after 10 minutes */}
        {/* WHY: Users need to know their order is waiting and they can cancel for a full refund */}
        {order.status === 'waiting_for_driver' && order.payment_status === 'paid' && (() => {
          const waitingMins = Math.floor((Date.now() - new Date(order.updated_at).getTime()) / 60000);
          if (waitingMins < 10) return null;
          return (
            <View style={styles.noDriverBanner}>
              <Ionicons name="alert-circle-outline" size={16} color="#b45309" />
              <View style={{ flex: 1 }}>
                <Text style={styles.noDriverTitle}>Finding a driver...</Text>
                <Text style={styles.noDriverBody}>
                  No drivers are available yet. Your order will auto-cancel and refund in full if no driver is found within 30 minutes. You can also cancel now for an immediate full refund.
                </Text>
              </View>
            </View>
          );
        })()}

        <View style={styles.steps}>
          {STEPS.map((step, idx) => {
            const done = currentRank >= ORDER_RANK[step.key];
            const active = ORDER_RANK[step.key] === currentRank;
            return (
              <View key={step.key} style={styles.stepRow}>
                <View style={styles.stepLeft}>
                  <View style={[styles.stepDot, done && styles.stepDotDone, active && styles.stepDotActive]}>
                    <Ionicons name={step.icon} size={14} color={done ? '#fff' : '#9ca3af'} />
                  </View>
                  {idx < STEPS.length - 1 && <View style={[styles.stepLine, done && styles.stepLineDone]} />}
                </View>
                <Text style={[styles.stepLabel, done && styles.stepLabelDone]}>{step.label}</Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* Track button */}
      {/* FIX 4: Added driver_arrived_store and in_transit to track button condition — button was invisible exactly when the driver was actively moving */}
      {['driver_assigned', 'driver_arrived_store', 'picked_up', 'in_transit'].includes(order.status) && (
        <Pressable
          style={styles.trackBtn}
          onPress={() => navigation.navigate('Tracking', {
            orderId: order.id,
            isCashDelivery: !!order.is_cash_delivery,
          })}
        >
          <Ionicons name="location" size={18} color="#fff" />
          <Text style={styles.trackText}>Track Driver Live</Text>
        </Pressable>
      )}

      {/* View cash confirmation code — shown whenever a driver could plausibly
          have requested one; getCashOtp itself returns a clear "not
          requested yet" error if not, so this doesn't need to track that
          state separately. */}
      {order.is_cash_delivery && order.payment_status === 'pending_cash' &&
        ['in_transit', 'delivered'].includes(order.status) && (
        <Pressable
          style={[styles.trackBtn, styles.cashCodeBtn]}
          onPress={handleViewCashCode}
          disabled={fetchingCashOtp}
        >
          {fetchingCashOtp
            ? <ActivityIndicator color="#fff" size="small" />
            : <>
                <Ionicons name="key" size={18} color="#fff" />
                <Text style={styles.trackText}>View My Cash Code</Text>
              </>
          }
        </Pressable>
      )}

      {/* Items */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Items</Text>
        {(order.items || []).map((item, i) => (
          <View key={i} style={styles.itemRow}>
            <Text style={styles.itemName}>{item.name || item.product_name}</Text>
            <Text style={styles.itemMeta}>Size {item.size} × {item.quantity}</Text>
            <Text style={styles.itemPrice}>R{item.total_price || item.price * item.quantity}</Text>
          </View>
        ))}
      </View>

      {/* Rate your driver — only shown once, right after delivery completes */}
      {order.status === 'completed' && order.driver_id && !order.has_rating && !ratingSubmitted && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Rate your driver</Text>
          <View style={styles.starRow}>
            {[1, 2, 3, 4, 5].map((star) => (
              <Pressable key={star} onPress={() => setRatingValue(star)} hitSlop={8}>
                <Ionicons
                  name={star <= ratingValue ? 'star' : 'star-outline'}
                  size={32}
                  color="#f59e0b"
                />
              </Pressable>
            ))}
          </View>
          <Pressable style={styles.submitRatingBtn} onPress={handleSubmitRating} disabled={submittingRating}>
            {submittingRating
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.submitRatingText}>Submit Rating</Text>
            }
          </Pressable>
        </View>
      )}
      {order.status === 'completed' && (order.has_rating || ratingSubmitted) && (
        <View style={styles.ratingThanksBanner}>
          <Ionicons name="checkmark-circle" size={16} color="#10b981" />
          <Text style={styles.ratingThanksText}>Thanks for rating your driver!</Text>
        </View>
      )}

      {/* Package protection — pickup/drop-off proof photos, for dispute
          resolution. Never a permanent URL — fetched fresh each time. */}
      {(photos?.pickupPhotoUrl || photos?.dropoffPhotoUrl) && (
        <View style={styles.photosCard}>
          <Text style={styles.photosTitle}>Delivery proof photos</Text>
          <View style={styles.photosRow}>
            {photos.pickupPhotoUrl && (
              <View style={styles.photoBox}>
                <Image source={{ uri: photos.pickupPhotoUrl }} style={styles.photoImg} />
                <Text style={styles.photoLabel}>Pickup</Text>
              </View>
            )}
            {photos.dropoffPhotoUrl && (
              <View style={styles.photoBox}>
                <Image source={{ uri: photos.dropoffPhotoUrl }} style={styles.photoImg} />
                <Text style={styles.photoLabel}>Delivered</Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Cancel */}
      {canCancel && (
        <Pressable style={styles.cancelOrderBtn} onPress={handleCancel}>
          <Ionicons name="close-circle-outline" size={16} color="#dc2626" />
          <Text style={styles.cancelOrderText}>Cancel Order</Text>
        </Pressable>
      )}

      {/* Return */}
      {order.status === 'completed' && !order.return_requested && (() => {
        const { canRequest, message } = getReturnEligibility(order);
        return (
          <View>
            <Pressable
              style={[styles.returnBtn, !canRequest && styles.returnBtnDisabled]}
              onPress={handleReturn}
              disabled={!canRequest}
            >
              <Ionicons name="return-down-back" size={16} color={canRequest ? '#ef4444' : '#9ca3af'} />
              <Text style={[styles.returnText, !canRequest && styles.returnTextDisabled]}>Request Return</Text>
            </Pressable>
            {!canRequest && <Text style={styles.returnHint}>{message}</Text>}
          </View>
        );
      })()}

      {/* FIXED: Refund banner moved inside the single ScrollView.
          It was placed after the closing </ScrollView> tag which created
          invalid JSX and crashed this screen to white for refunded orders. */}
      {order.payment_status === 'refunded' && (
        <View style={styles.refundBanner}>
          <Ionicons name="checkmark-circle" size={16} color="#10b981" />
          <View style={{ flex: 1 }}>
            <Text style={styles.refundTitle}>Refund Initiated</Text>
            <Text style={styles.refundBody}>
              Your refund has been submitted to Paystack. It will appear in your account within 5–10 business days depending on your bank. No action needed from you.
            </Text>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  orderNum: { fontWeight: '700', color: '#6b7280' },
  total: { fontSize: 28, fontWeight: '900', color: '#0a0a0a' },
  pendingBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fde68a', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  pendingBannerText: { color: '#92400e', fontWeight: '700', fontSize: 12 },
  cancelledBanner: { flexDirection: 'row', gap: 10, backgroundColor: '#fef2f2', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#fecaca' },
  cancelledTitle: { color: '#991b1b', fontWeight: '700', fontSize: 13, marginBottom: 3 },
  cancelledBody: { color: '#7f1d1d', fontSize: 12, lineHeight: 18 },
  noDriverBanner: { flexDirection: 'row', gap: 10, backgroundColor: '#fffbeb', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#fde68a' },
  noDriverTitle: { color: '#92400e', fontWeight: '700', fontSize: 13, marginBottom: 3 },
  noDriverBody: { color: '#78350f', fontSize: 12, lineHeight: 18 },
  steps: { gap: 0, marginTop: 8 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  stepLeft: { alignItems: 'center', width: 28 },
  stepDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#e5e7eb', alignItems: 'center', justifyContent: 'center' },
  stepDotDone: { backgroundColor: '#0a0a0a' },
  stepDotActive: { backgroundColor: '#3b82f6' },
  stepLine: { width: 2, height: 28, backgroundColor: '#e5e7eb', marginVertical: 2 },
  stepLineDone: { backgroundColor: '#0a0a0a' },
  stepLabel: { color: '#9ca3af', fontWeight: '600', paddingTop: 6 },
  stepLabelDone: { color: '#111827', fontWeight: '700' },
  trackBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#0a0a0a', paddingVertical: 16, borderRadius: 14 },
  trackText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  cashCodeBtn: { backgroundColor: '#10b981', marginTop: 12 },
  sectionTitle: { fontWeight: '800', fontSize: 16, color: '#111827' },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  itemName: { flex: 1, fontWeight: '700', color: '#111827' },
  itemMeta: { color: '#9ca3af', fontSize: 12 },
  itemPrice: { fontWeight: '800', color: '#0a0a0a' },
  returnBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderColor: '#ef4444', paddingVertical: 14, borderRadius: 14 },
  returnText: { color: '#ef4444', fontWeight: '700' },
  returnBtnDisabled: { borderColor: '#e5e7eb' },
  returnTextDisabled: { color: '#9ca3af' },
  returnHint: { textAlign: 'center', color: '#9ca3af', fontSize: 12, marginTop: 8 },
  cancelOrderBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderColor: '#fecaca', paddingVertical: 14, borderRadius: 14, marginTop: 8 },
  cancelOrderText: { color: '#dc2626', fontWeight: '700' },
  photosCard: { backgroundColor: '#fff', borderRadius: 16, padding: 14, gap: 10, marginTop: 8, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  photosTitle: { fontWeight: '700', color: '#111827', fontSize: 13 },
  photosRow: { flexDirection: 'row', gap: 12 },
  photoBox: { alignItems: 'center', gap: 4 },
  photoImg: { width: 110, height: 110, borderRadius: 12, backgroundColor: '#f3f4f6' },
  photoLabel: { color: '#6b7280', fontSize: 11, fontWeight: '600' },
  starRow: { flexDirection: 'row', gap: 8, justifyContent: 'center' },
  submitRatingBtn: { backgroundColor: '#0a0a0a', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  submitRatingText: { color: '#fff', fontWeight: '700' },
  ratingThanksBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#ecfdf5', borderRadius: 12, padding: 14 },
  ratingThanksText: { color: '#10b981', fontWeight: '600', fontSize: 13 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    refundBanner: { flexDirection: 'row', gap: 10, backgroundColor: '#0d2818', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#10b981' },
    refundTitle: { color: '#10b981', fontWeight: '700', marginBottom: 4 },
    refundBody: { color: '#9ca3af', fontSize: 12, lineHeight: 18 },
});
