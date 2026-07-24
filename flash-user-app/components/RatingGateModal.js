/**
 * flash-user-app/components/RatingGateModal.js
 *
 * Mandatory post-delivery rating — persistent, non-dismissible prompt
 * (founder's explicit choice, not a hard navigation block): reappears
 * every time the app opens/foregrounds while an unrated completed order
 * exists, but "Not now" always lets the rest of the app (SOS, support,
 * everything) stay reachable underneath it — it just comes back next time.
 *
 * Chains into a separate, genuinely optional "rate Flash itself" step
 * after the driver rating is submitted, shown once ever (tracked in
 * AsyncStorage, not gated the same way).
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, TextInput, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../services/api';

const APP_RATING_SEEN_KEY = 'FLASH_APP_RATING_PROMPTED';

function Stars({ value, onChange, size = 36 }) {
  return (
    <View style={s.starRow}>
      {[1, 2, 3, 4, 5].map(n => (
        <Pressable key={n} onPress={() => onChange(n)} hitSlop={8}>
          <Ionicons name={n <= value ? 'star' : 'star-outline'} size={size} color="#f59e0b" />
        </Pressable>
      ))}
    </View>
  );
}

export default function RatingGateModal({ visible, order, onDismiss, onRated }) {
  const [step, setStep] = useState('driver'); // 'driver' | 'app'
  const [driverRating, setDriverRating] = useState(0);
  const [appRating, setAppRating]       = useState(0);
  const [comment, setComment]           = useState('');
  const [submitting, setSubmitting]     = useState(false);

  const reset = () => {
    setStep('driver');
    setDriverRating(0);
    setAppRating(0);
    setComment('');
  };

  const handleNotNow = () => {
    reset();
    onDismiss();
  };

  const handleSubmitDriver = async () => {
    if (!driverRating) return;
    setSubmitting(true);
    try {
      await api.orders.rateDriver(order.id, driverRating, comment.trim() || undefined);
      onRated(order.id);
      const alreadyAskedAppRating = await AsyncStorage.getItem(APP_RATING_SEEN_KEY);
      if (alreadyAskedAppRating) {
        reset();
        onDismiss();
      } else {
        setStep('app');
      }
    } catch (_e) {
      // Best-effort — leave the modal open so they can retry rather than
      // silently losing the rating they just picked.
    } finally {
      setSubmitting(false);
    }
  };

  const finishAppRating = async (skip) => {
    if (!skip && appRating) {
      try {
        await api.user.rateApp(appRating);
      } catch (_e) {}
    }
    await AsyncStorage.setItem(APP_RATING_SEEN_KEY, 'true').catch(() => {});
    reset();
    onDismiss();
  };

  if (!visible || !order) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={handleNotNow}>
      <View style={s.backdrop}>
        <View style={s.card}>
          {step === 'driver' ? (
            <>
              <Text style={s.title}>How was your delivery?</Text>
              <Text style={s.sub}>Order {order.order_number || `#${order.id?.slice(0, 8)}`}</Text>
              <Stars value={driverRating} onChange={setDriverRating} />
              <TextInput
                style={s.comment}
                placeholder="Anything you want to add? (optional)"
                placeholderTextColor="#6b7280"
                value={comment}
                onChangeText={setComment}
                multiline
              />
              <Pressable
                style={[s.submitBtn, !driverRating && s.submitBtnDisabled]}
                onPress={handleSubmitDriver}
                disabled={!driverRating || submitting}
              >
                {submitting
                  ? <ActivityIndicator color="#0a0a0a" />
                  : <Text style={s.submitBtnText}>Submit Rating</Text>
                }
              </Pressable>
              <Pressable onPress={handleNotNow} hitSlop={8}>
                <Text style={s.notNow}>Not now</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={s.title}>One more thing</Text>
              <Text style={s.sub}>How's Flash working for you so far?</Text>
              <Stars value={appRating} onChange={setAppRating} />
              <Pressable
                style={[s.submitBtn, !appRating && s.submitBtnDisabled]}
                onPress={() => finishAppRating(false)}
                disabled={!appRating}
              >
                <Text style={s.submitBtnText}>Submit</Text>
              </Pressable>
              <Pressable onPress={() => finishAppRating(true)} hitSlop={8}>
                <Text style={s.notNow}>Skip</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card:       { width: '100%', backgroundColor: '#fff', borderRadius: 20, padding: 24, gap: 14, alignItems: 'center' },
  title:      { fontSize: 18, fontWeight: '800', color: '#111827', textAlign: 'center' },
  sub:        { fontSize: 13, color: '#6b7280', textAlign: 'center', marginTop: -8 },
  starRow:    { flexDirection: 'row', gap: 8, marginVertical: 4 },
  comment:    { width: '100%', minHeight: 60, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 12, fontSize: 14, color: '#111827', textAlignVertical: 'top' },
  submitBtn:  { width: '100%', backgroundColor: '#f59e0b', borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  submitBtnDisabled: { opacity: 0.5 },
  submitBtnText: { color: '#0a0a0a', fontWeight: '800', fontSize: 15 },
  notNow:     { color: '#9ca3af', fontSize: 13, fontWeight: '500', marginTop: 2 },
});
