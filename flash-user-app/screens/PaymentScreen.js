import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView,
  ActivityIndicator, Alert, Platform, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import analytics from '../services/analytics';
import usePaymentConfirmation from '../hooks/usePaymentConfirmation';

// FI-096 (#100): card only. The live Paystack key is now in Render, so Card
// is shown again (it was hidden while card payments couldn't work).
// Cash is HIDDEN, deliberately: today "Pay on Delivery" collects the whole
// order total in cash, items included, and nothing reconciles the item money
// a driver collects (FI-092). Founder decision 3 is "items always by card;
// only the delivery fee may be cash". Cash comes back only with that
// fee-only flow. The cash_orders kill switch refuses it server-side too.
const ALL_PAYMENT_METHODS = [
  { id: 'card',     label: 'Card / EFT / Capitec Pay', icon: 'card-outline',     description: 'Visa, Mastercard, Instant EFT, Capitec Pay', supported: true },
  // Payflex (BNPL) removed — integration not yet complete. Re-add when live.
  { id: 'cash',     label: 'Pay on Delivery',           icon: 'cash-outline',     description: 'Pay the driver face-to-face',                supported: true },
];
const PAYMENT_METHODS = ALL_PAYMENT_METHODS.filter(m => m.id === 'card');

export default function PaymentScreen() {
  const navigation = useNavigation();
  const route      = useRoute();
  const { orderId, total: estimatedTotal, requestedDriverId } = route.params || {};

  const [selected, setSelected] = useState('card');
  const [loading,  setLoading]  = useState(false);
  const [savedCards, setSavedCards] = useState([]);
  const [selectedCardId, setSelectedCardId] = useState(null);
  const [useNewCard, setUseNewCard] = useState(false);
  // The Paystack page for this order, kept so "Reopen payment page" works:
  // within 2 minutes the backend answers a second initialize with the same
  // reference but no URL (it won't start a second charge).
  const [paymentUrl, setPaymentUrl] = useState(null);
  const confirmation = usePaymentConfirmation(orderId);
  const waitingForPayment = ['waiting', 'checking'].includes(confirmation.state);

  useFocusEffect(useCallback(() => { analytics.screenViewed('Payment'); }, []));
  // The checkout screen's total is a client-side estimate (fleet mode
  // defaults to R90 same-mall and only learns the real R180 cross-mall fee
  // after the order is created) — what Paystack actually charges is
  // order.total from the server. Fetching the confirmed order here so the
  // amount shown is guaranteed to match the amount charged, not an estimate
  // that could turn out wrong.
  const [confirmedOrder, setConfirmedOrder] = useState(null);
  const total = confirmedOrder ? parseFloat(confirmedOrder.total) : estimatedTotal;

  useEffect(() => {
    const loadCards = async () => {
      try {
        const data = await api.payments.getSavedCards();
        const cards = data.cards || [];
        setSavedCards(cards);
        const defaultCard = cards.find(c => c.is_default) || cards[0];
        if (defaultCard) setSelectedCardId(defaultCard.id);
      } catch (_) {
        // Saved cards are optional. Keep regular card checkout available.
      }
    };

    const loadOrder = async () => {
      if (!orderId) return;
      try {
        const data = await api.orders.getOrder(orderId);
        if (data?.order) setConfirmedOrder(data.order);
      } catch (_) {
        // Falls back to the estimated total passed via navigation — payment
        // itself is still charged server-side against the real order.total
        // regardless of what this screen manages to display.
      }
    };

    loadCards();
    loadOrder();
  }, [orderId]);

  const goToOrderStatus = async (oid) => {
    try {
      const data = await api.orders.getOrder(oid);
      navigation.replace('OrderStatus', { order: data.order });
    } catch (_) {
      navigation.replace('OrderStatus', { orderId: oid });
    }
  };

  const assignPreferredDriverIfNeeded = async (oid) => {
    if (!requestedDriverId) return;
    try {
      await api.orders.selectDriver(oid, requestedDriverId);
    } catch (err) {
      Alert.alert(
        'Driver selection update',
        err.message || 'Your payment succeeded, but selected driver could not be assigned. We\'ll auto-match you with the next available driver.'
      );
    }
  };

  const openPaymentPage = async (url) => {
    const supported = await Linking.canOpenURL(url);
    if (!supported) {
      Alert.alert('Error', 'Could not open the secure payment page. Please try again.');
      return;
    }
    confirmation.startAfterBrowser();
    await Linking.openURL(url);
  };

  // Paid: assign the chosen driver (if any) once, then show the order.
  const handledPaidRef = useRef(false);
  useEffect(() => {
    if (confirmation.state !== 'paid' || handledPaidRef.current) return;
    handledPaidRef.current = true;
    (async () => {
      await assignPreferredDriverIfNeeded(orderId);
      await goToOrderStatus(orderId);
    })();
  }, [confirmation.state]);

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
        await assignPreferredDriverIfNeeded(orderId);
        await goToOrderStatus(orderId);
        return;
      }

      // ── Payflex removed — handler kept but unreachable until re-enabled ──────
      // if (selected === 'payflex') { ... }

      if (selected === 'card' && selectedCardId && !useNewCard) {
        // A saved card is charged by the backend; Paystack confirms it via
        // the webhook. Wait here for that confirmation (no browser involved).
        await api.payments.chargeSavedCard(orderId, selectedCardId);
        confirmation.startNow();
        return;
      }

      // ── Card via Paystack ──────────────────────────────────────────────────
      // Paystack's secure page opens in the browser (no card details ever
      // enter the app). Opening it doesn't mean the customer has paid, so
      // the app waits for them to come back and then asks the backend
      // (usePaymentConfirmation), instead of checking straight away.
      const data = await api.payments.initialize(orderId);

      if (data.authorizationUrl) {
        setPaymentUrl(data.authorizationUrl);
        await openPaymentPage(data.authorizationUrl);
        return;
      }

      if (data.awaitingWebhook) {
        // A payment for this order was already started a moment ago.
        if (paymentUrl) {
          await openPaymentPage(paymentUrl);
        } else {
          confirmation.startNow();
        }
        return;
      }

      Alert.alert('Payment', 'Could not start the payment. Please try again.');

    } catch (err) {
      // Handle session expiry gracefully — don't show error, just redirect to login
      if (err.message === 'SESSION_EXPIRED') return;
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

        {/* Itemized breakdown — sourced from the server-confirmed order once
            loaded, not the checkout screen's earlier estimate, so nothing
            shown here can differ from what actually gets charged. */}
        {confirmedOrder && (
          <View style={s.breakdown}>
            <View style={s.breakdownRow}>
              <Text style={s.breakdownLabel}>Subtotal</Text>
              <Text style={s.breakdownValue}>R{parseFloat(confirmedOrder.subtotal || 0).toFixed(2)}</Text>
            </View>
            <View style={s.breakdownRow}>
              <Text style={s.breakdownLabel}>Delivery fee</Text>
              <Text style={s.breakdownValue}>R{parseFloat(confirmedOrder.delivery_fee || 0).toFixed(2)}</Text>
            </View>
            <View style={[s.breakdownRow, s.breakdownTotalRow]}>
              <Text style={s.breakdownTotalLabel}>Total</Text>
              <Text style={s.breakdownTotalValue}>R{parseFloat(confirmedOrder.total || 0).toFixed(2)}</Text>
            </View>
          </View>
        )}
      </View>

      <Text style={s.sectionTitle}>Select Payment Method</Text>

      {PAYMENT_METHODS.map(method => {
        const active = selected === method.id;
        return (
          <Pressable
            key={method.id}
            style={[s.methodCard, active && s.methodActive]}
            onPress={() => { setSelected(method.id); analytics.paymentMethodSelected(method.id); }}
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

      {selected === 'card' && savedCards.length > 0 && (
        <View style={s.savedCardsBox}>
          <View style={s.savedCardsHeader}>
            <Text style={s.savedCardsTitle}>Saved Cards</Text>
            <Pressable onPress={() => navigation.navigate('SavedCards')}>
              <Text style={s.manageText}>Manage</Text>
            </Pressable>
          </View>
          <Pressable
            style={[s.savedCardRow, useNewCard && s.savedCardRowActive]}
            onPress={() => setUseNewCard(true)}
          >
            <View style={{ flex: 1 }}>
              <Text style={[s.savedCardLabel, useNewCard && s.savedCardLabelActive]}>
                Pay With New Card
              </Text>
              <Text style={[s.savedCardMeta, useNewCard && s.savedCardMetaActive]}>
                Opens secure Paystack checkout
              </Text>
            </View>
            <Ionicons
              name={useNewCard ? 'checkmark-circle' : 'ellipse-outline'}
              size={20}
              color={useNewCard ? '#fff' : '#9ca3af'}
            />
          </Pressable>
          {savedCards.map(card => {
            const active = selectedCardId === card.id && !useNewCard;
            return (
              <Pressable
                key={card.id}
                style={[s.savedCardRow, active && s.savedCardRowActive]}
                onPress={() => {
                  setUseNewCard(false);
                  setSelectedCardId(card.id);
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[s.savedCardLabel, active && s.savedCardLabelActive]}>
                    {String(card.brand || 'Card').toUpperCase()} •••• {card.last4}
                  </Text>
                  <Text style={[s.savedCardMeta, active && s.savedCardMetaActive]}>
                    Expires {card.exp_month}/{card.exp_year}{card.is_default ? '  •  Default' : ''}
                  </Text>
                </View>
                <Ionicons
                  name={active ? 'checkmark-circle' : 'ellipse-outline'}
                  size={20}
                  color={active ? '#fff' : '#9ca3af'}
                />
              </Pressable>
            );
          })}
        </View>
      )}

      {confirmation.state !== 'idle' && confirmation.state !== 'paid' && (
        <View style={s.statusBox}>
          {confirmation.state === 'waiting' && (
            <>
              <Text style={s.statusTitle}>Finish paying on the Paystack page</Text>
              <Text style={s.statusText}>
                When you've paid, come back to Flash. We'll confirm your payment here automatically.
              </Text>
              {paymentUrl && (
                <Pressable style={s.statusBtn} onPress={() => openPaymentPage(paymentUrl)}>
                  <Text style={s.statusBtnText}>Reopen payment page</Text>
                </Pressable>
              )}
              <Pressable style={s.statusLink} onPress={confirmation.checkNow}>
                <Text style={s.statusLinkText}>I've paid. Check now</Text>
              </Pressable>
            </>
          )}
          {confirmation.state === 'checking' && (
            <View style={s.statusRow}>
              <ActivityIndicator color="#111827" />
              <Text style={s.statusText}>Confirming your payment…</Text>
            </View>
          )}
          {confirmation.state === 'timeout' && (
            <>
              <Text style={s.statusTitle}>Still confirming your payment</Text>
              <Text style={s.statusText}>
                We haven't heard from Paystack yet. If you paid, it will show on your order shortly. You won't be charged twice.
              </Text>
              <Pressable style={s.statusBtn} onPress={confirmation.checkNow}>
                <Text style={s.statusBtnText}>Check again</Text>
              </Pressable>
              <Pressable style={s.statusLink} onPress={() => goToOrderStatus(orderId)}>
                <Text style={s.statusLinkText}>View my order</Text>
              </Pressable>
            </>
          )}
          {confirmation.state === 'failed' && (
            <>
              <Text style={s.statusTitle}>Payment not completed</Text>
              <Text style={s.statusText}>{confirmation.detail}</Text>
              <Pressable style={s.statusBtn} onPress={() => { setPaymentUrl(null); confirmation.reset(); }}>
                <Text style={s.statusBtnText}>Try again</Text>
              </Pressable>
            </>
          )}
        </View>
      )}

      <View style={s.secureRow}>
        <Ionicons name="shield-checkmark-outline" size={16} color="#16a34a" />
        <Text style={s.secureText}>
          Payments secured by Paystack. No card details are stored in the app.
        </Text>
      </View>

      <Pressable
        style={[s.payBtn, (loading || waitingForPayment) && s.payBtnDisabled]}
        onPress={handlePayment}
        disabled={loading || waitingForPayment}
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
  breakdown:        { width: '100%', marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#27272a', gap: 8 },
  breakdownRow:     { flexDirection: 'row', justifyContent: 'space-between' },
  breakdownLabel:   { color: '#9ca3af', fontSize: 13 },
  breakdownValue:   { color: '#d1d5db', fontSize: 13, fontWeight: '600' },
  breakdownTotalRow:{ marginTop: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#27272a' },
  breakdownTotalLabel: { color: '#fff', fontSize: 14, fontWeight: '800' },
  breakdownTotalValue: { color: '#fff', fontSize: 14, fontWeight: '800' },
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
  savedCardsBox:    { backgroundColor: '#fff', borderRadius: 16, padding: 14, gap: 10, borderWidth: 1, borderColor: '#e5e7eb' },
  savedCardsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  savedCardsTitle:  { color: '#111827', fontWeight: '800' },
  manageText:       { color: '#2563eb', fontWeight: '700' },
  savedCardRow:     { backgroundColor: '#f9fafb', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#e5e7eb', flexDirection: 'row', alignItems: 'center', gap: 8 },
  savedCardRowActive:{ backgroundColor: '#0a0a0a', borderColor: '#0a0a0a' },
  savedCardLabel:   { color: '#111827', fontWeight: '700' },
  savedCardLabelActive:{ color: '#fff' },
  savedCardMeta:    { color: '#6b7280', fontSize: 12, marginTop: 2 },
  savedCardMetaActive:{ color: '#d1d5db' },
  badge:            { backgroundColor: '#111827', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  badgeText:        { color: '#fff', fontSize: 10, fontWeight: '700' },
  secureRow:        { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  secureText:       { color: '#6b7280', fontSize: 12, flex: 1 },
  payBtn:           { backgroundColor: '#0a0a0a', borderRadius: 16, paddingVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 4 },
  payBtnDisabled:   { opacity: 0.6 },
  payBtnText:       { color: '#fff', fontWeight: '800', fontSize: 16 },
  statusBox:        { backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 10, borderWidth: 1, borderColor: '#e5e7eb' },
  statusRow:        { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusTitle:      { color: '#111827', fontWeight: '800', fontSize: 15 },
  statusText:       { color: '#374151', fontSize: 13, lineHeight: 19, flexShrink: 1 },
  statusBtn:        { backgroundColor: '#0a0a0a', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  statusBtnText:    { color: '#fff', fontWeight: '800' },
  statusLink:       { alignItems: 'center', paddingVertical: 4 },
  statusLinkText:   { color: '#2563eb', fontWeight: '700' },
});