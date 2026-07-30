import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable,
  ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import api from '../services/api';

// Reuses the saved-card charge pattern already used for orders
// (api.payments.chargeSavedCard / paymentController.chargeSavedCard) rather
// than the hosted-checkout redirect driver subscriptions use — a premium
// customer very likely already has a saved card from a real order, and
// sending them out to a browser for a one-tap purchase is worse UX with no
// compensating benefit. Drivers can't have saved cards at all (payment_methods
// is FK'd to users, not drivers), which is why that flow has no equivalent.
export default function PremiumScreen() {
  const navigation = useNavigation();
  const [loading, setLoading] = useState(true);
  const [premium, setPremium] = useState(null);
  const [savedCards, setSavedCards] = useState([]);
  const [selectedCardId, setSelectedCardId] = useState(null);
  const [purchasing, setPurchasing] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = async () => {
    try {
      const [statusData, cardsData] = await Promise.all([
        api.subscription.getPremiumStatus(),
        api.payments.getSavedCards().catch(() => ({ cards: [] })),
      ]);
      setPremium(statusData.premium);
      const cards = cardsData.cards || [];
      setSavedCards(cards);
      const defaultCard = cards.find(c => c.is_default) || cards[0];
      if (defaultCard) setSelectedCardId(defaultCard.id);
    } catch (e) {
      console.warn('[Premium] load failed:', e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handlePurchase = () => {
    if (!selectedCardId) {
      Alert.alert('No Card Selected', 'Add a saved card first to subscribe.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Add Card', onPress: () => navigation.navigate('SavedCards') },
      ]);
      return;
    }
    Alert.alert(
      'Subscribe to Flash Premium',
      'R99 will be charged to your selected card. You\'ll get 25% off delivery fees on every order.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pay R99',
          onPress: async () => {
            setPurchasing(true);
            try {
              await api.subscription.purchasePremiumWithCard(selectedCardId);
              Alert.alert(
                'Payment Submitted',
                'Confirming your subscription — this can take a few seconds.',
              );
              // Same pattern as the driver app's post-purchase confirmation:
              // re-check real status rather than assume success, since the
              // webhook confirmation can lag slightly behind the charge call.
              setTimeout(load, 3000);
            } catch (e) {
              Alert.alert('Payment Failed', e.message || 'Could not charge your card. Try again.');
            } finally {
              setPurchasing(false);
            }
          },
        },
      ]
    );
  };

  // Cancel stops future renewal intent only — it never shortens access
  // already paid for. Same behavior and same single-confirmation-step
  // standard as the driver app's equivalent action.
  const handleCancel = () => {
    if (!premium) return;
    const expiresLabel = new Date(premium.expires_at).toLocaleDateString('en-ZA');
    Alert.alert(
      'Cancel Flash Premium?',
      `You'll lose your 25% delivery discount after ${expiresLabel}. Until then, Premium keeps working exactly as it does now.`,
      [
        { text: 'Keep Premium', style: 'cancel' },
        {
          text: 'Cancel Premium',
          style: 'destructive',
          onPress: async () => {
            setCancelling(true);
            try {
              const data = await api.subscription.cancelPremium();
              setPremium(data.subscription);
              Alert.alert('Premium Cancelled', `You'll keep your discount until ${expiresLabel}.`);
            } catch (e) {
              Alert.alert('Error', e.message || 'Could not cancel. Try again.');
            } finally {
              setCancelling(false);
            }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator size="large" color="#f59e0b" />
      </View>
    );
  }

  const isActive = !!premium;

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <View style={s.heroCard}>
        <Ionicons name="flash" size={32} color="#f59e0b" />
        <Text style={s.heroTitle}>Flash Premium</Text>
        <Text style={s.heroPrice}>R99<Text style={s.heroPricePeriod}>/month</Text></Text>
        <Text style={s.heroPerk}>25% off delivery fees on every order</Text>
      </View>

      {isActive && (
        <View style={[s.statusCard, premium.cancelled_at && s.statusCardCancelled]}>
          <Ionicons
            name={premium.cancelled_at ? 'time-outline' : 'checkmark-circle'}
            size={22}
            color={premium.cancelled_at ? '#f59e0b' : '#10b981'}
          />
          <View style={{ flex: 1 }}>
            <Text style={[s.statusTitle, premium.cancelled_at && s.statusTitleCancelled]}>
              {premium.cancelled_at ? 'Premium — Cancelled' : 'Premium — Active'}
            </Text>
            <Text style={s.statusDetail}>
              {premium.cancelled_at
                ? `Discount active until ${new Date(premium.expires_at).toLocaleDateString('en-ZA')} — won't renew`
                : `Renews / expires ${new Date(premium.expires_at).toLocaleDateString('en-ZA')}`}
            </Text>
            {!premium.cancelled_at && (
              <Pressable onPress={handleCancel} disabled={cancelling} style={s.cancelLink}>
                <Text style={s.cancelLinkText}>{cancelling ? 'Cancelling…' : 'Cancel Premium'}</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}

      {!isActive && (
        <>
          <Text style={s.sectionTitle}>Pay With</Text>
          {savedCards.length === 0 ? (
            <Pressable style={s.addCardRow} onPress={() => navigation.navigate('SavedCards')}>
              <Ionicons name="add-circle-outline" size={20} color="#2563eb" />
              <Text style={s.addCardText}>Add a saved card to subscribe</Text>
            </Pressable>
          ) : (
            <View style={s.savedCardsBox}>
              {savedCards.map(card => {
                const active = selectedCardId === card.id;
                return (
                  <Pressable
                    key={card.id}
                    style={[s.savedCardRow, active && s.savedCardRowActive]}
                    onPress={() => setSelectedCardId(card.id)}
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

          <Pressable
            style={[s.payBtn, (purchasing || !selectedCardId) && s.payBtnDisabled]}
            onPress={handlePurchase}
            disabled={purchasing || !selectedCardId}
          >
            {purchasing
              ? <ActivityIndicator color="#fff" />
              : <>
                  <Text style={s.payBtnText}>Subscribe — Pay R99</Text>
                  <Ionicons name="flash" size={18} color="#fff" />
                </>
            }
          </Pressable>
        </>
      )}

      <View style={s.secureRow}>
        <Ionicons name="shield-checkmark-outline" size={16} color="#16a34a" />
        <Text style={s.secureText}>
          Payments secured by Paystack. No card details are stored in the app.
        </Text>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  loadingContainer: { flex: 1, backgroundColor: '#f7f7f7', alignItems: 'center', justifyContent: 'center' },
  heroCard: { backgroundColor: '#0a0a0a', borderRadius: 20, padding: 24, alignItems: 'center', gap: 6 },
  heroTitle: { color: '#fff', fontSize: 20, fontWeight: '800', marginTop: 4 },
  heroPrice: { color: '#f59e0b', fontSize: 32, fontWeight: '900' },
  heroPricePeriod: { color: '#9ca3af', fontSize: 14, fontWeight: '600' },
  heroPerk: { color: '#d1d5db', fontSize: 14, marginTop: 4, textAlign: 'center' },
  statusCard: { backgroundColor: '#0d2818', borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderColor: '#10b981', borderWidth: 1 },
  statusCardCancelled: { backgroundColor: '#2a1f0d', borderColor: '#f59e0b' },
  statusTitle: { color: '#10b981', fontWeight: '700', fontSize: 14 },
  statusTitleCancelled: { color: '#f59e0b' },
  statusDetail: { color: '#6b7280', fontSize: 12, marginTop: 3 },
  cancelLink: { marginTop: 8 },
  cancelLinkText: { color: '#ef4444', fontSize: 12, fontWeight: '700' },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: '#111827', marginTop: 4 },
  addCardRow: { backgroundColor: '#fff', borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: '#e5e7eb' },
  addCardText: { color: '#2563eb', fontWeight: '700' },
  savedCardsBox: { backgroundColor: '#fff', borderRadius: 16, padding: 14, gap: 10, borderWidth: 1, borderColor: '#e5e7eb' },
  savedCardRow: { backgroundColor: '#f9fafb', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#e5e7eb', flexDirection: 'row', alignItems: 'center', gap: 8 },
  savedCardRowActive: { backgroundColor: '#0a0a0a', borderColor: '#0a0a0a' },
  savedCardLabel: { color: '#111827', fontWeight: '700' },
  savedCardLabelActive: { color: '#fff' },
  savedCardMeta: { color: '#6b7280', fontSize: 12, marginTop: 2 },
  savedCardMetaActive: { color: '#d1d5db' },
  payBtn: { backgroundColor: '#0a0a0a', borderRadius: 16, paddingVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 4 },
  payBtnDisabled: { opacity: 0.6 },
  payBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  secureRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  secureText: { color: '#6b7280', fontSize: 12, flex: 1 },
});
