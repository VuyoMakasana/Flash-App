import React, { useState, useMemo } from 'react';
import {
  View, Text, FlatList, Pressable, TextInput, StyleSheet,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useFlash } from '../context/FlashContext';

const RETURN_FEE = 100;

// order.items from GET /orders/:orderId only carries { id, product_name,
// size, quantity, total_price } — no unit_price. total_price is always
// quantity * unit_price at order-creation time (order_items schema), so
// deriving it here matches the server's own stored value exactly without
// needing a backend query change just for a client-side preview.
function unitPriceOf(item) {
  const qty = Number(item.quantity) || 1;
  return Number(item.total_price) / qty;
}

export default function ReturnRequestScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { order } = route.params || {};
  const { requestReturn } = useFlash();

  // Map of order_item_id -> selected quantity (absent/0 = not selected)
  const [selected, setSelected] = useState({});
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const items = order?.items || [];

  const toggleItem = (item) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[item.id]) {
        delete next[item.id];
      } else {
        next[item.id] = 1;
      }
      return next;
    });
  };

  const changeQty = (item, delta) => {
    setSelected((prev) => {
      const current = prev[item.id] || 0;
      const nextQty = Math.min(item.quantity, Math.max(1, current + delta));
      return { ...prev, [item.id]: nextQty };
    });
  };

  const { selectedCount, selectedSubtotal } = useMemo(() => {
    let count = 0;
    let subtotal = 0;
    for (const item of items) {
      const qty = selected[item.id];
      if (!qty) continue;
      count += qty;
      subtotal += unitPriceOf(item) * qty;
    }
    return { selectedCount: count, selectedSubtotal: subtotal };
  }, [selected, items]);

  const refundTotal = Math.max(0, selectedSubtotal - RETURN_FEE);
  const canSubmit = selectedCount > 0 && selectedSubtotal >= RETURN_FEE && !submitting;

  const handleSubmit = async () => {
    const returnItems = Object.entries(selected)
      .filter(([, qty]) => qty > 0)
      .map(([order_item_id, quantity_returned]) => ({ order_item_id, quantity_returned }));

    setSubmitting(true);
    try {
      await requestReturn(order.id, returnItems, reason.trim() || null);
      Alert.alert('Return Submitted', 'We\'ll let you know once it\'s been reviewed.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      if (e.message === 'SESSION_EXPIRED') return;
      Alert.alert('Could Not Submit Return', e.message || 'Please try again.');
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

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.container}>
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Text style={styles.intro}>Select the items you'd like to return.</Text>
          }
          renderItem={({ item }) => {
            const qty = selected[item.id] || 0;
            const isSelected = qty > 0;
            return (
              <View style={styles.card}>
                <Pressable style={styles.checkbox} onPress={() => toggleItem(item)} hitSlop={8}>
                  <Ionicons
                    name={isSelected ? 'checkbox' : 'square-outline'}
                    size={24}
                    color={isSelected ? '#0a0a0a' : '#9ca3af'}
                  />
                </Pressable>
                <View style={styles.info}>
                  <Text style={styles.name} numberOfLines={2}>{item.product_name}</Text>
                  <Text style={styles.meta}>Size {item.size} · Bought {item.quantity}</Text>
                  <Text style={styles.price}>R{unitPriceOf(item).toFixed(2)} each</Text>
                </View>
                {isSelected && item.quantity > 1 && (
                  <View style={styles.qtyRow}>
                    <Pressable style={styles.qBtn} onPress={() => changeQty(item, -1)}>
                      <Ionicons name="remove" size={16} color="#111827" />
                    </Pressable>
                    <Text style={styles.qty}>{qty}</Text>
                    <Pressable style={styles.qBtn} onPress={() => changeQty(item, 1)}>
                      <Ionicons name="add" size={16} color="#111827" />
                    </Pressable>
                  </View>
                )}
              </View>
            );
          }}
          ListFooterComponent={
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
          }
        />

        <View style={styles.footer}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>{selectedCount} item{selectedCount === 1 ? '' : 's'} selected</Text>
            <Text style={styles.summaryValue}>Fee R{RETURN_FEE.toFixed(2)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabelBold}>You'll be refunded</Text>
            <Text style={styles.refundValue}>R{refundTotal.toFixed(2)}</Text>
          </View>
          {selectedCount > 0 && selectedSubtotal < RETURN_FEE && (
            <Text style={styles.warning}>Selected items must total at least R{RETURN_FEE.toFixed(2)} to submit a return.</Text>
          )}
          <Pressable style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]} onPress={handleSubmit} disabled={!canSubmit}>
            {submitting
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.submitText}>Submit Return — Fee R{RETURN_FEE.toFixed(2)}</Text>
            }
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  list: { padding: 16, gap: 12, paddingBottom: 20 },
  intro: { color: '#6b7280', fontWeight: '600', marginBottom: 4 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  checkbox: { padding: 2 },
  info: { flex: 1, gap: 4 },
  name: { fontWeight: '700', color: '#111827', fontSize: 14 },
  meta: { color: '#9ca3af', fontSize: 12 },
  price: { fontWeight: '800', color: '#0a0a0a', fontSize: 14 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  qBtn: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#f3f4f6', alignItems: 'center', justifyContent: 'center' },
  qty: { fontWeight: '800', fontSize: 16, color: '#0a0a0a', minWidth: 20, textAlign: 'center' },
  reasonCard: { backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 8, marginTop: 4, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  reasonLabel: { fontWeight: '700', color: '#111827', fontSize: 14 },
  reasonInput: { minHeight: 70, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 12, fontSize: 14, color: '#111827', textAlignVertical: 'top' },
  footer: { backgroundColor: '#fff', padding: 20, gap: 10, borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summaryLabel: { color: '#6b7280', fontWeight: '600' },
  summaryLabelBold: { color: '#111827', fontWeight: '700' },
  summaryValue: { fontWeight: '700', color: '#374151' },
  refundValue: { fontWeight: '800', fontSize: 20, color: '#0a0a0a' },
  warning: { color: '#dc2626', fontSize: 12, fontWeight: '600' },
  submitBtn: { backgroundColor: '#0a0a0a', paddingVertical: 16, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 4 },
  submitBtnDisabled: { backgroundColor: '#d1d5db' },
  submitText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
