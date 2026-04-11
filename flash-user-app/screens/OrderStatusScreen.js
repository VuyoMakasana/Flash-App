import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useFlash } from '../context/FlashContext';
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

const ORDER_RANK = {
  paid: 1,
  driver_assigned: 2,
  driver_arrived_store: 3,
  picked_up: 4,
  in_transit: 5,
  delivered: 6,
  completed: 6,
};

export default function OrderStatusScreen() {
  const navigation  = useNavigation();
  const route       = useRoute();
  const { order: routeOrder, orderId } = route.params || {};
  const { requestReturn } = useFlash();

  const [order,     setOrder]     = useState(routeOrder || null);
  const [loading,   setLoading]   = useState(!routeOrder && !!orderId);
  const [returning, setReturning] = useState(false);

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
    Alert.alert('Request Return', 'Are you sure you want to request a return?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Yes, Return',
        style: 'destructive',
        onPress: async () => {
          setReturning(true);
          try {
            await requestReturn(order.id, 'Customer requested return');
            Alert.alert('Return Requested', 'Our team will contact you within 24 hours.');
          } catch (e) {
            // Handle session expiry gracefully — don't show error, just redirect to login
            if (e.message === 'SESSION_EXPIRED') return;
            Alert.alert('Error', 'Could not submit return request.');
          } finally {
            setReturning(false);
          }
        },
      },
    ]);
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

      {/* Return */}
      {order.status === 'completed' && !order.return_requested && (
        <Pressable style={styles.returnBtn} onPress={handleReturn} disabled={returning}>
          {returning
            ? <ActivityIndicator color="#ef4444" />
            : <>
                <Ionicons name="return-down-back" size={16} color="#ef4444" />
                <Text style={styles.returnText}>Request Return</Text>
              </>
          }
        </Pressable>
      )}
    </ScrollView>

        {/* IMPROVED: Added clear refund timeline messaging — users were getting no information
            after cancellation and messaging support constantly asking where their money was */}
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
  sectionTitle: { fontWeight: '800', fontSize: 16, color: '#111827' },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  itemName: { flex: 1, fontWeight: '700', color: '#111827' },
  itemMeta: { color: '#9ca3af', fontSize: 12 },
  itemPrice: { fontWeight: '800', color: '#0a0a0a' },
  returnBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderColor: '#ef4444', paddingVertical: 14, borderRadius: 14 },
  returnText: { color: '#ef4444', fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    refundBanner: { flexDirection: 'row', gap: 10, backgroundColor: '#0d2818', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#10b981' },
    refundTitle: { color: '#10b981', fontWeight: '700', marginBottom: 4 },
    refundBody: { color: '#9ca3af', fontSize: 12, lineHeight: 18 },
});
