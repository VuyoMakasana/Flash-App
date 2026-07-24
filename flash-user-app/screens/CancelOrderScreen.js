import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, Pressable, TextInput, StyleSheet,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import api from '../services/api';

// A real, required confirmation step before any cancellation with a real
// financial consequence finalizes — the exact amounts are always shown
// before the "Confirm Cancellation" action, never a single ambiguous
// "Cancel" button that fires immediately.
export default function CancelOrderScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { order } = route.params || {};

  const [loading, setLoading]       = useState(true);
  const [preview, setPreview]       = useState(null);
  const [loadError, setLoadError]   = useState(null);
  const [reason, setReason]         = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!order?.id) return;
    (async () => {
      try {
        const data = await api.orders.getCancellationPreview(order.id);
        setPreview(data);
      } catch (e) {
        setLoadError(e.message || 'Could not load cancellation details.');
      } finally {
        setLoading(false);
      }
    })();
  }, [order?.id]);

  const handleConfirm = () => {
    Alert.alert(
      'Confirm Cancellation',
      'This cannot be undone. Are you sure you want to cancel this order?',
      [
        { text: 'No, keep order', style: 'cancel' },
        { text: 'Yes, Cancel Order', style: 'destructive', onPress: submitCancellation },
      ],
    );
  };

  const submitCancellation = async () => {
    setSubmitting(true);
    try {
      await api.orders.cancel(order.id, { reason: reason.trim() || null });
      Alert.alert('Order Cancelled', 'Your cancellation has been processed.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      if (e.message === 'SESSION_EXPIRED') return;
      Alert.alert('Could Not Cancel Order', e.message || 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!order) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={48} color="#d1d5db" />
        <Text style={{ color: '#9ca3af', marginTop: 12 }}>Order not found</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0a0a0a" />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={48} color="#d1d5db" />
        <Text style={{ color: '#9ca3af', marginTop: 12, textAlign: 'center', paddingHorizontal: 24 }}>{loadError}</Text>
      </View>
    );
  }

  const rand = (n) => `R${parseFloat(n || 0).toFixed(2)}`;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.orderNumber}>Order {order.order_number}</Text>

          {preview.fullRefund ? (
            <View style={styles.card}>
              <Ionicons name="checkmark-circle-outline" size={22} color="#10b981" />
              <Text style={styles.fullRefundTitle}>Full refund</Text>
              <Text style={styles.fullRefundBody}>
                No driver has been assigned to this order yet, so you'll receive a full refund to your original payment method (or nothing is charged at all for cash orders).
              </Text>
            </View>
          ) : (
            <View style={styles.card}>
              <Ionicons name="information-circle-outline" size={22} color="#f59e0b" />
              <Text style={styles.splitTitle}>A driver is already assigned to this order</Text>
              <Text style={styles.splitBody}>
                Cancelling now splits the item value: the store keeps 10%, your driver is compensated 5% for the trip already started, and you get the rest back — plus your full delivery fee, in full, since delivery never happened.
              </Text>

              <View style={styles.breakdown}>
                <Row label="Item value" value={rand(preview.itemValue)} />
                <Row label="To the store (10%)" value={`− ${rand(preview.storeAmount)}`} />
                <Row label="To your driver (5%)" value={`− ${rand(preview.driverAmount)}`} />
                <View style={styles.divider} />
                {preview.isCash ? (
                  <>
                    <Row label="You haven't been charged yet" value={rand(0)} bold />
                    <Text style={styles.cashNote}>
                      This is a cash order — nothing has been collected from you. Your driver is still compensated {rand(preview.driverAmount)} for the trip already started.
                    </Text>
                  </>
                ) : (
                  <>
                    <Row label="Refund of item value (85%)" value={rand(preview.customerItemRefund)} />
                    <Row label="Delivery fee refunded (100%)" value={rand(preview.deliveryFeeRefund)} />
                    <Row label="Total you'll be refunded" value={rand(preview.totalCustomerRefund)} bold />
                  </>
                )}
              </View>
            </View>
          )}

          <View style={styles.reasonCard}>
            <Text style={styles.reasonLabel}>Reason (optional)</Text>
            <TextInput
              style={styles.reasonInput}
              placeholder="Tell us what happened…"
              placeholderTextColor="#9ca3af"
              value={reason}
              onChangeText={setReason}
              multiline
            />
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            style={[styles.confirmBtn, submitting && styles.confirmBtnDisabled]}
            onPress={handleConfirm}
            disabled={submitting}
          >
            {submitting
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.confirmText}>Confirm Cancellation</Text>
            }
          </Pressable>
          <Pressable style={styles.keepBtn} onPress={() => navigation.goBack()} disabled={submitting}>
            <Text style={styles.keepText}>Keep My Order</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function Row({ label, value, bold }) {
  return (
    <View style={styles.row}>
      <Text style={bold ? styles.rowLabelBold : styles.rowLabel}>{label}</Text>
      <Text style={bold ? styles.rowValueBold : styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  scroll: { padding: 16, gap: 16, paddingBottom: 20 },
  orderNumber: { color: '#6b7280', fontWeight: '600', marginBottom: 4 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 8, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  fullRefundTitle: { fontWeight: '800', fontSize: 16, color: '#065f46' },
  fullRefundBody: { color: '#374151', fontSize: 13, lineHeight: 19 },
  splitTitle: { fontWeight: '800', fontSize: 16, color: '#92400e' },
  splitBody: { color: '#374151', fontSize: 13, lineHeight: 19 },
  breakdown: { marginTop: 8, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowLabel: { color: '#6b7280', fontSize: 13 },
  rowValue: { color: '#374151', fontSize: 13, fontWeight: '600' },
  rowLabelBold: { color: '#111827', fontSize: 14, fontWeight: '800' },
  rowValueBold: { color: '#0a0a0a', fontSize: 16, fontWeight: '800' },
  divider: { height: 1, backgroundColor: '#f3f4f6', marginVertical: 6 },
  cashNote: { color: '#92400e', fontSize: 12, lineHeight: 17, marginTop: 4 },
  reasonCard: { backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 8, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  reasonLabel: { fontWeight: '700', color: '#111827', fontSize: 14 },
  reasonInput: { minHeight: 70, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 12, fontSize: 14, color: '#111827', textAlignVertical: 'top' },
  footer: { backgroundColor: '#fff', padding: 20, gap: 10, borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  confirmBtn: { backgroundColor: '#dc2626', paddingVertical: 16, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  confirmBtnDisabled: { backgroundColor: '#d1d5db' },
  confirmText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  keepBtn: { paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  keepText: { color: '#6b7280', fontWeight: '700', fontSize: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
