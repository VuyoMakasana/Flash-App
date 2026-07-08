import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';

// ─────────────────────────────────────────────────────────────────────────────
// SAVED CARDS — Paystack handles card saving automatically.
// After a user pays for the first time, Paystack returns an authorization_code
// which our webhook saves to the saved_cards table.
// From that point, the user's card appears here and can be charged directly.
// No card details ever enter this app — Paystack handles it all securely.
// ─────────────────────────────────────────────────────────────────────────────

const BRAND_ICONS = {
  visa:       { color: '#1a56db' },
  mastercard: { color: '#e74c3c' },
  amex:       { color: '#27ae60' },
};

export default function SavedCardsScreen() {
  const [cards,      setCards]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd,    setShowAdd]    = useState(false);

  const loadCards = useCallback(async () => {
    try {
      const data = await api.payments.getSavedCards();
      setCards(data.cards || []);
    } catch (e) {
      // H-8 FIX: session expiry is now handled centrally (see services/api.js
      // setSessionExpiredHandler) - showing the raw internal string here is
      // redundant and confusing on top of the redirect that already fires.
      if (e.message === 'SESSION_EXPIRED') return;
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadCards(); }, [loadCards]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadCards();
    setRefreshing(false);
  };

  const handleRemove = (cardId, last4) => {
    Alert.alert('Remove Card', `Remove card ending in ${last4}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          try {
            await api.payments.removeCard(cardId);
            setCards(prev => prev.filter(c => c.id !== cardId));
          } catch (e) { if (e.message !== 'SESSION_EXPIRED') Alert.alert('Error', e.message); }
        },
      },
    ]);
  };

  const handleSetDefault = async (cardId) => {
    try {
      await api.payments.setDefaultCard(cardId);
      setCards(prev => prev.map(c => ({ ...c, is_default: c.id === cardId })));
    } catch (e) { if (e.message !== 'SESSION_EXPIRED') Alert.alert('Error', e.message); }
  };

  if (loading) return <View style={s.center}><ActivityIndicator size="large" color="#0a0a0a" /></View>;

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={s.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {cards.length === 0 && !showAdd && (
        <View style={s.empty}>
          <Ionicons name="card-outline" size={44} color="#d1d5db" />
          <Text style={s.emptyTitle}>No saved cards</Text>
          <Text style={s.emptySub}>Add a card for faster checkout</Text>
        </View>
      )}

      {/* Card list */}
      {cards.map(card => {
        const brandColor = (BRAND_ICONS[card.brand?.toLowerCase()] || {}).color || '#9ca3af';
        return (
          <View key={card.id} style={[s.cardRow, card.is_default && s.cardRowDefault]}>
            <View style={[s.brandDot, { backgroundColor: brandColor }]} />
            <View style={{ flex: 1 }}>
              <Text style={s.cardNum}>{card.brand?.toUpperCase() || 'CARD'}  ••••  {card.last4}</Text>
              {card.nickname && <Text style={s.cardNick}>{card.nickname}</Text>}
              <Text style={s.cardExp}>Expires {card.exp_month}/{card.exp_year}</Text>
            </View>
            <View style={s.cardActions}>
              {card.is_default
                ? <View style={s.defaultBadge}><Text style={s.defaultText}>Default</Text></View>
                : <TouchableOpacity style={s.setBtn} onPress={() => handleSetDefault(card.id)}>
                    <Text style={s.setBtnText}>Set Default</Text>
                  </TouchableOpacity>
              }
              <TouchableOpacity onPress={() => handleRemove(card.id, card.last4)} style={s.removeBtn}>
                <Ionicons name="trash-outline" size={18} color="#ef4444" />
              </TouchableOpacity>
            </View>
          </View>
        );
      })}

      {/* How Paystack card saving works */}
      {showAdd ? (
        <View style={s.addBox}>
          <Text style={s.addBoxTitle}>How cards are saved</Text>
          <View style={s.paymentNotice}>
            <Ionicons name="information-circle-outline" size={20} color="#3b82f6" />
            <Text style={s.paymentNoticeText}>
              Cards are saved automatically after your first Paystack payment.{'\n\n'}
              To enable: Complete a card payment through the app and your card will appear here automatically for faster checkout next time.
            </Text>
          </View>
          <TouchableOpacity style={s.cancelBtn} onPress={() => setShowAdd(false)}>
            <Text style={s.cancelBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={s.addBtn} onPress={() => setShowAdd(true)}>
          <Ionicons name="add-circle-outline" size={20} color="#fff" />
          <Text style={s.addBtnText}>Add New Card</Text>
        </TouchableOpacity>
      )}

      <View style={s.secureNote}>
        <Ionicons name="lock-closed-outline" size={13} color="#9ca3af" />
        <Text style={s.secureText}>
          Cards are stored securely via Paystack. Flash never stores your card number, expiry, or CVV.
        </Text>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#f9fafb' },
  content:      { padding: 16, paddingBottom: 40, gap: 12 },
  center:       { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty:        { alignItems: 'center', paddingVertical: 48, gap: 8 },
  emptyTitle:   { fontSize: 16, fontWeight: '600', color: '#374151' },
  emptySub:     { fontSize: 13, color: '#9ca3af' },
  cardRow:      { backgroundColor: '#fff', borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 6, elevation: 2 },
  cardRowDefault: { borderWidth: 1.5, borderColor: '#0a0a0a' },
  brandDot:     { width: 12, height: 12, borderRadius: 6 },
  cardNum:      { fontSize: 15, fontWeight: '700', color: '#111827' },
  cardNick:     { fontSize: 12, color: '#9ca3af', marginTop: 2 },
  cardExp:      { fontSize: 12, color: '#9ca3af', marginTop: 2 },
  cardActions:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
  defaultBadge: { backgroundColor: '#111827', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  defaultText:  { color: '#fff', fontSize: 11, fontWeight: '700' },
  setBtn:       { borderColor: '#d1d5db', borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  setBtnText:   { color: '#374151', fontSize: 11, fontWeight: '600' },
  removeBtn:    { padding: 4 },
  addBox:       { backgroundColor: '#fff', borderRadius: 16, padding: 20, gap: 14 },
  addBoxTitle:  { fontSize: 16, fontWeight: '700', color: '#111827' },
  paymentNotice: { flexDirection: 'row', gap: 10, backgroundColor: '#eff6ff', borderRadius: 12, padding: 14 },
  paymentNoticeText: { flex: 1, color: '#1e40af', fontSize: 13, lineHeight: 20 },
  code:         { fontFamily: 'monospace', backgroundColor: '#dbeafe', color: '#1d4ed8' },
  cancelBtn:    { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 14, alignItems: 'center' },
  cancelBtnText:{ color: '#374151', fontWeight: '600' },
  addBtn:       { backgroundColor: '#0a0a0a', borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  addBtnText:   { color: '#fff', fontWeight: '700', fontSize: 15 },
  secureNote:   { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#f3f4f6', borderRadius: 12, padding: 12 },
  secureText:   { flex: 1, fontSize: 11, color: '#9ca3af', lineHeight: 16 },
});
