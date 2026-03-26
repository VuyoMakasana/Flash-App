import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useFlash } from '../context/FlashContext';
import api from '../services/api';

const STEPS = [
  { key: 'paid',            label: 'Order Confirmed', icon: 'checkmark-circle' },
  { key: 'driver_assigned', label: 'Driver Assigned', icon: 'person' },
  { key: 'en_route',        label: 'On the Way',      icon: 'car' },
  { key: 'picked_up',       label: 'Picked Up',       icon: 'bag' },
  { key: 'delivered',       label: 'Delivered',       icon: 'home' },
];

const ORDER_RANK = { paid: 1, driver_assigned: 2, en_route: 3, picked_up: 4, delivered: 5, completed: 5 };

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
      {['driver_assigned', 'en_route', 'picked_up'].includes(order.status) && (
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
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  orderNum: { fontWeight: '700', color: '#6b7280' },
  total: { fontSize: 28, fontWeight: '900', color: '#0a0a0a' },
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
});
