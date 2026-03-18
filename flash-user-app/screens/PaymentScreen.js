import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView,
  ActivityIndicator, Alert, Platform, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import api from '../services/api';

const PAYMENT_METHODS = [
  { id: 'card',     label: 'Card / EFT / Capitec Pay', icon: 'card-outline',     description: 'Visa, Mastercard, Instant EFT, Capitec Pay', supported: true },
  { id: 'payflex',  label: 'Payflex',                  icon: 'calendar-outline', description: 'Buy now, pay in 4 instalments',              supported: true, badge: 'BNPL' },
  { id: 'cash',     label: 'Pay on Delivery',           icon: 'cash-outline',     description: 'Pay the driver face-to-face',                supported: true },
];

export default function PaymentScreen() {
  const navigation = useNavigation();
  const route      = useRoute();
  const { orderId, total } = route.params || {};

  const [selected, setSelected] = useState('card');
  const [loading,  setLoading]  = useState(false);

  const goToOrderStatus = async (oid) => {
    try {
      const data = await api.orders.getOrder(oid);
      navigation.replace('OrderStatus', { order: data.order });
    } catch (_) {
      navigation.replace('OrderStatus', { orderId: oid });
    }
  };

  const handlePayment = async () => {
    if (!orderId) {
      Alert.alert('Error', 'No order found. Please try again.');
      return;
    }
    setLoading(true);
    try {

      // ── Cash on delivery ───────────────────────────────────────────────────
      if (selected === 'cash') {
        await api.payments.cashOnDelivery(orderId);
        await goToOrderStatus(orderId);
        return;
      }

      // ── Payflex ────────────────────────────────────────────────────────────
      if (selected === 'payflex') {
        const data = await api.payments.initPayflex(orderId);
        if (data.checkoutUrl) {
          await Linking.openURL(data.checkoutUrl);
          await goToOrderStatus(orderId);
        }
        return;
      }

      // ── Card via Paystack ──────────────────────────────────────────────────
      // Paystack opens a secure hosted payment page — no card details ever
      // enter the app. The user pays on Paystack's page, then returns here.
      // After returning, we verify the payment with our backend.
      const data = await api.payments.initialize(orderId);

      if (data.authorizationUrl) {
        // Open Paystack payment page in the device browser
        const supported = await Linking.canOpenURL(data.authorizationUrl);
        if (supported) {
          await Linking.openURL(data.authorizationUrl);
          // After the user pays, they return to the app.
          // The webhook on the backend will mark the order as paid automatically.
          // We then verify and navigate to order status.
          await api.payments.verify(data.reference);
          await goToOrderStatus(orderId);
        } else {
          Alert.alert('Error', 'Could not open payment page. Please try cash on delivery.');
        }
      }

    } catch (err) {
      Alert.alert('Payment Failed', err.message || 'Could not process payment. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>

      <View style={s.amountCard}>
        <Text style={s.amountLabel}>Order Total</Text>
        <Text style={s.amount}>R{parseFloat(total || 0).toFixed(2)}</Text>
        <Text style={s.orderId}>Order #{orderId?.slice(-8)?.toUpperCase()}</Text>
      </View>

      <Text style={s.sectionTitle}>Select Payment Method</Text>

      {PAYMENT_METHODS.map(method => {
        const active = selected === method.id;
        return (
          <Pressable
            key={method.id}
            style={[s.methodCard, active && s.methodActive]}
            onPress={() => setSelected(method.id)}
          >
            <View style={[s.methodIcon, active && s.methodIconActive]}>
              <Ionicons name={method.icon} size={22} color={active ? '#fff' : '#374151'} />
            </View>
            <View style={{ flex: 1 }}>
              <View style={s.methodRow}>
                <Text style={[s.methodLabel, active && s.methodLabelActive]}>{method.label}</Text>
                {method.badge && <View style={s.badge}><Text style={s.badgeText}>{method.badge}</Text></View>}
              </View>
              <Text style={[s.methodDesc, active && s.methodDescActive]}>{method.description}</Text>
            </View>
            <Ionicons name={active ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={active ? '#fff' : '#d1d5db'} />
          </Pressable>
        );
      })}

      <View style={s.secureRow}>
        <Ionicons name="shield-checkmark-outline" size={16} color="#16a34a" />
        <Text style={s.secureText}>
          Payments secured by Paystack. No card details are stored in the app.
        </Text>
      </View>

      <Pressable
        style={[s.payBtn, loading && s.payBtnDisabled]}
        onPress={handlePayment}
        disabled={loading}
      >
        {loading
          ? <ActivityIndicator color="#fff" />
          : <>
              <Text style={s.payBtnText}>
                {selected === 'cash'
                  ? 'Confirm Order (Pay on Delivery)'
                  : `Pay R${parseFloat(total || 0).toFixed(2)}`}
              </Text>
              <Ionicons name="flash" size={18} color="#fff" />
            </>
        }
      </Pressable>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#f7f7f7' },
  content:          { padding: 16, gap: 14, paddingBottom: 40 },
  amountCard:       { backgroundColor: '#0a0a0a', borderRadius: 20, padding: 24, alignItems: 'center', gap: 4 },
  amountLabel:      { color: '#9ca3af', fontWeight: '600' },
  amount:           { color: '#fff', fontSize: 36, fontWeight: '900' },
  orderId:          { color: '#6b7280', fontSize: 12, marginTop: 4 },
  sectionTitle:     { fontSize: 18, fontWeight: '800', color: '#111827', marginTop: 4 },
  methodCard:       { backgroundColor: '#fff', borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1.5, borderColor: '#e5e7eb', shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 8, elevation: 2 },
  methodActive:     { backgroundColor: '#0a0a0a', borderColor: '#0a0a0a' },
  methodIcon:       { width: 44, height: 44, borderRadius: 12, backgroundColor: '#f3f4f6', alignItems: 'center', justifyContent: 'center' },
  methodIconActive: { backgroundColor: '#111827' },
  methodRow:        { flexDirection: 'row', alignItems: 'center', gap: 8 },
  methodLabel:      { fontWeight: '700', color: '#111827', fontSize: 15 },
  methodLabelActive:{ color: '#fff' },
  methodDesc:       { color: '#6b7280', fontSize: 12, marginTop: 2 },
  methodDescActive: { color: '#9ca3af' },
  badge:            { backgroundColor: '#111827', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  badgeText:        { color: '#fff', fontSize: 10, fontWeight: '700' },
  secureRow:        { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  secureText:       { color: '#6b7280', fontSize: 12, flex: 1 },
  payBtn:           { backgroundColor: '#0a0a0a', borderRadius: 16, paddingVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 4 },
  payBtnDisabled:   { opacity: 0.6 },
  payBtnText:       { color: '#fff', fontWeight: '800', fontSize: 16 },
});
